import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { batchRelationshipLabel, batchRelationshipLabels } from "../app/types.ts";

test("provides an explicit relationship for every multi-image grouping", () => {
  assert.deepEqual(Object.keys(batchRelationshipLabels).sort(), [
    "mixed", "same_governorate", "same_register", "same_source",
  ]);
  assert.equal(batchRelationshipLabel("same_register"), "نفس الكتاب أو السجل");
  assert.equal(batchRelationshipLabel("same_governorate"), "نفس المحافظة فقط");
  assert.equal(batchRelationshipLabel(undefined), "غير مسجلة");
});

test("shows per-source inventory ownership for mixed and governorate-only batches", async () => {
  const intake = await readFile(new URL("../app/views/intake-view.tsx", import.meta.url), "utf8");
  assert.match(intake, /assets\.length > 1/);
  assert.match(intake, /name="batch-relationship"/);
  assert.match(intake, /assignsSourcesIndividually/);
  assert.match(intake, /Governorate for source/);
  assert.match(intake, /Inventory for source/);
  assert.match(intake, /Each extracted artefact will use that image’s inventory and serial sequence/);
});
