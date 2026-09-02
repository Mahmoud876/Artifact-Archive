import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const accountPath = path.join(process.cwd(), "data", "accounts.json");
const temporaryPath = `${accountPath}.tmp`;

function normalizeUsername(value) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function validUsername(value) {
  return value.length >= 3
    && value.length <= 64
    && /^[\p{L}\p{N}][\p{L}\p{N}._@-]*$/u.test(value);
}

const username = normalizeUsername(process.env.SESHAT_ADMIN_USERNAME || "admin");
const previousUsername = normalizeUsername(process.env.SESHAT_PREVIOUS_ADMIN_USERNAME || "admin");
const displayName = (process.env.SESHAT_ADMIN_DISPLAY_NAME?.trim() || "Seshat User").slice(0, 80);

function passwordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1 });
  return ["scrypt", "16384", "8", "1", salt, derived.toString("base64url")].join("$");
}

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(accountPath, "utf8"));
    if (!Array.isArray(parsed.accounts)) throw new Error("accounts must be an array");
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, sessionSecret: randomBytes(32).toString("base64url"), accounts: [] };
  }
}

const store = await readStore();
const password = process.env.SESHAT_ADMIN_PASSWORD || `${randomBytes(24).toString("base64url")}A7!`;
if (!validUsername(username)) {
  throw new Error("SESHAT_ADMIN_USERNAME must contain 3-64 letters, numbers, dots, dashes, underscores or @.");
}
if (password.length < 8 || password.length > 128) {
  throw new Error("SESHAT_ADMIN_PASSWORD must contain between 8 and 128 characters.");
}
const existing = store.accounts.find((account) => account.username === username)
  || store.accounts.find((account) => account.username === previousUsername);
if (existing) {
  existing.username = username;
  existing.displayName = displayName;
  existing.passwordHash = passwordHash(password);
  existing.active = true;
} else {
  store.accounts.push({
    id: randomUUID(),
    username,
    displayName,
    passwordHash: passwordHash(password),
    createdAt: new Date().toISOString(),
    active: true,
  });
}

await mkdir(path.dirname(accountPath), { recursive: true });
await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, accountPath);
console.log(`ADMIN_USERNAME=${username}`);
console.log("ADMIN_PASSWORD_UPDATED=true");
