import assert from "node:assert/strict";
import test from "node:test";

import {
  makeStorageSerial,
  listInventories,
  migrateInventoryRecords,
  nextStorageSerial,
  nextStorageSerialNumber,
  repairStorageSerialContinuity,
  runBelongsToStorage,
  storageSerialPrefix,
  storageIdentity,
} from "../app/types.ts";
import { archiveSerialNumber, renumberArchiveRunData } from "../app/archive-db.ts";

const intake = (overrides = {}) => ({
  title: "Test register",
  governorate: "Cairo",
  archaeologicalArea: "Old Cairo",
  storehouseName: "Store A",
  storeRegisterName: "Main register",
  storeRegisterNumber: "CA-17",
  registerPageNumber: "1",
  storeRegisterType: "Archaeological",
  otherLanguage: "",
  institution: "",
  collection: "",
  language: "ar",
  documentType: "register",
  notes: "",
  ...overrides,
});

function archivedRun(source, serials, series = "Register one") {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    label: "Archived page",
    series,
    crops: [],
    manifest: {
      storage_key: storageIdentity(source),
      intake: source,
      items: serials.map((serial) => ({ serial })),
    },
  };
}

test("continues serials for the same storage across runs and series", () => {
  const source = intake();
  const runs = [
    archivedRun(source, ["CA-17-0001", "CA-17-0002"], "Register one"),
    archivedRun(source, ["CA-17-0003", "CA-17-0007"], "Another series"),
  ];

  assert.equal(nextStorageSerialNumber(runs, source), 8);
  assert.equal(makeStorageSerial(source, 8), "CA-17-0008");
});

test("groups every saved page into an accessible storage inventory", () => {
  const cairo = intake();
  const luxor = intake({ governorate: "Luxor", storehouseName: "West Bank Store", storeRegisterNumber: "LX-4" });
  const first = archivedRun(cairo, ["CA-17-0001", "CA-17-0002"]);
  first.createdAt = "2026-08-20T10:00:00.000Z";
  const second = archivedRun({ ...cairo, archaeologicalArea: "Alternate area wording" }, ["CA-17-0003"]);
  second.createdAt = "2026-08-21T10:00:00.000Z";
  const third = archivedRun(luxor, ["LX-4-0001"]);

  const inventories = listInventories([first, second, third]);
  assert.equal(inventories.length, 2);
  const cairoInventory = inventories.find((entry) => entry.name === "Store A");
  assert.equal(cairoInventory.runs.length, 2);
  assert.equal(cairoInventory.artifactCount, 3);
  assert.equal(cairoInventory.firstSerial, "CA-17-0001");
  assert.equal(cairoInventory.lastSerial, "CA-17-0003");
});

test("migrates legacy pages to one permanent inventory without renumbering them", () => {
  const source = intake();
  const first = archivedRun(source, ["CA-17-0001", "CA-17-0002"]);
  const second = archivedRun({ ...source, archaeologicalArea: "Changed wording" }, ["CA-17-0003"]);
  let idCalls = 0;
  const migrated = migrateInventoryRecords([first, second], [], () => `inventory-${++idCalls}`, "2026-08-25T12:00:00.000Z");

  assert.equal(migrated.inventories.length, 1);
  assert.equal(migrated.inventories[0].id, "inventory-1");
  assert.equal(migrated.inventories[0].nextSerial, 4);
  assert.equal(migrated.assigned, 2);
  assert.deepEqual(migrated.runs.map((run) => run.manifest.inventory_id), ["inventory-1", "inventory-1"]);
  assert.deepEqual(migrated.runs.flatMap((run) => run.manifest.items.map((item) => item.serial)), ["CA-17-0001", "CA-17-0002", "CA-17-0003"]);
});

test("keeps inventory ownership stable when descriptive storage text changes", () => {
  const source = intake();
  const record = {
    id: "permanent-inventory-id",
    storageKey: storageIdentity(source),
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    serialPrefix: "CA-17",
    nextSerial: 8,
    intake: source,
  };
  const renamed = archivedRun({ ...source, storehouseName: "Renamed display label" }, ["CA-17-0008"]);
  renamed.manifest.inventory_id = record.id;

  const migrated = migrateInventoryRecords([renamed], [record], () => "must-not-be-used");
  assert.equal(migrated.inventories.length, 1);
  assert.equal(migrated.runs[0].manifest.inventory_id, record.id);
  assert.equal(migrated.inventories[0].nextSerial, 9);
});

