import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the authenticated Seshat shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>[^<]+<\/title>/i);
  assert.match(html, /class="auth-loading"/);
  assert.match(html, /Opening the archive/);
  assert.doesNotMatch(html, /id="source-file-input"/i);
  assert.doesNotMatch(html, /New chat|Message Seshat/i);
});

test("keeps extraction local and preserves original-pixel crops", async () => {
  const [page, intake, archiveDb, crops, route, detector, env] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/intake-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/archive-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/crops.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../vision-service/server.py", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(archiveDb, /indexedDB\.open\(DB_NAME/);
  assert.match(crops, /usesOriginalPixels \? 1/);
  assert.match(page, /saveArchiveRun/);
  assert.match(intake, /htmlFor="source-file-input"/);
  assert.match(page, /MAX_SOURCE_FILES = 12/);
  assert.match(page, /runAnalysis/);
  assert.match(route, /files\.length > 12/);
  assert.doesNotMatch(route, /files\.slice\(0, 12\)/);
  assert.match(archiveDb, /serializedNames/);
  assert.match(archiveDb, /file\.startsWith\(`\$\{item\.serial\}-`\)/);
  assert.match(page, /fileInputRef\.current\.click/);
  assert.match(page, /className="zoom-controls"/);
  assert.match(page, /setViewScale\("fit"\)/);
  assert.match(page, /focus-toggle/);
  assert.match(page, /preview-stage.*fit-view/);
  assert.match(page, /viewer-focus/);
  assert.match(page, /ResizeObserver/);
  assert.match(route, /VISION_BASE_URL/);
  assert.match(route, /coordinate_space: "pixels" as const/);
  assert.match(route, /Grounding DINO[\s\S]*OpenCV refinement/);
  assert.match(detector, /find_residual_regions/);
  assert.match(detector, /dark_content_ratio/);
  assert.match(env, /127\.0\.0\.1:8788/);
});

test("starts new runs with a validated local intake record", async () => {
  const [page, archiveDb, crops, intake, types] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/archive-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/crops.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/views/intake-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/types.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /startsNewIntake/);
  assert.match(page, /INTAKE_DEFAULTS_KEY/);
  assert.match(crops, /intake: existing\?\.manifest\.intake \?\? intake/);
  assert.match(archiveDb, /const DB_VERSION = 3/);
  assert.match(archiveDb, /database\.createObjectStore\(INVENTORY_STORE/);
  assert.match(archiveDb, /createIndex\(INVENTORY_STORAGE_INDEX, "storageKey", \{ unique: true \}\)/);
  assert.match(archiveDb, /transaction\(\[DB_STORE, INVENTORY_STORE\], "readwrite"\)/);
  assert.match(archiveDb, /export async function sealArchiveRun/);
  assert.match(archiveDb, /for \(const owner of sealedInventories\) inventoryStore\.put\(owner\);[\s\S]*runStore\.put\(sealedRun\)/);
  assert.match(crops, /storage_key: existing\?\.manifest\.storage_key \?\? storageIdentity\(intake\)/);
  assert.match(intake, /Prepare an extraction batch/);
  assert.match(intake, /Ordered source batch/);
  assert.match(intake, /onMoveAsset/);
  assert.match(intake, /One or more sources are small/);
  assert.match(intake, /aria-invalid/);
  assert.match(intake, /lang="ar" dir="rtl"/);
  assert.match(intake, /اسم المحافظة/);
  assert.match(intake, /اسم المنطقة الأثرية/);
  assert.match(intake, /رقم سجل المخزن/);
  assert.match(intake, /رقم صفحة السجل/);
  assert.match(types, /governorate: string/);
  assert.match(types, /storeRegisterNumber: string/);
  assert.match(intake, /Next artefact serial/);
  assert.match(intake, /Inventory ownership/);
  assert.match(intake, /Permanent storage identity/);
  assert.match(intake, /selectedInventoryId/);
  assert.match(intake, /intake-governorate-options/);
  assert.match(intake, /filteredInventories/);
  assert.match(intake, /Create another inventory in/);
  assert.match(intake, /Pick a governorate to show only the inventories stored there/);
  assert.match(page, /chooseGovernorate/);
  assert.match(page, /clearInventoryDetails/);
  assert.match(types, /function nextStorageSerialNumber/);
  assert.match(types, /function runBelongsToStorage/);
  assert.match(types, /function storageSerialPrefix/);
  assert.match(types, /makeStorageSerial/);
  assert.match(types, /inventory_id\?: string/);
  assert.match(types, /type InventoryRecord/);
  assert.match(types, /function migrateInventoryRecords/);
  assert.match(types, /intake\?: IntakeMetadata/);
});

