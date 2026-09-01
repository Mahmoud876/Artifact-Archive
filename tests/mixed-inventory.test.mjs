import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactGovernorate,
  inventoryArtifacts,
  listInventories,
  migrateInventoryRecords,
  repairStorageSerialContinuity,
} from "../app/types.ts";

const intake = (governorate, storehouse) => ({
  title: "Mixed source batch",
  governorate,
  archaeologicalArea: `${governorate} area`,
  storehouseName: storehouse,
  storeRegisterName: "",
  storeRegisterNumber: "",
  registerPageNumber: "",
  storeRegisterType: "",
  otherLanguage: "",
  institution: "",
  collection: "",
  language: "ar",
  documentType: "register",
  batchRelationship: "mixed",
  notes: "",
});

const records = [
  { id: "inv-cairo", storageKey: "cairo", createdAt: "2026-09-01", updatedAt: "2026-09-01", serialPrefix: "CA", nextSerial: 3, intake: intake("Cairo", "Cairo Store") },
  { id: "inv-luxor", storageKey: "luxor", createdAt: "2026-09-01", updatedAt: "2026-09-01", serialPrefix: "LX", nextSerial: 2, intake: intake("Luxor", "Luxor Store") },
];

const mixedRun = {
  id: "mixed-run",
  createdAt: "2026-09-01T10:00:00.000Z",
  label: "Mixed batch",
  crops: [],
  manifest: {
    inventory_ids: ["inv-cairo", "inv-luxor"],
    intake: intake("", ""),
    sources: [
      { name: "cairo.jpg", inventory_id: "inv-cairo", governorate: "Cairo" },
      { name: "luxor.jpg", inventory_id: "inv-luxor", governorate: "Luxor" },
    ],
    items: [
      { id: "a", order: 1, inventory_id: "inv-cairo", serial: "CA-0001" },
      { id: "b", order: 2, inventory_id: "inv-luxor", serial: "LX-0001" },
      { id: "c", order: 3, inventory_id: "inv-cairo", serial: "CA-0002" },
    ],
  },
};

test("one mixed run appears in every owning inventory with only its own artefacts", () => {
  const inventories = listInventories([mixedRun], records);
  assert.equal(inventories.find((entry) => entry.key === "inv-cairo").artifactCount, 2);
  assert.equal(inventories.find((entry) => entry.key === "inv-luxor").artifactCount, 1);
  assert.deepEqual(inventoryArtifacts([mixedRun], "inv-luxor").map(({ item }) => item.id), ["b"]);
});

test("migration and serial repair preserve per-item ownership boundaries", () => {
  const migration = migrateInventoryRecords([mixedRun], records, () => "must-not-run");
  assert.equal(migration.assigned, 0);
  assert.equal(migration.runs[0].manifest.inventory_id, undefined);
  assert.deepEqual(migration.runs[0].manifest.items.map((item) => item.inventory_id), ["inv-cairo", "inv-luxor", "inv-cairo"]);

  const repaired = repairStorageSerialContinuity([mixedRun]);
  assert.equal(repaired.repaired, 0);
  assert.deepEqual(repaired.runs[0].manifest.items.map((item) => item.serial), ["CA-0001", "LX-0001", "CA-0002"]);
});

test("artifact cards resolve the governorate from each mixed source instead of the empty batch", () => {
  assert.equal(artifactGovernorate(mixedRun, mixedRun.manifest.items[0]), "Cairo");
  assert.equal(artifactGovernorate(mixedRun, mixedRun.manifest.items[1]), "Luxor");
});