test("repairs by permanent inventory id even after the storehouse label changes", () => {
  const first = archivedRun(intake(), ["CA-17-0001", "CA-17-0002"]);
  first.createdAt = "2026-08-20T10:00:00.000Z";
  first.manifest.inventory_id = "inventory-uuid";
  const renamed = archivedRun(intake({ storehouseName: "New display name" }), ["CA-17-0001"]);
  renamed.createdAt = "2026-08-21T10:00:00.000Z";
  renamed.manifest.inventory_id = "inventory-uuid";

  const repaired = repairStorageSerialContinuity([first, renamed]);
  assert.equal(repaired.repaired, 1);
  assert.equal(repaired.runs.find((run) => run.id === renamed.id).manifest.items[0].serial, "CA-17-0003");
});

test("normalizes storage names when resuming in a later session", () => {
  const original = intake();
  const reopened = intake({
    governorate: "  CAIRO ",
    archaeologicalArea: "A differently written area",
    storehouseName: "store a",
    storeRegisterNumber: "",
  });

  assert.equal(storageIdentity(original), storageIdentity(reopened));
  const runs = [archivedRun(original, ["CA-17-0042"])];
  assert.equal(nextStorageSerialNumber(runs, reopened), 43);
  assert.equal(storageSerialPrefix(runs, reopened), "CA-17");
  assert.equal(nextStorageSerial(runs, reopened), "CA-17-0043");
});

test("continues legacy three-part storage keys already saved in the browser", () => {
  const source = intake();
  const legacy = archivedRun(source, ["CA-17-0012"]);
  legacy.manifest.storage_key = "cairo::old cairo::store a";
  delete legacy.manifest.intake;

  assert.equal(runBelongsToStorage(legacy, source), true);
  assert.equal(nextStorageSerialNumber([legacy], source), 13);
});

test("starts a new sequence when a different storage is selected", () => {
  const firstStorage = intake();
  const otherStorage = intake({ storehouseName: "Store B", storeRegisterNumber: "CB-2" });
  const runs = [archivedRun(firstStorage, ["CA-17-0017"])];

  assert.equal(nextStorageSerialNumber(runs, otherStorage), 1);
  assert.equal(makeStorageSerial(otherStorage, 1), "CB-2-0001");
});

test("repairs a later run that restarted inside the same storage", () => {
  const source = intake();
  const first = archivedRun(source, ["CA-17-0001", "CA-17-0002"]);
  first.createdAt = "2026-08-20T10:00:00.000Z";
  const restarted = archivedRun(
    { ...source, archaeologicalArea: "Alternate spelling", storeRegisterNumber: "" },
    ["STORE-A-0001", "STORE-A-0002"],
  );
  restarted.createdAt = "2026-08-21T10:00:00.000Z";

  const result = repairStorageSerialContinuity([restarted, first]);
  const repairedRun = result.runs.find((run) => run.id === restarted.id);
  assert.equal(result.repaired, 2);
  assert.deepEqual(repairedRun.manifest.items.map((item) => item.serial), ["CA-17-0003", "CA-17-0004"]);
});

test("does not renumber valid gaps in an existing storage sequence", () => {
  const source = intake();
  const run = archivedRun(source, ["CA-17-0003", "CA-17-0007"]);
  const result = repairStorageSerialContinuity([run]);
  assert.equal(result.repaired, 0);
  assert.deepEqual(result.runs[0].manifest.items.map((item) => item.serial), ["CA-17-0003", "CA-17-0007"]);
});

test("changes one starting serial and continues every later artefact and crop filename", () => {
  const run = archivedRun(intake(), ["CA-17-0010", "CA-17-0011", "CA-17-0012"]);
  run.manifest.items = run.manifest.items.map((item, index) => ({
    ...item,
    id: `item-${index + 1}`,
    order: index + 1,
    display_serial: `قطعة رقم ${10 + index}`,
    file: `${item.serial}-${String(index + 1).padStart(3, "0")}-item.png`,
  }));
  run.crops = run.manifest.items.map((item, itemIndex) => ({ itemIndex, name: item.file, blob: new Blob([String(itemIndex)]) }));

  const updated = renumberArchiveRunData(run, "CA-17", 100);

  assert.deepEqual(updated.manifest.items.map((item) => item.serial), ["CA-17-0100", "CA-17-0101", "CA-17-0102"]);
  assert.deepEqual(updated.manifest.items.map((item) => item.display_serial), ["قطعة رقم 100", "قطعة رقم 101", "قطعة رقم 102"]);
  assert.deepEqual(updated.manifest.items.map((item) => item.file), [
    "CA-17-0100-001-item.png", "CA-17-0101-002-item.png", "CA-17-0102-003-item.png",
  ]);
  assert.deepEqual(updated.crops.map((crop) => crop.name), updated.manifest.items.map((item) => item.file));
  assert.equal(archiveSerialNumber(updated.manifest.items.at(-1).serial), 102);
  assert.equal(run.manifest.items[0].serial, "CA-17-0010");
});
