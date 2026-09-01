// Starts the complete local Seshat stack from one terminal:
// the Grounding DINO detector and the web application.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
const managed = new Set();

for (const name of [".env.openrouter.local", ".env.local", ".env"]) {
  const file = join(root, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (value && !env[key]) env[key] = value;
  }
  console.log(`[config] loaded ${name}`);
}

async function reachable(url, timeout = 1_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return response.ok;
  } catch {
    return false;
  }
}

async function responseStatus(url, timeout = 2_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return response.status;
  } catch {
    return null;
  }
}

async function isSeshatServer(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/system`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return false;
    const payload = await response.json();
    return Boolean(payload?.defaults && payload?.analysis);
  } catch {
    return false;
  }
}

function listeningPid(port) {
  if (process.platform === "win32") {
    const output = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout || "";
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+\S+:([0-9]+)\s+\S+\s+LISTENING\s+([0-9]+)\s*$/i);
      if (match && Number(match[1]) === port) return Number(match[2]);
    }
    return null;
  }
  const output = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "";
  const pid = Number(output.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function waitForPortRelease(port, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!listeningPid(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitFor(label, url, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await reachable(url, 2_000)) {
      console.log(`[ready] ${label}`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  console.warn(`[warning] ${label} did not become ready at ${url}`);
  return false;
}

function startManaged(label, command, args, cwd) {
  console.log(`[start] ${label}`);
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  managed.add(child);
  child.on("error", (error) => {
    console.warn(`[warning] could not start ${label}: ${error.message}`);
    managed.delete(child);
  });
  child.on("exit", (code) => {
    managed.delete(child);
    if (code && !shuttingDown) console.warn(`[warning] ${label} exited with code ${code}`);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[stop] shutting down Seshat services");
  for (const child of managed) child.kill();
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const detectorUrl = `${(env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "")}/health`;
const webUrl = env.SESHAT_WEB_URL || "http://127.0.0.1:3000";
const detectorPython = process.platform === "win32"
  ? join(root, "vision-service", ".venv", "Scripts", "python.exe")
  : join(root, "vision-service", ".venv", "bin", "python");

const currentWebStatus = await responseStatus(webUrl);
if (currentWebStatus !== null && currentWebStatus >= 200 && currentWebStatus < 400 && await isSeshatServer(webUrl)) {
  console.log(`[ready] Seshat is already running at ${webUrl}`);
  process.exit(0);
}

const occupiedWebPid = listeningPid(3000);
if (occupiedWebPid) {
  if (!(await isSeshatServer(webUrl))) {
    console.error(`[error] port 3000 is owned by process ${occupiedWebPid}, and it is not a recognizable Seshat server.`);
    console.error("Close that program or set SESHAT_WEB_URL and the web server port before starting Seshat.");
    process.exit(1);
  }
  console.warn(`[repair] replacing stale Seshat web process ${occupiedWebPid} (HTTP ${currentWebStatus ?? "unreachable"})`);
  try {
    process.kill(occupiedWebPid);
  } catch (error) {
    console.error(`[error] could not stop stale Seshat process ${occupiedWebPid}: ${error.message}`);
    process.exit(1);
  }
  if (!(await waitForPortRelease(3000))) {
    console.error("[error] stale Seshat did not release port 3000.");
    process.exit(1);
  }
  // Its original launcher may stop sibling services after the web child exits.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const readiness = [];
if (await reachable(detectorUrl)) {
  console.log("[ready] local image detector already running");
} else if (existsSync(detectorPython)) {
  startManaged(
    "local image detector",
    detectorPython,
    ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8788"],
    join(root, "vision-service"),
  );
  readiness.push(waitFor("local image detector", detectorUrl));
} else {
  console.error("[error] detector environment is missing. Run: cd vision-service; uv sync");
  process.exit(1);
}

await Promise.all(readiness);
console.log("[config] extraction-only mode · no handwriting or table model started");
console.log("[open] http://localhost:3000");

const vinextCli = join(root, "node_modules", "vinext", "dist", "cli.js");
const web = startManaged("Seshat web app", process.execPath, [vinextCli, "start"], root);
web.on("exit", (code) => shutdown(code ?? 0));
