import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ACCOUNTS_PATH = path.join(process.cwd(), "data", "accounts.json");
const SESSION_COOKIE = "seshat_session";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

type StoredAccount = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  active: boolean;
};

type AccountStore = {
  version: 1;
  sessionSecret: string;
  accounts: StoredAccount[];
};

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
};

type SessionPayload = SessionUser & { expiresAt: number };
let storeQueue: Promise<unknown> = Promise.resolve();

function queueStoreTask<T>(task: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(task, task);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function publicAccount(account: StoredAccount): SessionUser {
  return { id: account.id, username: account.username, displayName: account.displayName };
}

function normalizeUsername(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function validUsername(value: string): boolean {
  return value.length >= 3
    && value.length <= 64
    && /^[\p{L}\p{N}][\p{L}\p{N}._@-]*$/u.test(value);
}

async function writeStore(store: AccountStore): Promise<void> {
  await mkdir(path.dirname(ACCOUNTS_PATH), { recursive: true });
  await writeFile(ACCOUNTS_PATH, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readStore(): Promise<AccountStore> {
  try {
    const parsed = JSON.parse(await readFile(ACCOUNTS_PATH, "utf8")) as Partial<AccountStore>;
    if (!Array.isArray(parsed.accounts)) throw new Error("accounts must be an array");
    const sessionSecret = typeof parsed.sessionSecret === "string" && parsed.sessionSecret.length >= 32
      ? parsed.sessionSecret
      : randomBytes(32).toString("base64url");
    const store: AccountStore = {
      version: 1,
      sessionSecret,
      accounts: parsed.accounts as StoredAccount[],
    };
    if (parsed.sessionSecret !== sessionSecret) await writeStore(store);
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("The local account file is invalid. Check data/accounts.json.", { cause: error });
    }
    const store: AccountStore = {
      version: 1,
      sessionSecret: randomBytes(32).toString("base64url"),
      accounts: [],
    };
    await writeStore(store);
    return store;
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1 });
  return ["scrypt", "16384", "8", "1", salt, derived.toString("base64url")].join("$");
}

function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, n, r, p, salt, expectedText] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedText) return false;
  const expected = Buffer.from(expectedText, "base64url");
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function signPayload(payloadText: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadText).digest("base64url");
}

function makeSessionToken(user: SessionUser, secret: string): string {
  const payload: SessionPayload = {
    ...user,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS,
  };
  const payloadText = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return payloadText + "." + signPayload(payloadText, secret);
}

function readSessionToken(token: string, secret: string): SessionPayload | null {
  const [payloadText, signatureText] = token.split(".");
  if (!payloadText || !signatureText) return null;
  const expected = Buffer.from(signPayload(payloadText, secret), "base64url");
  const actual = Buffer.from(signatureText, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.id || !payload.username || !payload.displayName) return null;
    return payload.expiresAt > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export async function createAccount(input: {
  username: string;
  displayName?: string;
  password: string;
}): Promise<{ user: SessionUser; token: string }> {
  const username = normalizeUsername(input.username);
  const displayName = (input.displayName?.trim() || input.username.trim()).slice(0, 80);
  if (!validUsername(username)) {
    throw new Error("Username must be 3-64 characters and use letters, numbers, dots, dashes, underscores or @.");
  }
  if (input.password.length < 8 || input.password.length > 128) {
    throw new Error("Password must contain between 8 and 128 characters.");
  }
  return queueStoreTask(async () => {
    const store = await readStore();
    if (store.accounts.some((account) => account.username === username)) {
      throw new Error("An account with this username already exists.");
    }
    const account: StoredAccount = {
      id: randomUUID(),
      username,
      displayName,
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString(),
      active: true,
    };
    store.accounts.push(account);
    await writeStore(store);
    const user = publicAccount(account);
    return { user, token: makeSessionToken(user, store.sessionSecret) };
  });
}

export async function loginAccount(
  usernameInput: string,
  password: string,
): Promise<{ user: SessionUser; token: string } | null> {
  return queueStoreTask(async () => {
    const store = await readStore();
    const account = store.accounts.find((candidate) => candidate.username === normalizeUsername(usernameInput));
    if (!account?.active || !verifyPassword(password, account.passwordHash)) return null;
    const user = publicAccount(account);
    return { user, token: makeSessionToken(user, store.sessionSecret) };
  });
}

export async function authenticatedUser(request: Request): Promise<SessionUser | null> {
  return queueStoreTask(async () => {
    const store = await readStore();
    const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    const session = token ? readSessionToken(token, store.sessionSecret) : null;
    if (!session) return null;
    const account = store.accounts.find((candidate) => candidate.id === session.id && candidate.active);
    return account ? publicAccount(account) : null;
  });
}

export function sessionCookie(token: string, request: Request): string {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const secure = forwardedProtocol === "https" || new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return SESSION_COOKIE + "=" + encodeURIComponent(token)
    + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_LIFETIME_SECONDS + secure;
}

export function expiredSessionCookie(request: Request): string {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const secure = forwardedProtocol === "https" || new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secure;
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "Authentication required." }, { status: 401 });
}
