"use client";

// The local archive: every sealed run and the permanent inventory records that
// own their serial sequences. Kept apart from the workbench UI because these
// are the operations that must stay transactional — see ADR-001.

import type { ArchiveRun, IntakeMetadata, InventoryRecord } from "./types.ts";
import {
  defaultStorageSerialPrefix, migrateInventoryRecords, repairStorageSerialContinuity, storageIdentity,
} from "./types.ts";

export const DB_NAME = "seshat-local-archive";
export const DB_STORE = "runs";
export const DB_VERSION = 3;
export const INVENTORY_STORE = "inventories";
export const INVENTORY_STORAGE_INDEX = "by-storage-key";

const starterInventory = (id: string, governorate: string, archaeologicalArea: string, storehouseName: string, serialPrefix: string): InventoryRecord => {
  const intake: IntakeMetadata = {
    title: "",
    governorate,
    archaeologicalArea,
    storehouseName,
    storeRegisterName: "Inventory register",
    storeRegisterNumber: "",
    registerPageNumber: "",
    storeRegisterType: "",
    otherLanguage: "",
    institution: "Seshat",
    collection: "Reference inventories",
    language: "ar",
    documentType: "inventory",
    notes: "Empty inventory ready for new records.",
  };
  return {
    id: `inventory-${id}`,
    storageKey: storageIdentity(intake),
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    serialPrefix,
    nextSerial: 1,
    intake,
  };
};

/** Empty starter inventories used by the governorate-to-inventory selector. */
export const STARTER_INVENTORIES: InventoryRecord[] = [
  starterInventory("cairo-museum", "Cairo", "Downtown Cairo", "Cairo Museum Image Archive", "CA-MIA"),
  starterInventory("cairo-saqqara", "Cairo", "Saqqara", "Saqqara Expedition Store", "CA-SES"),
  starterInventory("giza-plateau", "Giza", "Giza Plateau", "Giza Plateau Photo Store", "GZ-GPS"),
  starterInventory("giza-dahshur", "Giza", "Dahshur", "Dahshur Survey Archive", "GZ-DSA"),
  starterInventory("luxor-karnak", "Luxor", "Karnak", "Karnak Documentation Store", "LX-KDS"),
  starterInventory("luxor-west-bank", "Luxor", "Theban West Bank", "West Bank Excavation Archive", "LX-WBA"),
  starterInventory("alexandria-maritime", "Alexandria", "Eastern Harbour", "Maritime Heritage Store", "AX-MHS"),
  starterInventory("alexandria-kom-el-dikka", "Alexandria", "Kom El Dikka", "Kom El Dikka Archive", "AX-KDA"),
];

export function openArchive(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const runStore = database.objectStoreNames.contains(DB_STORE)
        ? request.transaction!.objectStore(DB_STORE)
        : database.createObjectStore(DB_STORE, { keyPath: "id" });
      const inventoryStore = database.objectStoreNames.contains(INVENTORY_STORE)
        ? request.transaction!.objectStore(INVENTORY_STORE)
        : database.createObjectStore(INVENTORY_STORE, { keyPath: "id" });
      if (!inventoryStore.indexNames.contains(INVENTORY_STORAGE_INDEX)) {
        inventoryStore.createIndex(INVENTORY_STORAGE_INDEX, "storageKey", { unique: true });
      }
      // Version 3 is the requested clean start. It removes all saved runs,
      // source blobs, crops, inventory counters, and old inventory metadata,
      // then recreates only the empty starter inventory structure.
      if (event.oldVersion > 0 && event.oldVersion < 3) {
        runStore.clear();
        inventoryStore.clear();
        for (const inventory of STARTER_INVENTORIES) {
          inventoryStore.put({ ...inventory, intake: { ...inventory.intake } });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("The archive transaction was cancelled."));
  });
}

