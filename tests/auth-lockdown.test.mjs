import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("public registration is disabled while local administrator login remains available", async () => {
  const [gate, route, utility] = await Promise.all([
    readFile(new URL("../app/auth-gate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/register/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../tools/manage-admin.mjs", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(gate, /api\/auth\/register|Create account|confirmPassword/);
  assert.match(gate, /api\/auth\/login/);
  assert.match(route, /status: 403/);
  assert.match(route, /Public account creation is disabled/);
  assert.doesNotMatch(route, /createAccount|sessionCookie/);
  assert.match(utility, /SESHAT_ADMIN_PASSWORD/);
  assert.match(utility, /SESHAT_ADMIN_USERNAME/);
  assert.match(utility, /scryptSync/);
  assert.match(utility, /rename\(temporaryPath, accountPath\)/);
  assert.doesNotMatch(utility, /TEMP_PASSWORD=/);
});

test("marks login cookies secure when HTTPS terminates at the trusted local proxy", async () => {
  const { sessionCookie, expiredSessionCookie } = await import("../app/local-auth.ts");
  const request = new Request("http://127.0.0.1:3000/api/auth/login", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.match(sessionCookie("signed-token", request), /; Secure/);
  assert.match(expiredSessionCookie(request), /; Secure/);
});

test("administrator utility can rename the existing account without printing its password", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "seshat-admin-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const utility = fileURLToPath(new URL("../tools/manage-admin.mjs", import.meta.url));

  await execFileAsync(process.execPath, [utility], {
    cwd: directory,
    env: { ...process.env, SESHAT_ADMIN_PASSWORD: "Admin123" },
  });
  const { stdout } = await execFileAsync(process.execPath, [utility], {
    cwd: directory,
    env: {
      ...process.env,
      SESHAT_ADMIN_USERNAME: "user",
      SESHAT_PREVIOUS_ADMIN_USERNAME: "admin",
      SESHAT_ADMIN_PASSWORD: "User1234",
    },
  });

  const store = JSON.parse(await readFile(path.join(directory, "data", "accounts.json"), "utf8"));
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].username, "user");
  assert.equal(store.accounts[0].active, true);
  assert.match(stdout, /ADMIN_USERNAME=user/);
  assert.doesNotMatch(stdout, /User1234/);
});
