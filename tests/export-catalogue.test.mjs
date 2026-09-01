import assert from "node:assert/strict";
import test from "node:test";

import { buildSeriesCsv, buildSeriesManifest, platePath } from "../app/export.ts";
import { archiveCandidates, resolveSourceIndex } from "../app/crops.ts";

const CRLF = String.fromCharCode(13, 10);
const BOM = String.fromCharCode(0xFEFF);

const item = (overrides = {}) => ({
  id: "SES-1-001", order: 1, serial: "CA-17-0001", title: "Limestone stela",
  category: "Photograph", description: "", confidence: 0.82, bbox: [1, 2, 3, 4],
  source_name: "page.jpg", file: "001-photograph.png", ...overrides,
});

const run = (overrides = {}) => ({
  id: "SES-1", createdAt: "2026-08-20T10:00:00.000Z", label: "Page 12", series: "Register one",
  crops: [], manifest: {
    id: "SES-1", series: "Register one", inventory_id: "inv-1", task: "catalogue",
    model: "gemini-3.5-flash-lite", items: [item()], ...overrides,
  },
});

test("names every plate by its serial so folder and catalogue line up", () => {
  assert.equal(platePath("CA-17-0004", "SES-1-004", "004-stela.png"), "CA-17-0004-004-stela.png");
  // A run sealed before serials existed still exports under a stable name.
  assert.equal(platePath(undefined, "SES-1-004", "004-stela.png"), "SES-1-004-004-stela.png");
  assert.equal(platePath("CA-17-0004", "SES-1-004", null), null, "an artefact with no plate exports none");
  assert.equal(platePath("CA-17-0004", "SES-1-004", "CA-17-0004-004-stela.png"), "CA-17-0004-004-stela.png", "an already serialized filename is never prefixed twice");
});

test("series manifest carries every artefact with its page provenance", () => {
  const manifest = buildSeriesManifest([run()], "Register one", "2026-08-27T00:00:00.000Z");

  assert.equal(manifest.schema, "seshat.series.v1");
  assert.equal(manifest.page_count, 1);
  assert.equal(manifest.artifact_count, 1);
  assert.deepEqual(manifest.pages[0], {
    id: "SES-1", inventory_id: "inv-1", inventory_ids: ["inv-1"], label: "Page 12",
    created_at: "2026-08-20T10:00:00.000Z", task: "catalogue", model: "gemini-3.5-flash-lite",
  });
  assert.equal(manifest.artifacts[0].serial, "CA-17-0001");
  assert.equal(manifest.artifacts[0].plate, "CA-17-0001-001-photograph.png");
  assert.equal(manifest.artifacts[0].run_id, "SES-1", "an artefact always names the page it came from");
});

test("catalogue CSV survives Excel and Arabic", () => {
  const csv = buildSeriesCsv([run()], "Register one");

  assert.ok(csv.startsWith(BOM), "a BOM keeps Excel from rendering Arabic as mojibake");
  assert.ok(csv.includes(CRLF), "Excel expects CRLF row endings");
  const [header, first] = csv.slice(1).split(CRLF);
  assert.equal(header, "serial,title,category,confidence,page,run id,plate");
  assert.equal(first, "CA-17-0001,Limestone stela,Photograph,82,Page 12,SES-1,CA-17-0001-001-photograph.png");
});

test("CSV quotes any cell that would otherwise break the column count", () => {
  const risky = run({ items: [item({ title: 'Stela, broken', category: 'marked "uncertain"', confidence: null })] });
  const row = buildSeriesCsv([risky], "Register one").slice(1).split(CRLF)[1];

  assert.ok(row.includes('"Stela, broken"'), "a comma inside a title must not become a new column");
  assert.ok(row.includes('"marked ""uncertain"""'), "embedded quotes are doubled, not dropped");
  assert.ok(row.includes(",,"), "an unscored artefact exports an empty confidence, never a zero");
});

test("an unfiled artefact is still exported rather than silently dropped", () => {
  // seriesArtifacts(runs, null) means "every series"; a page with no series set
  // must still reach the catalogue.
  const manifest = buildSeriesManifest([run()], null, "2026-08-27T00:00:00.000Z");
  assert.equal(manifest.artifact_count, 1);
});

test("resolves whichever base a model counted its source images from", () => {
  // One image: whatever the model claimed, there is only one answer.
  assert.equal(resolveSourceIndex(7, 1), 0);
  assert.equal(resolveSourceIndex(null, 1), 0);

  // Several images: accept zero-based, then one-based, then give up.
  assert.equal(resolveSourceIndex(0, 3), 0);
  assert.equal(resolveSourceIndex(2, 3), 2);
  assert.equal(resolveSourceIndex(3, 3), 2, "a one-based index maps back into range");
  assert.equal(resolveSourceIndex(9, 3), null, "an impossible index is refused, not clamped");
  assert.equal(resolveSourceIndex(null, 3), null);
});

test("extraction keeps every accepted Gemini result even when legacy settings say max 40", () => {
  const items = Array.from({ length: 51 }, (_, index) => ({
    title: `item ${index + 1}`,
    category: "artifact",
    description: "",
    confidence: 0.95,
    bbox: [0, 0, 10, 10],
    source_index: 0,
  }));
  const result = { items };
  const options = { minConfidence: 0, maxItems: 40 };
  assert.equal(archiveCandidates(result, options, "extract").length, 51);
});
