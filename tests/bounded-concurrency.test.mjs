import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency } from "../app/bounded-concurrency.ts";

test("Gemini source work runs concurrently but keeps source order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([40, 5, 20, 1], 3, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `source-${index}`;
  });

  assert.equal(peak, 3);
  assert.deepEqual(results, ["source-0", "source-1", "source-2", "source-3"]);
});

test("Gemini source concurrency is never allowed below one worker", async () => {
  assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (value) => value * 2), [2, 4]);
});
