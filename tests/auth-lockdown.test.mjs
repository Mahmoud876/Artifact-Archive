import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(utility, /scryptSync/);
  assert.match(utility, /rename\(temporaryPath, accountPath\)/);
});