test("keeps new work on the detector-only extraction path", async () => {
  const [route, page, intake, settings, archive, launcher] = await Promise.all([
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/intake-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/archive-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../tools/start-local.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(route, /const task = "extract"/);
  assert.match(route, /task === "extract"/);
  assert.match(intake, /Extract and serialize/);
  assert.match(page, /runAnalysis/);
  assert.doesNotMatch(page, /<ManualRegisterReview/);
  assert.doesNotMatch(page, /result\.table &&/);
  assert.match(intake, /Handwriting and table processing are intentionally disabled/);
  assert.doesNotMatch(intake, /intakeTasks/);
  assert.match(intake, /name="batch-relationship"/);
  assert.doesNotMatch(settings, /Cloud analysis model|Gemini|OpenRouter|TEMPORARY TEST CONTROL/);
  assert.doesNotMatch(settings, /Transcribe/);
  assert.match(archive, /showLegacyTextFeatures: boolean = false/);
  assert.doesNotMatch(launcher, /ollama", \["serve"\]/);
});

test("register consensus withholds disagreements but preserves review alternatives", async () => {
  const { buildRegisterConsensus } = await import("../app/api/analyze/route.ts");
  const blankRow = () => Array.from({ length: 12 }, () => "");
  const first = Array.from({ length: 10 }, blankRow);
  const review = Array.from({ length: 10 }, blankRow);
  first[0][0] = "٢١";
  review[0][0] = "٢٢";
  first[0][1] = "[؟]";
  review[0][1] = "مخزن أ";
  first[0][2] = "حجر جيري";
  review[0][2] = "حجر جيري";

  const result = buildRegisterConsensus(first, review, "flash-lite", "flash");
  assert.equal(result.table.rows[0][0], "[؟]", "a conflicting numeral is withheld");
  assert.equal(result.table.rows[0][1], "[؟]", "one model's fluent guess is not treated as evidence");
  assert.equal(result.table.rows[0][2], "حجر جيري", "exact agreement is preserved");
  assert.deepEqual(result.table.review_cells?.slice(0, 2), ["0:0", "0:1"]);
  assert.deepEqual(result.table.alternatives, [
    { row: 0, column: 0, first: "٢١", second: "٢٢" },
    { row: 0, column: 1, first: "[؟]", second: "مخزن أ" },
  ]);
  assert.equal(result.verifiedCells, 1);
  assert.equal(result.candidateCells, 3);
  assert.equal(result.accepted, false);
});

test("plate-label parsing preserves numeric JSON readings instead of discarding them", async () => {
  const { parsePlateSerials } = await import("../app/api/analyze/route.ts");
  assert.deepEqual(parsePlateSerials('{"serials":[21,"٢٢",null]}', 3), ["21", "٢٢", null]);
  assert.deepEqual(parsePlateSerials('{"serials":[{"serial":23},{"value":"٢٤/١"}]}', 2), ["23", "٢٤/١"]);
});

test("the stronger material reviewer becomes the editable draft without auto-verification", async () => {
  const { buildRegisterConsensus } = await import("../app/api/analyze/route.ts");
  const blankRow = () => Array.from({ length: 12 }, () => "");
  const first = Array.from({ length: 10 }, blankRow);
  const review = Array.from({ length: 10 }, blankRow);
  first[0][4] = "do. فوق";
  review[0][4] = "حجر رملي";

  const result = buildRegisterConsensus(first, review, "flash-lite", "flash", new Set([4]));
  assert.equal(result.table.rows[0][4], "[؟]", "a disagreement remains unverified");
  assert.deepEqual(result.table.alternatives?.[0], {
    row: 0,
    column: 4,
    first: "حجر رملي",
    second: "do.",
  });
});

test("column profiles normalize safe material variants and reject cross-column spill", async () => {
  const { normalizeRegisterColumnReading, isPlausibleRegisterColumnReading } = await import("../app/api/analyze/route.ts");
  assert.equal(normalizeRegisterColumnReading(4, "حجر رملى"), "حجر رملي");
  assert.equal(normalizeRegisterColumnReading(4, "فوق do."), "do.");
  assert.equal(isPlausibleRegisterColumnReading(4, "حجر جيري"), true);
  assert.equal(isPlausibleRegisterColumnReading(4, "قطعة من الحجر عليها كتابة وتفاصيل كثيرة من الوصف"), false);
  assert.equal(isPlausibleRegisterColumnReading(0, "عق ٢١/أ"), true);
  assert.equal(isPlausibleRegisterColumnReading(0, "صندوق المخزن"), false);
  assert.equal(isPlausibleRegisterColumnReading(5, "٣٥ × ٢٦"), true);
  assert.equal(isPlausibleRegisterColumnReading(5, "حجر رملي"), false);
});

test("rejected register previews preserve alternatives as untrusted review choices", async () => {
  const { buildDiagnosticReviewTable } = await import("../app/api/analyze/route.ts");
  const rows = Array.from({ length: 10 }, () => Array.from({ length: 12 }, () => "[؟]"));
  rows[0][2] = "حجر جيري";
  const diagnostic = buildDiagnosticReviewTable({
    columns: Array.from({ length: 12 }, (_, index) => `column ${index + 1}`),
    rows,
    review_cells: ["0:0"],
    alternatives: [{ row: 0, column: 0, first: "٢١", second: "٢٢" }],
  });

  assert.equal(diagnostic.proposedCells, 1);
  assert.equal(diagnostic.table.rows[0][0], "[؟]");
  assert.equal(diagnostic.table.rows[0][2], "حجر جيري");
  assert.ok(diagnostic.table.review_cells?.includes("0:2"), "even exact consensus remains marked for human review");
  assert.deepEqual(diagnostic.table.alternatives, [{ row: 0, column: 0, first: "٢١", second: "٢٢" }]);
  assert.doesNotMatch(JSON.stringify(diagnostic.table), /guessed|suggested/i);
});

test("register consensus tolerates minor Arabic presentation differences", async () => {
  const { buildRegisterConsensus } = await import("../app/api/analyze/route.ts");
  const blankRow = () => Array.from({ length: 12 }, () => "");
  const first = Array.from({ length: 10 }, blankRow);
  const review = Array.from({ length: 10 }, blankRow);
  first[0][1] = "الآثــار";
  review[0][1] = "الاثار";
  const result = buildRegisterConsensus(first, review, "flash-lite", "flash");
  assert.equal(result.table.rows[0][1], "الاثار");
  assert.equal(result.agreementRate, 1);
  assert.equal(result.accepted, true);
});

test("exposes physical-storage inventories above individual archive runs", async () => {
  const [page, inventories, types] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/inventories-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/types.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<InventoriesView/);
  assert.match(inventories, /Storage inventories/);
  assert.match(inventories, /Open inventory/);
  assert.match(inventories, /Artefact ledger/);
  assert.match(inventories, /onOpenRun/);
  assert.match(types, /function listInventories/);
  assert.match(types, /function inventoryArtifacts/);
});

test("preserves legacy text data but keeps this branch focused on images", async () => {
  const [crops, page, archive, inventories, types] = await Promise.all([
    readFile(new URL("../app/crops.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/archive-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/views/inventories-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/types.ts", import.meta.url), "utf8"),
  ]);

  assert.match(crops, /result\.table \?\? result\.review_table \?\? null/);
  assert.match(crops, /table_status: tableStatus/);
  assert.match(types, /table_status\?: "verified" \| "needs_review"/);
  assert.doesNotMatch(page, /<RegisterRecords|<ResultTable|<ManualRegisterReview/);
  assert.match(page, /save-confirm/);
  assert.match(page, /source_index === sourceIndex/);
  assert.match(archive, /<RegisterRecords/);
  assert.match(archive, /<ResultTable/);
  assert.match(archive, /showLegacyTextFeatures: boolean = false/);
  assert.match(inventories, /registerFieldsForPlate/);
  assert.match(inventories, /showLegacyRegisterFields: boolean = false/);
  assert.match(inventories, /extracted image/);
});
