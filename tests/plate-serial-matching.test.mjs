import assert from "node:assert/strict";
import test from "node:test";

import { matchPlateAssignments, normalizeWrittenSerial } from "../app/types.ts";

const plate = (file, serial, y) => ({
  file,
  plate_serial: serial,
  bbox: [1200, y, 1450, y + 100],
});

test("normalizes Arabic and Persian digits without losing the written prefix", () => {
  assert.equal(normalizeWrittenSerial(" عق ٢٤ / ١ "), "عق24/1");
  assert.equal(normalizeWrittenSerial("عق ۲۴"), "عق24");
});

test("matches a photographed label to the handwritten row before using page position", () => {
  const rows = [["عق ٢٤ / ١"], ["عق ٢٥ / ١"]];
  // The visual order is deliberately reversed to prove position is not used.
  const matches = matchPlateAssignments([
    plate("plate-25.png", "٢٥", 100),
    plate("plate-24.png", "٢٤", 900),
  ], rows);

  assert.equal(matches["0"].file, "plate-24.png");
  assert.equal(matches["0"].method, "label-number");
  assert.equal(matches["1"].file, "plate-25.png");
  assert.equal(matches["1"].method, "label-number");
});

test("does not claim a serial match when the same written number is ambiguous", () => {
  const rows = [["٢٤ / ١"], ["٢٤ / ٢"]];
  const matches = matchPlateAssignments([plate("ambiguous.png", "٢٤", 200)], rows);
  assert.deepEqual(matches, {});
});

test("does not silently position-link an unreadable plate when register rows exist", () => {
  const matches = matchPlateAssignments([
    plate("top.png", null, 100),
    plate("bottom.png", "[؟]", 900),
  ], [["١"], ["٢"], ["٣"]]);
  assert.deepEqual(matches, {});
});

test("retains legacy positional ordering only when no row serials are available", () => {
  const matches = matchPlateAssignments([
    plate("top.png", null, 100),
    plate("bottom.png", "[؟]", 900),
  ], 3);
  assert.equal(matches["0"].file, "top.png");
  assert.equal(matches["0"].method, "position");
  assert.equal(matches["2"].file, "bottom.png");
  assert.equal(matches["2"].method, "position");
});

test("a unique written serial wins even when a tall photograph crosses other rows", () => {
  const table = {
    columns: ["مسلسل"],
    rows: [["١"], ["٢"], ["٣"]],
    row_bounds: [100, 200, 300, 400],
    source_height: 500,
  };
  const matches = matchPlateAssignments([plate("wrong.png", "٣", 105)], table);
  assert.equal(matches['2'].file, 'wrong.png');
  assert.equal(matches['2'].method, 'label-exact');
});

test('uses detected label geometry to disambiguate a repeated serial', () => {
  const table = {
    columns: ['serial'],
    rows: [['24 / 1'], ['24 / 2']],
    row_bounds: [100, 200, 300],
    source_height: 400,
  };
  const item = { ...plate('second.png', '24', 100), plate_label_bbox: [1300, 225, 1340, 245] };
  const matches = matchPlateAssignments([item], table);
  assert.equal(matches['1'].file, 'second.png');
});

test('falls back to a detected tag row when its tiny serial is unreadable', () => {
  const table = {
    columns: ['serial'],
    rows: [['1'], ['2'], ['3']],
    row_bounds: [100, 200, 300, 400],
    source_height: 500,
  };
  const item = { ...plate('middle.png', null, 100), plate_label_bbox: [1300, 235, 1340, 250] };
  const matches = matchPlateAssignments([item], table);
  assert.equal(matches['1'].file, 'middle.png');
  assert.equal(matches['1'].method, 'position');
});
