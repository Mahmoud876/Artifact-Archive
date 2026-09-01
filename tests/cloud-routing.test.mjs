import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  creditAwareOpenRouterLimit,
  DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS,
} from "../app/cloud-models.ts";

test("keeps provider routing server-controlled while retaining a locked fallback", async () => {
  const [page, settings, route, system, models, startup, env] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/system/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/cloud-models.ts", import.meta.url), "utf8"),
    readFile(new URL("../tools/start-local.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(settings, /Cloud analysis model|TEMPORARY TEST CONTROL|Gemini|OpenRouter/);
  assert.match(page, /form\.set\("provider", "auto"\)/);
  assert.doesNotMatch(page, /selectedModel|onModelChange|const \[model, setModel\]/);

  assert.match(route, /async function askOpenRouter/);
  assert.ok(route.includes('image_url: { url: `data:${mimes[index] || "image/jpeg"};base64,${data}` }'));
  const openRouterRequest = route.slice(
    route.indexOf("async function askOpenRouter"),
    route.indexOf("async function askCloud"),
  );
  assert.doesNotMatch(openRouterRequest, /temperature:/);
  assert.match(openRouterRequest, /max_completion_tokens: outputTokenBudget/);
  assert.match(openRouterRequest, /response_format: { type: "json_object" }/);
  assert.match(route, /async function askCloud/);
  assert.match(route, /return askOpenRouter\(openRouterModel, openRouterKey/);
  assert.match(route, /if \(mode === "gemini"\)/);
  const explicitGeminiBranch = route.slice(
    route.indexOf('if (mode === "gemini")'),
    route.indexOf('let geminiError = ""'),
  );
  assert.doesNotMatch(explicitGeminiBranch, /askOpenRouter/);
  assert.match(route, /OpenRouter fallback also failed/);
  assert.match(route, /GEMINI_FALLBACK_MODEL \|\| "gemini-3\.6-flash"/);
  assert.match(route, /GEMINI_MODEL_COOLDOWN_MS = 5 \* 60_000/);
  assert.match(route, /GEMINI_REQUEST_TIMEOUT_MS\) \|\| 60_000/);
  assert.match(route, /requestedModel === "gemini-3\.5-flash"/);
  assert.match(route, /mapWithConcurrency\(images, concurrency, analyzeSource\)/);
  assert.match(system, /analysis: \{ configured: Boolean/);
  assert.doesNotMatch(system, /readGemini|openrouter:/);
  assert.match(route, /allow_fallbacks: false/);
  assert.doesNotMatch(route, /allow_fallbacks: true/);
  assert.match(route, /openrouter_fallback:/);

  assert.match(models, /openai\/gpt-5\.6-luna/);
  assert.match(startup, /"\.env\.openrouter\.local", "\.env\.local", "\.env"/);
  assert.match(env, /OPENROUTER_MAX_OUTPUT_TOKENS=8000/);
});

test("reduces unaffordable OpenRouter reservations without overreacting", () => {
  assert.equal(DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS, 8_000);
  assert.equal(
    creditAwareOpenRouterLimit("You requested up to 32000 tokens, but can only afford 30284.", 32_000),
    27_255,
  );
  assert.equal(creditAwareOpenRouterLimit("can only afford 1200", 8_000), 1_080);
  assert.equal(creditAwareOpenRouterLimit("can only afford 30284", 8_000), null);
  assert.equal(creditAwareOpenRouterLimit("unrelated error", 8_000), null);
});

test("keeps cloud crop geometry under cloud vision and local geometry local-only", async () => {
  const route = await readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8");

  assert.match(
    route,
    /const located = provider === "local" && imageFiles\.length && \(task === "extract" \|\| task === "catalogue"\)/,
  );
  assert.match(
    route,
    /if \(task === "extract" && images\.length > 1\)/,
  );
  assert.match(
    route,
    /CLOUD VISUAL DETECTION/,
  );
  assert.match(
    route,
    /Exclude handwriting, handwritten cells, printed text, table rules, physical number labels, page stamps, circular seals inked directly on the register/,
  );
  assert.match(
    route,
    /cloudRun && task === "extract" && !located\.detections\.length/,
  );
});