export async function seedStarterInventories(): Promise<number> {
  const db = await openArchive();
  const transaction = db.transaction(INVENTORY_STORE, "readwrite");
  const done = transactionDone(transaction);
  try {
    const store = transaction.objectStore(INVENTORY_STORE);
    const existing = await idbRequest(store.getAll()) as InventoryRecord[];
    const ids = new Set(existing.map((inventory) => inventory.id));
    const storageKeys = new Set(existing.map((inventory) => inventory.storageKey));
    let added = 0;
    for (const inventory of STARTER_INVENTORIES) {
      if (ids.has(inventory.id) || storageKeys.has(inventory.storageKey)) continue;
      store.put({ ...inventory, intake: { ...inventory.intake } });
      ids.add(inventory.id);
      storageKeys.add(inventory.storageKey);
      added += 1;
    }
    await done;
    return added;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already closed */ }
    await done.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

export function archiveSerialNumber(serial?: string): number | null {
  const value = Number(serial?.match(/-(\d+)$/)?.[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Renumber one saved batch without changing the order of its artefacts. */
export function renumberArchiveRunData(run: ArchiveRun, serialPrefix: string, startingNumber: number): ArchiveRun {
  if (!Number.isInteger(startingNumber) || startingNumber < 1) throw new Error("Starting serial must be a positive whole number.");
  const items = run.manifest.items.map((item, index) => {
    const serial = `${serialPrefix}-${String(startingNumber + index).padStart(4, "0")}`;
    const oldPrefix = item.serial ? `${item.serial}-` : "";
    const suffix = item.file && oldPrefix && item.file.startsWith(oldPrefix) ? item.file.slice(oldPrefix.length) : item.file;
    return {
      ...item,
      serial,
      display_serial: `قطعة رقم ${startingNumber + index}`,
      file: suffix ? `${serial}-${suffix}` : item.file,
    };
  });
  const crops = run.crops.map((crop) => {
    const oldItem = run.manifest.items[crop.itemIndex];
    const updatedItem = items[crop.itemIndex];
    if (!updatedItem?.serial) return crop;
    const oldPrefix = oldItem?.serial ? `${oldItem.serial}-` : "";
    const suffix = oldPrefix && crop.name.startsWith(oldPrefix) ? crop.name.slice(oldPrefix.length) : crop.name;
    return { ...crop, name: `${updatedItem.serial}-${suffix}` };
  });
  return { ...run, crops, manifest: { ...run.manifest, items } };
}

/**
 * Change the first permanent serial of a saved batch and continue every item
 * after it. Existing serials in other batches are protected from collisions,
 * and the owning inventory counter is advanced to the next free number.
 */
export async function renumberArchiveRun(runId: string, startingNumber: number): Promise<{ run: ArchiveRun; inventory: InventoryRecord }> {
  if (!Number.isInteger(startingNumber) || startingNumber < 1) throw new Error("أدخل رقم بداية صحيحاً أكبر من صفر.");
  const db = await openArchive();
  const transaction = db.transaction([DB_STORE, INVENTORY_STORE], "readwrite");
  const done = transactionDone(transaction);
  try {
    const runStore = transaction.objectStore(DB_STORE);
    const inventoryStore = transaction.objectStore(INVENTORY_STORE);
    const [run, allRuns, inventories] = await Promise.all([
      idbRequest(runStore.get(runId)) as Promise<ArchiveRun | undefined>,
      idbRequest(runStore.getAll()) as Promise<ArchiveRun[]>,
      idbRequest(inventoryStore.getAll()) as Promise<InventoryRecord[]>,
    ]);
    if (!run) throw new Error("تعذر العثور على الدفعة المحفوظة.");
    const owners = new Set(run.manifest.items.map((item) => item.inventory_id || run.manifest.inventory_id).filter(Boolean));
    if (owners.size > 1) throw new Error("هذه الدفعة موزعة على أكثر من مخزن. غيّر أرقام القطع داخل كل مخزن بدلاً من إعادة ترقيم الدفعة كلها.");
    const inventory = inventories.find((entry) => entry.id === run.manifest.inventory_id);
    if (!inventory) throw new Error("تعذر العثور على سجل المخزن المرتبط بهذه الدفعة.");
    if (!run.manifest.items.length) throw new Error("لا توجد قطع لإعادة ترقيمها.");

    const occupied = new Set<number>();
    for (const otherRun of allRuns) {
      if (otherRun.id === run.id || otherRun.manifest.inventory_id !== inventory.id) continue;
      for (const item of otherRun.manifest.items) {
        const number = archiveSerialNumber(item.serial);
        if (number !== null) occupied.add(number);
      }
    }
    const finalNumber = startingNumber + run.manifest.items.length - 1;
    for (let number = startingNumber; number <= finalNumber; number += 1) {
      if (occupied.has(number)) throw new Error(`الرقم ${number} مستخدم بالفعل في دفعة أخرى داخل هذا المخزن. اختر بداية لا تتداخل مع الأرقام المحفوظة.`);
    }

    const updatedRun = renumberArchiveRunData(run, inventory.serialPrefix, startingNumber);
    let highest = 0;
    for (const candidate of allRuns.map((entry) => entry.id === run.id ? updatedRun : entry)) {
      if (candidate.manifest.inventory_id !== inventory.id) continue;
      for (const item of candidate.manifest.items) highest = Math.max(highest, archiveSerialNumber(item.serial) ?? 0);
    }
    const updatedInventory = { ...inventory, nextSerial: highest + 1, updatedAt: new Date().toISOString() };
    runStore.put(updatedRun);
    inventoryStore.put(updatedInventory);
    await done;
    return { run: updatedRun, inventory: updatedInventory };
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already closed */ }
    await done.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

export async function saveArchiveRun(run: ArchiveRun) {
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(run);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function getArchiveRun(id: string): Promise<ArchiveRun | undefined> {
  const db = await openArchive();
  const run = await new Promise<ArchiveRun | undefined>((resolve, reject) => {
    const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result as ArchiveRun | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return run;
}

export async function loadArchiveRuns(): Promise<ArchiveRun[]> {
  const db = await openArchive();
  const runs = await new Promise<ArchiveRun[]>((resolve, reject) => {
    const request = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result as ArchiveRun[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Assign permanent inventory UUIDs to v1 runs without changing valid serials. */
export async function migrateArchiveDatabase() {
  const db = await openArchive();
  const transaction = db.transaction([DB_STORE, INVENTORY_STORE], "readwrite");
  const done = transactionDone(transaction);
  try {
    const runStore = transaction.objectStore(DB_STORE);
    const inventoryStore = transaction.objectStore(INVENTORY_STORE);
    const [loadedRuns, storedInventories] = await Promise.all([
      idbRequest(runStore.getAll()) as Promise<ArchiveRun[]>,
      idbRequest(inventoryStore.getAll()) as Promise<InventoryRecord[]>,
    ]);
    const continuity = repairStorageSerialContinuity(loadedRuns);
    const migration = migrateInventoryRecords(continuity.runs, storedInventories, () => crypto.randomUUID());

    for (const run of migration.runs) runStore.put(run);
    for (const inventory of migration.inventories) inventoryStore.put(inventory);
    await done;
    return {
      runs: migration.runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      inventories: migration.inventories,
      repaired: continuity.repaired,
      assigned: migration.assigned,
    };
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already closed */ }
    await done.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Allocate all missing serials and save the run in one transaction. IndexedDB
 * serializes read/write transactions, preventing duplicate numbers across tabs.
 */
export async function sealArchiveRun(
  run: ArchiveRun,
  intake: IntakeMetadata,
  selectedInventoryId: string | null,
  sourceInventoryIds?: Record<number, string>,
): Promise<{ run: ArchiveRun; inventory: InventoryRecord; inventories: InventoryRecord[] }> {
  const db = await openArchive();
  const transaction = db.transaction([DB_STORE, INVENTORY_STORE], "readwrite");
  const done = transactionDone(transaction);
  try {
    const runStore = transaction.objectStore(DB_STORE);
    const inventoryStore = transaction.objectStore(INVENTORY_STORE);
    const requestedId = run.manifest.inventory_id ?? selectedInventoryId;
    const storageKey = storageIdentity(intake);
    const loadedInventories = await idbRequest(inventoryStore.getAll()) as InventoryRecord[];
    const inventoryById = new Map(loadedInventories.map((entry) => [entry.id, entry]));
    let inventory = requestedId ? inventoryById.get(requestedId) : loadedInventories.find((entry) => entry.storageKey === storageKey);

    if (requestedId && !inventory) throw new Error("The selected inventory no longer exists. Return to intake and select it again.");
    if (!inventory) {
      const now = new Date().toISOString();
      inventory = {
        id: crypto.randomUUID(),
        storageKey,
        createdAt: now,
        updatedAt: now,
        serialPrefix: defaultStorageSerialPrefix(intake),
        nextSerial: 1,
        intake: { ...intake },
      };
      inventoryById.set(inventory.id, inventory);
    }

    const requiredInventoryIds = new Set(Object.values(sourceInventoryIds ?? {}).filter(Boolean));
    for (const inventoryId of requiredInventoryIds) {
      if (!inventoryById.has(inventoryId)) throw new Error("One of the selected source inventories no longer exists. Return to intake and select it again.");
    }
    const counters = new Map<string, number>([...inventoryById.values()].map((entry) => [entry.id, entry.nextSerial]));
    const allocatedItems = run.manifest.items.map((item) => {
      const sourceOwnerId = sourceInventoryIds ? sourceInventoryIds[item.source_index ?? -1] : undefined;
      if (sourceInventoryIds && !sourceOwnerId) throw new Error("Every extracted item must point to a source image with an inventory assignment.");
      const ownerId = sourceOwnerId || item.inventory_id || inventory.id;
      const owner = inventoryById.get(ownerId);
      if (!owner) throw new Error("An extracted item has no valid inventory assignment.");
      const nextSerial = counters.get(ownerId) ?? owner.nextSerial;
      if (item.serial) {
        const number = Number(item.serial.match(/-(\d+)$/)?.[1]);
        if (Number.isFinite(number)) counters.set(ownerId, Math.max(nextSerial, number + 1));
        return { ...item, inventory_id: ownerId, display_serial: item.display_serial?.trim() || `قطعة رقم ${Number.isFinite(number) ? number : item.order}` };
      }
      const serial = `${owner.serialPrefix}-${String(nextSerial).padStart(4, "0")}`;
      const display_serial = `قطعة رقم ${nextSerial}`;
      counters.set(ownerId, nextSerial + 1);
      return { ...item, inventory_id: ownerId, serial, display_serial };
    });
    const serializedNames = new Map<number, string>();
    const items = allocatedItems.map((item, index) => {
      if (!item.file || !item.serial) return item;
      const file = item.file.startsWith(`${item.serial}-`) ? item.file : `${item.serial}-${item.file}`;
      serializedNames.set(index, file);
      return { ...item, file };
    });
    const crops = run.crops.map((crop) => ({
      ...crop,
      name: serializedNames.get(crop.itemIndex) ?? crop.name,
    }));
    const ownerIds = [...new Set([
      ...Object.values(sourceInventoryIds ?? {}).filter(Boolean),
      ...items.map((item) => item.inventory_id).filter((id): id is string => Boolean(id)),
    ])];
    const updatedAt = new Date().toISOString();
    const sealedInventories = ownerIds.map((ownerId) => {
      const owner = inventoryById.get(ownerId)!;
      return { ...owner, nextSerial: counters.get(ownerId) ?? owner.nextSerial, updatedAt };
    });
    const sealedInventory = sealedInventories.find((entry) => entry.id === inventory.id) ?? sealedInventories[0] ?? inventory;
    const sealedRun = {
      ...run,
      crops,
      manifest: {
        ...run.manifest,
        inventory_id: ownerIds.length === 1 ? ownerIds[0] : undefined,
        inventory_ids: ownerIds,
        storage_key: ownerIds.length === 1 ? inventoryById.get(ownerIds[0])?.storageKey : undefined,
        items,
      },
    };
    for (const owner of sealedInventories) inventoryStore.put(owner);
    runStore.put(sealedRun);
    await done;
    return { run: sealedRun, inventory: sealedInventory, inventories: sealedInventories };
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already closed */ }
    await done.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

export async function deleteArchiveRun(id: string) {
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function clearArchiveStore() {
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([DB_STORE, INVENTORY_STORE], "readwrite");
    transaction.objectStore(DB_STORE).clear();
    transaction.objectStore(INVENTORY_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
