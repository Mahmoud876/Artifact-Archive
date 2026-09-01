import test from "node:test";
import assert from "node:assert/strict";

import { STARTER_INVENTORIES } from "../app/archive-db.ts";
import { inventoriesInGovernorate } from "../app/types.ts";

test("starter data provides several empty inventories inside every governorate", () => {
  const grouped = new Map();
  for (const inventory of STARTER_INVENTORIES) {
    const governorate = inventory.intake.governorate;
    grouped.set(governorate, [...(grouped.get(governorate) ?? []), inventory]);
  }

  assert.deepEqual([...grouped.keys()].sort(), ["Alexandria", "Cairo", "Giza", "Luxor"]);
  for (const [governorate, inventories] of grouped) {
    assert.ok(inventories.length >= 2, `${governorate} should have at least two starter inventories`);
  }
  assert.equal(new Set(STARTER_INVENTORIES.map((inventory) => inventory.id)).size, STARTER_INVENTORIES.length);
  assert.equal(new Set(STARTER_INVENTORIES.map((inventory) => inventory.storageKey)).size, STARTER_INVENTORIES.length);
  assert.ok(STARTER_INVENTORIES.every((inventory) => inventory.nextSerial === 1));
  assert.doesNotMatch(JSON.stringify(STARTER_INVENTORIES), /demo/i);
});

test("the intake cascade returns only inventories from the selected governorate", () => {
  const cairo = inventoriesInGovernorate(STARTER_INVENTORIES, "  CAIRO  ");
  assert.deepEqual(cairo.map((inventory) => inventory.intake.storehouseName), [
    "Cairo Museum Image Archive",
    "Saqqara Expedition Store",
  ]);
  assert.ok(cairo.every((inventory) => inventory.intake.governorate === "Cairo"));
  assert.equal(inventoriesInGovernorate(STARTER_INVENTORIES, "Aswan").length, 0);
  assert.equal(inventoriesInGovernorate(STARTER_INVENTORIES, "").length, 0);
});
