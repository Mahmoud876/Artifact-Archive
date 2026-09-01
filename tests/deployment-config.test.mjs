import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the production app private behind automatic HTTPS without committed keys", async () => {
  const [service, caddy, environment, settings] = await Promise.all([
    readFile(new URL("../deploy/seshat.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8"),
    readFile(new URL("../deploy/seshat.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/views/settings-view.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(service, /--hostname 127\.0\.0\.1 --port 3000/);
  assert.match(service, /EnvironmentFile=\/etc\/seshat\/seshat\.env/);
  assert.match(caddy, /artifact-extractor\.duckdns\.org/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(caddy, /Strict-Transport-Security/);
  assert.doesNotMatch(environment, /AIza[0-9A-Za-z_-]{20,}|sk-or-v1-[0-9A-Za-z]{20,}|AQ\.[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(settings, /Gemini|OpenRouter|Region detector|Cloud analysis model/);
});
