import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bboxToNormalized, manualCropItem, normalizedToBbox,
} from "../app/crop-corrections.ts";

test("manual crop coordinates round-trip across supported coordinate spaces", () => {
  const asset = { width: 2000, height: 1000 };
  const pixelBox = [200, 100, 1000, 500];
  const normalized = bboxToNormalized(pixelBox, asset, "pixels");
  assert.deepEqual(normalized, [100, 100, 500, 500]);
  assert.deepEqual(normalizedToBbox(normalized, asset, "pixels"), pixelBox);

  const cloudBox = [80, 120, 920, 880];
  assert.deepEqual(bboxToNormalized(cloudBox, asset, "normalized_1000"), cloudBox);
  assert.deepEqual(normalizedToBbox(cloudBox, asset, "normalized_1000"), cloudBox);

  const localBox = [120, 75, 840, 660];
  const localNormalized = bboxToNormalized(localBox, asset, "ollama_pixels");
  const roundTrip = normalizedToBbox(localNormalized, asset, "ollama_pixels");
  assert.ok(roundTrip.every((value, index) => Math.abs(value - localBox[index]) <= 1));
});

test("a manually drawn crop is explicit, source-owned, and ready for a new serial", () => {
  const item = manualCropItem([10, 20, 300, 400], 2);
  assert.equal(item.source_index, 2);
  assert.deepEqual(item.bbox, [10, 20, 300, 400]);
  assert.equal(item.confidence, 1);
  assert.equal(item.id, undefined);
  assert.equal(item.serial, undefined);
});

test("corrected archived items are matched by permanent id instead of array position", async () => {
  const [crops, page, editor] = await Promise.all([
    readFile(new URL("../app/crops.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/manual-crop-editor.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(crops, /existing\?\.manifest\.items\.find\(\(candidate\) => candidate\.id === item\.id\)/);
  assert.match(crops, /serial: item\.serial \?\? previous\?\.serial/);
  assert.match(page, /cropCorrectionsDirty/);
  assert.match(page, /saveCropCorrections/);
  assert.match(page, /احفظ تصحيحات القصاصات قبل التصدير/);
  assert.match(editor, /رسم قصاصة مفقودة/);
  assert.match(editor, /حذف الإطار المحدد/);
  assert.match(editor, /handle \? "resize" : "move"/);
});
