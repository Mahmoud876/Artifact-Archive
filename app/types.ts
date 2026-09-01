// Shared shapes for the workbench, the archive browser, and the taxonomy table.

export type Asset = { id: string; name: string; type: string; size: number; preview?: string; width?: number; height?: number; digest?: string; file: File };
export type AnalysisItem = {
  /** Present after a result has been sealed, so manual corrections preserve identity. */
  id?: string;
  serial?: string;
  display_serial?: string;
  inventory_id?: string;
  title: string;
  category: string;
  description: string;
  confidence: number | null;
  bbox: number[] | null;
  source_index: number | null;
  /** Number visibly written on the small label attached to the photographed object. */
  plate_serial?: string | null;
  /** Source-pixel bounds of that physical label, separate from the photograph. */
  plate_label_bbox?: number[] | null;
};
export type CoordinateSpace = "ollama_pixels" | "pixels" | "normalized_1000";
export type HandwritingReview = {
  status: "accepted" | "rejected";
  agreement: number;
  verifiedCells: number;
  candidateCells: number;
  /** Single-pass suggestions exposed only so an operator can compare them with the scan. */
  proposedCells?: number;
  enhancementVariants?: string[];
  secondaryVariants?: string[];
};
export type EnhancementPreview = {
  row: number;
  column: number;
  columnLabel: string;
  bbox: number[];
  sourceWidth: number;
  sourceHeight: number;
  variants: Array<{ kind: string; imageUrl: string; width?: number; height?: number; scale?: number }>;
};
export type AnalysisResult = {
  summary: string;
  items: AnalysisItem[];
  transcription: string | null;
  table?: TableBlock | null;
  /** Unverified OCR is review evidence. It may be stored locally, but is never
   * promoted to a verified transcription until an operator accepts it. */
  review_table?: TableBlock | null;
  handwriting_review?: HandwritingReview;
  enhancement_preview?: EnhancementPreview | null;
  warnings: string[];
  coordinate_space?: CoordinateSpace;
};
export type ManifestItem = AnalysisItem & { id: string; order: number; source_name: string | null; file: string | null };

/** Human-facing Arabic artefact label. The machine serial remains immutable. */
export function artifactDisplaySerial(item: Pick<ManifestItem, "display_serial" | "serial" | "order">) {
  const custom = item.display_serial?.trim();
  if (custom) return custom;
  const issued = Number(item.serial?.match(/-(\d+)$/)?.[1]);
  return `قطعة رقم ${Number.isFinite(issued) ? issued : item.order}`;
}
export type TaskId = "extract" | "classify" | "transcribe" | "summarize" | "catalogue";
// A ruled register read back as cells rather than prose.
export type TableBlock = {
  columns: string[];
  rows: string[][];
  /** Source-pixel boundaries for the printed register rows. */
  row_bounds?: number[];
  source_height?: number;
  /** `row:column` keys for model readings that still need a human check. */
  review_cells?: string[];
  /** `row:column` keys explicitly typed or changed by an operator. */
  human_cells?: string[];
  /** Disagreeing isolated OCR readings. These are review choices, never trusted data. */
  alternatives?: Array<{ row: number; column: number; first: string; second: string }>;
};
export type RunStatus = "ready" | "running" | "saving" | "complete" | "error";
export type ViewId = "workbench" | "inventories" | "archive" | "taxonomy" | "settings";
export type CropFormat = "png" | "jpeg" | "webp";
export type Provider = "local" | "gemini";
export type BatchRelationship = "same_register" | "same_source" | "same_governorate" | "mixed";

export const batchRelationshipLabels: Record<BatchRelationship, string> = {
  same_register: "نفس الكتاب أو السجل",
  same_source: "نفس المصدر أو المخزن",
  same_governorate: "نفس المحافظة فقط",
  mixed: "مصادر مختلفة أو غير مؤكدة",
};

export const batchRelationshipLabel = (relationship?: BatchRelationship) =>
  relationship ? batchRelationshipLabels[relationship] : "غير مسجلة";

export type IntakeMetadata = {
  title: string;
  governorate: string;
  archaeologicalArea: string;
  storehouseName: string;
  storeRegisterName: string;
  storeRegisterNumber: string;
  registerPageNumber: string;
  storeRegisterType: string;
  otherLanguage: string;
  institution: string;
  collection: string;
  language: "ar" | "ar-en" | "ar-fr" | "mixed";
  documentType: "register" | "inventory" | "photographic" | "other";
  /** How multiple source images in this batch relate to each other. */
  batchRelationship?: BatchRelationship;
  notes: string;
};

export type SourceAssignmentDraft = {
  governorate: string;
  inventoryId: string;
};

export type RunOptions = {
  provider: Provider;
  detectorPrompt: string;
  boxThreshold: number;
  textThreshold: number;
  minConfidence: number;
  maxItems: number;
  cropPadding: number;
  cropFormat: CropFormat;
  saveCrops: boolean;
  recordCoordinates: boolean;
  flagUncertain: boolean;
};

export type ArchiveManifest = {
  schema: "seshat.archive.v1";
  id: string;
  series?: string;
  /** Permanent owner of this run's serial sequence (IndexedDB inventories store). */
  inventory_id?: string;
  /** Every permanent owner represented when a mixed batch spans inventories. */
  inventory_ids?: string[];
  /** Legacy normalized lookup key; inventory_id is the permanent owner. */
  storage_key?: string;
  created_at: string;
  task: TaskId;
  model: string;
  summary: string;
  coordinate_space: CoordinateSpace;
  sources: Array<{ name: string; type: string; size: number; width?: number; height?: number; inventory_id?: string; governorate?: string; archaeological_area?: string; storehouse_name?: string }>;
  items: ManifestItem[];
  transcription: string | null;
  table?: TableBlock | null;
  /** Whether the stored table is final or still contains operator-review cells. */
  table_status?: "verified" | "needs_review";
  // Row index (as a string key) -> crop file name. New runs store only explicit
  // operator overrides; legacy runs may also contain automatic assignments.
  table_plates?: Record<string, string>;
  warnings: string[];
  options?: RunOptions;
  intake?: IntakeMetadata;
};

export type SavedCrop = { itemIndex: number; name: string; blob: Blob };
export type SavedSource = { sourceIndex: number; name: string; type: string; blob: Blob; width?: number; height?: number };
export type ArchiveRun = { id: string; createdAt: string; label: string; series?: string; manifest: ArchiveManifest; crops: SavedCrop[]; sources?: SavedSource[] };
export type ArchiveSummary = { id: string; createdAt: string; label: string; itemCount: number; cropCount: number };
export type InventoryRecord = {
  id: string;
  storageKey: string;
  createdAt: string;
  updatedAt: string;
  serialPrefix: string;
  /** First number that has never been issued. Deleted records do not release it. */
  nextSerial: number;
  intake: IntakeMetadata;
};
export type InventorySummary = {
  key: string;
  name: string;
  governorate: string;
  archaeologicalArea: string;
  registerName: string;
  registerNumber: string;
  runs: ArchiveRun[];
  artifactCount: number;
  plateCount: number;
  bytes: number;
  firstSerial: string | null;
  lastSerial: string | null;
  updatedAt: string;
};

export type SystemStatus = {
  analysis: { configured: boolean };
  ollama: { ok: boolean; base: string; models: string[]; error?: string };
  detector: { ok: boolean; base: string; status?: string; device?: string; model?: string; cuda?: string; error?: string };
  defaults: { model: string };
};

export const defaultRunOptions: RunOptions = {
  provider: "local",
  detectorPrompt: "",
  boxThreshold: 0.22,
  textThreshold: 0.18,
  minConfidence: 0,
  maxItems: 40,
  cropPadding: 6,
  cropFormat: "png",
  saveCrops: true,
  recordCoordinates: true,
  flagUncertain: true,
};

export const providerLabel: Record<Provider, string> = { local: "Local · Ollama", gemini: "Cloud · Gemini API" };

export const cropExtension: Record<CropFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };
export const cropMime: Record<CropFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export const formatFullDate = (value: string) =>
  new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export const taskLabel: Record<TaskId, string> = {
  extract: "Extract & serialize",
  classify: "Categorize",
  transcribe: "Transcribe",
  summarize: "Summarize",
  catalogue: "Full record",
};

export type PlateMatchMethod = "label-exact" | "label-number" | "position";
export type PlateAssignment = {
  file: string;
  method: PlateMatchMethod;
  plateSerial?: string;
  rowSerial?: string;
};

const westernDigit = (character: string) => {
  const eastern = "٠١٢٣٤٥٦٧٨٩".indexOf(character);
  if (eastern >= 0) return String(eastern);
  const persian = "۰۱۲۳۴۵۶۷۸۹".indexOf(character);
  return persian >= 0 ? String(persian) : character;
};

export function normalizeWrittenSerial(value?: string | null) {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[٠-٩۰-۹]/gu, westernDigit)
    .replace(/^\s*\[(?:\?|؟)\]\s*$/u, "")
    .toLocaleLowerCase()
    .replace(/[\sـ]/gu, "")
    .replace(/[–—]/gu, "-")
    .replace(/[^\p{L}\p{N}/().-]/gu, "")
    .trim();
}

function serialMatchKeys(value?: string | null, allowPrimaryFallback = true) {
  const normalized = normalizeWrittenSerial(value);
  if (!normalized) return [];
  const numbers = normalized.match(/\d+/gu)?.map((part) => String(Number(part))) ?? [];
  const keys = [`exact:${normalized}`];
  if (numbers.length) {
    keys.push(`number:${numbers.join("/")}`);
    // A pasted label often carries only the main number while the register adds
    // a sub-number after a slash. It is safe only when unique across the page.
    // A row may include a sub-number while its pasted label carries only the
    // main number. Never shorten a multi-part plate reading: 24/3 must not be
    // allowed to match row 24/1 merely because both begin with 24.
    if (allowPrimaryFallback || numbers.length === 1) keys.push(`number:${numbers[0]}`);
  }
  return [...new Set(keys)];
}

/**
 * Match a pasted photograph to its register row by written serial first.
 * Position is retained only as a fallback and is reported separately in the UI.
 */
export function matchPlateAssignments(items: ManifestItem[], rowsOrTableOrCount: string[][] | TableBlock | number): Record<string, PlateAssignment> {
  const table = typeof rowsOrTableOrCount === "object" && !Array.isArray(rowsOrTableOrCount) ? rowsOrTableOrCount : null;
  const rows = table?.rows ?? (Array.isArray(rowsOrTableOrCount) ? rowsOrTableOrCount : []);
  const rowCount = table ? table.rows.length : Array.isArray(rowsOrTableOrCount) ? rowsOrTableOrCount.length : rowsOrTableOrCount;
  const rowBounds = table?.row_bounds?.length === rowCount + 1 ? table.row_bounds : null;
  const plated = items.filter((item) => item.file && item.bbox?.length === 4);
  if (!plated.length || rowCount < 1) return {};

  const assignments: Record<string, PlateAssignment> = {};
  const usedFiles = new Set<string>();
  const matchingBox = (item: ManifestItem) => item.plate_label_bbox?.length === 4
    ? item.plate_label_bbox
    : item.bbox;
  const serialIsPhysicallyCompatible = (item: ManifestItem, rowIndex: number) => {
    const box = matchingBox(item);
    if (!rowBounds || !box?.length) return true;
    const itemTop = Math.min(box[1], box[3]);
    const itemBottom = Math.max(box[1], box[3]);
    const rowTop = rowBounds[rowIndex];
    const rowBottom = rowBounds[rowIndex + 1];
    const centre = (itemTop + itemBottom) / 2;
    const tolerance = Math.max(4, (rowBottom - rowTop) * 0.25);
    return centre >= rowTop - tolerance && centre <= rowBottom + tolerance;
  };
  if (rows.length) {
    const rowKeys = new Map<string, number[]>();
    rows.forEach((row, rowIndex) => {
      for (const key of serialMatchKeys(row[0])) {
        rowKeys.set(key, [...(rowKeys.get(key) ?? []), rowIndex]);
      }
    });
    for (const item of plated) {
      const plateSerial = item.plate_serial?.trim();
      if (!plateSerial) continue;
      const byRow = new Map<number, { key: string; rowIndex: number }>();
      for (const key of serialMatchKeys(plateSerial, false)) {
        for (const rowIndex of rowKeys.get(key) ?? []) {
          const existing = byRow.get(rowIndex);
          if (!existing || key.startsWith('exact:')) byRow.set(rowIndex, { key, rowIndex });
        }
      }
      let candidates = [...byRow.values()];
      // A serial that identifies one row on the page is authoritative. Geometry
      // is used only to disambiguate duplicate written numbers, because a large
      // pasted photograph commonly crosses one or more printed row boundaries.
      if (candidates.length > 1) {
        candidates = candidates.filter((candidate) => serialIsPhysicallyCompatible(item, candidate.rowIndex));
      }
      if (candidates.length !== 1) continue;
      const candidate = candidates[0];
      const rowKey = String(candidate.rowIndex);
      if (assignments[rowKey]) continue;
      assignments[rowKey] = {
        file: item.file as string,
        method: candidate.key.startsWith('exact:') ? 'label-exact' : 'label-number',
        plateSerial,
        rowSerial: rows[candidate.rowIndex]?.[0] ?? "",
      };
      usedFiles.add(item.file as string);
    }
    if (!rowBounds) return assignments;

    // For unreadable or slightly misread labels, use the actual paper tag's
    // source position. This is deliberately unavailable without detected row
    // boundaries, so an evenly-spaced guess can never become an archive link.
    const positionCandidates = plated
      .filter((item) => !usedFiles.has(item.file as string))
      .flatMap((item) => {
        const box = matchingBox(item);
        if (!box?.length) return [];
        const top = Math.min(box[1], box[3]);
        const bottom = Math.max(box[1], box[3]);
        const centre = (top + bottom) / 2;
        return rows.map((_, rowIndex) => {
          const rowTop = rowBounds[rowIndex];
          const rowBottom = rowBounds[rowIndex + 1];
          const overlap = Math.max(0, Math.min(bottom, rowBottom) - Math.max(top, rowTop));
          const distance = centre < rowTop ? rowTop - centre : centre > rowBottom ? centre - rowBottom : 0;
          const rowHeight = Math.max(1, rowBottom - rowTop);
          const containsCentre = distance === 0;
          const score = (containsCentre ? 3 : 0) + overlap / Math.max(1, bottom - top) - distance / rowHeight;
          return { item, rowIndex, score, containsCentre };
        });
      })
      .filter((candidate) => candidate.containsCentre || candidate.score > 0.2)
      .sort((left, right) => right.score - left.score);
    for (const candidate of positionCandidates) {
      const rowKey = String(candidate.rowIndex);
      const file = candidate.item.file as string;
      if (assignments[rowKey] || usedFiles.has(file)) continue;
      assignments[rowKey] = {
        file,
        method: 'position',
        plateSerial: candidate.item.plate_serial ?? undefined,
      };
      usedFiles.add(file);
    }
    return assignments;
  }

  const allCentred = plated.map((item) => {
    const [x1, y1, x2, y2] = item.bbox as number[];
    return { file: item.file as string, centre: (y1 + y2) / 2, area: Math.abs(x2 - x1) * Math.abs(y2 - y1) };
  });
  const centred = allCentred.filter((item) => !usedFiles.has(item.file));
  if (!centred.length) return assignments;
  // Keep the full-page range even after some plates were matched by label. This
  // prevents the remaining positional fallbacks from being stretched to the
  // first and last register rows.
  const tops = allCentred.map((entry) => entry.centre);
  const top = Math.min(...tops);
  const span = Math.max(1, Math.max(...tops) - top);

  const chosen: Record<string, { file: string; area: number }> = {};
  for (const entry of centred) {
    const slot = rowCount === 1 ? 0 : Math.round(((entry.centre - top) / span) * (rowCount - 1));
    const key = String(Math.min(rowCount - 1, Math.max(0, slot)));
    // When several detections land on one row, keep the biggest — the small
    // ones are usually caption scraps or detector noise.
    if (!assignments[key] && (!chosen[key] || entry.area > chosen[key].area)) chosen[key] = { file: entry.file, area: entry.area };
  }

  for (const [key, value] of Object.entries(chosen)) assignments[key] = { file: value.file, method: "position" };
  return assignments;
}

export function matchPlatesToRows(items: ManifestItem[], rowsOrTableOrCount: string[][] | TableBlock | number): Record<string, string> {
  return Object.fromEntries(Object.entries(matchPlateAssignments(items, rowsOrTableOrCount)).map(([key, value]) => [key, value.file]));
}

// The column a register reserves for the artefact photograph, if it has one.
export function findPlateColumn(columns: string[]): number {
  const index = columns.findIndex((name) => /صور|رسم|photograph|image/i.test(name));
  return index;
}

/* --------------------------------------------------------------------------
   Pages can still be grouped into a register series, but serial ownership is
   separate: the physical storage location owns and continues its sequence.
   -------------------------------------------------------------------------- */

export const UNFILED = "Unfiled";

export const seriesSlug = (name: string) =>
  name.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase().slice(0, 14) || "SERIES";

export const runSeries = (run: ArchiveRun) => run.series ?? run.manifest.series ?? UNFILED;

const normalizeStoragePart = (value?: string) => (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
export const normalizeGovernorateName = (value?: string) => normalizeStoragePart(value);

export function inventoriesInGovernorate(inventories: InventoryRecord[], governorate: string): InventoryRecord[] {
  const key = normalizeGovernorateName(governorate);
  if (!key) return [];
  return inventories
    .filter((inventory) => normalizeGovernorateName(inventory.intake.governorate) === key)
    .sort((left, right) => left.intake.storehouseName.localeCompare(right.intake.storehouseName));
}

/**
 * Stable storage owner.  Archaeological-area wording is descriptive metadata,
 * not identity: it is frequently blank or written differently on later pages.
 * Governorate disambiguates storehouses with the same name in different places.
 */
export function storageIdentity(intake: Partial<IntakeMetadata>): string {
  return [intake.governorate, intake.storehouseName]
    .map(normalizeStoragePart)
    .filter(Boolean)
    .join("::");
}

export const runStorageKey = (run: ArchiveRun) => run.manifest.storage_key
  ?? (run.manifest.intake ? storageIdentity(run.manifest.intake) : "");

/** Match both new two-part keys and older three-part keys already in IndexedDB. */
export function runBelongsToStorage(run: ArchiveRun, intake: Partial<IntakeMetadata>): boolean {
  const target = storageIdentity(intake);
  if (!target) return false;
  if (runStorageKey(run) === target) return true;
  if (run.manifest.intake && storageIdentity(run.manifest.intake) === target) return true;

  // Legacy manifests may not contain intake, but their key was
  // governorate::archaeological-area::storehouse.
  const legacyParts = runStorageKey(run).split("::").map(normalizeStoragePart).filter(Boolean);
  const targetParts = target.split("::");
  return legacyParts.length >= 3
    && legacyParts[0] === targetParts[0]
    && legacyParts[legacyParts.length - 1] === targetParts[targetParts.length - 1];
}

/** Highest serial issued by this storage, even when it was saved in another run. */
export function nextStorageSerialNumber(runs: ArchiveRun[], intake: IntakeMetadata): number {
  const key = storageIdentity(intake);
  if (!key) return 1;
  let highest = 0;
  for (const run of runs) {
    if (!runBelongsToStorage(run, intake)) continue;
    for (const item of run.manifest.items) {
      const tail = Number(item.serial?.split("-").pop());
      if (Number.isFinite(tail)) highest = Math.max(highest, tail);
    }
  }
  return highest + 1;
}

/** Preserve the prefix already issued by a storage, even if later intake fields change. */
export function storageSerialPrefix(runs: ArchiveRun[], intake: IntakeMetadata): string {
  let highest = 0;
  let existing = "";
  for (const run of runs) {
    if (!runBelongsToStorage(run, intake)) continue;
    for (const item of run.manifest.items) {
      const match = item.serial?.match(/^(.*)-(\d+)$/);
      if (!match) continue;
      const value = Number(match[2]);
      if (Number.isFinite(value) && value >= highest) {
        highest = value;
        existing = match[1];
      }
    }
  }
  return existing || defaultStorageSerialPrefix(intake);
}

export const defaultStorageSerialPrefix = (intake: IntakeMetadata) => {
  const label = intake.storeRegisterNumber.trim() || intake.storehouseName.trim();
  const readable = label.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase().slice(0, 14);
  if (readable) return readable;
  let hash = 2166136261;
  for (const character of storageIdentity(intake)) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return `STORE-${(hash >>> 0).toString(36).toUpperCase().slice(0, 5)}`;
};

export const makeStorageSerial = (intake: IntakeMetadata, index: number, prefix?: string) => `${prefix || defaultStorageSerialPrefix(intake)}-${String(index).padStart(4, "0")}`;

export const nextStorageSerial = (runs: ArchiveRun[], intake: IntakeMetadata) =>
  makeStorageSerial(intake, nextStorageSerialNumber(runs, intake), storageSerialPrefix(runs, intake));

export function canonicalRunStorageKey(run: ArchiveRun): string {
  if (run.manifest.intake) return storageIdentity(run.manifest.intake);
  const parts = runStorageKey(run).split("::").map(normalizeStoragePart).filter(Boolean);
  return parts.length >= 3 ? `${parts[0]}::${parts[parts.length - 1]}` : parts.join("::");
}

export const runInventoryKey = (run: ArchiveRun) => run.manifest.inventory_id
  || canonicalRunStorageKey(run)
  || "__unassigned__";

export const itemInventoryKey = (run: ArchiveRun, item: ManifestItem) => item.inventory_id || runInventoryKey(run);

/** Source-level archive metadata wins for mixed batches; legacy runs fall back
 * to the one intake record stored on the whole run. */
export const sourceMetadataForItem = (run: ArchiveRun, item: ManifestItem) => {
  const sources = run.manifest.sources ?? [];
  const index = item.source_index;
  if (index !== null && index !== undefined && index >= 0) return sources[index];
  if (item.source_name) {
    const named = sources.find((source) => source.name === item.source_name);
    if (named) return named;
  }
  return item.inventory_id ? sources.find((source) => source.inventory_id === item.inventory_id) : undefined;
};

export const artifactGovernorate = (run: ArchiveRun, item: ManifestItem) =>
  sourceMetadataForItem(run, item)?.governorate?.trim()
  || run.manifest.intake?.governorate?.trim()
  || "";

export const runInventoryKeys = (run: ArchiveRun) => {
  const keys = new Set(run.manifest.items.map((item) => itemInventoryKey(run, item)));
  for (const key of run.manifest.inventory_ids ?? []) keys.add(key);
  if (!keys.size) keys.add(runInventoryKey(run));
  return [...keys];
};

/**
 * Upgrade legacy name-owned runs to permanent inventory records. The operation
 * is pure so the IndexedDB migration can be regression-tested independently.
 */
export function migrateInventoryRecords(
  runs: ArchiveRun[],
  storedInventories: InventoryRecord[],
  createId: () => string,
  now = new Date().toISOString(),
): { runs: ArchiveRun[]; inventories: InventoryRecord[]; assigned: number } {
  const inventories = storedInventories.map((entry) => ({ ...entry, intake: { ...entry.intake } }));
  const byId = new Map(inventories.map((entry) => [entry.id, entry]));
  const byStorageKey = new Map(inventories.map((entry) => [entry.storageKey, entry]));
  const replacements = new Map<string, ArchiveRun>();
  let assigned = 0;

  const ordered = [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const run of ordered) {
    // Mixed runs already carry permanent ownership on each item. Treating their
    // batch-level intake as one legacy inventory would destroy that mapping.
    if (run.manifest.items.some((item) => item.inventory_id)) continue;
    const storageKey = canonicalRunStorageKey(run) || "__unassigned__";
    let inventory = run.manifest.inventory_id ? byId.get(run.manifest.inventory_id) : undefined;
    inventory ??= byStorageKey.get(storageKey);

    if (!inventory) {
      const intake = run.manifest.intake ?? {
        title: "", governorate: "", archaeologicalArea: "", storehouseName: "Unassigned storage",
        storeRegisterName: "", storeRegisterNumber: "", registerPageNumber: "", storeRegisterType: "",
        otherLanguage: "", institution: "", collection: "", language: "ar", documentType: "register", notes: "",
      };
      inventory = {
        id: createId(),
        storageKey,
        createdAt: run.createdAt || now,
        updatedAt: now,
        serialPrefix: storageSerialPrefix(runs.filter((candidate) => canonicalRunStorageKey(candidate) === storageKey), intake),
        nextSerial: 1,
        intake: { ...intake },
      };
      inventories.push(inventory);
      byId.set(inventory.id, inventory);
      byStorageKey.set(storageKey, inventory);
    }

    let highest = inventory.nextSerial - 1;
    for (const item of run.manifest.items) {
      const match = item.serial?.match(/^(.*)-(\d+)$/);
      const number = Number(match?.[2]);
      if (!inventory.serialPrefix && match?.[1]) inventory.serialPrefix = match[1];
      if (Number.isFinite(number)) highest = Math.max(highest, number);
    }
    inventory.nextSerial = Math.max(inventory.nextSerial, highest + 1);
    inventory.updatedAt = run.createdAt > inventory.updatedAt ? run.createdAt : inventory.updatedAt;

    if (run.manifest.inventory_id !== inventory.id || run.manifest.storage_key !== inventory.storageKey) {
      assigned += 1;
      replacements.set(run.id, { ...run, manifest: { ...run.manifest, inventory_id: inventory.id, storage_key: inventory.storageKey } });
    }
  }

  return { runs: runs.map((run) => replacements.get(run.id) ?? run), inventories, assigned };
}

/**
 * The physical-storage index shown in the inventory browser. Runs without
 * intake metadata remain accessible in one explicit unassigned inventory.
 */
export function listInventories(runs: ArchiveRun[], records: InventoryRecord[] = []): InventorySummary[] {
  const groups = new Map<string, ArchiveRun[]>();
  for (const record of records) groups.set(record.id, []);
  for (const run of runs) {
    for (const key of runInventoryKeys(run)) groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  return [...groups.entries()].map(([key, groupedRuns]) => {
    const ordered = [...groupedRuns].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const record = records.find((entry) => entry.id === key);
    const metadata = record?.intake ?? ordered.find((run) => run.manifest.intake)?.manifest.intake;
    const ownedItems = groupedRuns.flatMap((run) => run.manifest.items.filter((item) => itemInventoryKey(run, item) === key));
    const ownedCrops = groupedRuns.flatMap((run) => run.crops.filter((crop) => {
      const item = run.manifest.items[crop.itemIndex];
      return item ? itemInventoryKey(run, item) === key : false;
    }));
    const serials = ownedItems.map((item) => item.serial).filter((serial): serial is string => Boolean(serial))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    return {
      key,
      name: metadata?.storehouseName.trim() || "Unassigned storage",
      governorate: metadata?.governorate.trim() || "Location not recorded",
      archaeologicalArea: metadata?.archaeologicalArea.trim() || "",
      registerName: metadata?.storeRegisterName.trim() || "",
      registerNumber: metadata?.storeRegisterNumber.trim() || "",
      runs: ordered,
      artifactCount: ownedItems.length,
      plateCount: ownedCrops.length,
      bytes: ownedCrops.reduce((sum, crop) => sum + crop.blob.size, 0),
      firstSerial: serials[0] ?? null,
      lastSerial: serials.at(-1) ?? null,
      updatedAt: ordered[0]?.createdAt ?? record?.updatedAt ?? new Date(0).toISOString(),
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.governorate.localeCompare(right.governorate));
}

export function inventoryArtifacts(runs: ArchiveRun[], inventoryKey: string) {
  const rows = [];
  for (const run of runs) {
    for (const item of run.manifest.items) {
      if (itemInventoryKey(run, item) === inventoryKey) rows.push({ item, run });
    }
  }
  return rows.sort((left, right) => (left.item.serial ?? "").localeCompare(right.item.serial ?? "", undefined, { numeric: true })
    || left.run.createdAt.localeCompare(right.run.createdAt)
    || left.item.order - right.item.order);
}

/**
 * Repair only broken later sequences. Existing increasing numbers and gaps are
 * preserved; a duplicate, restart, missing number, or changed prefix is moved
 * to the next number owned by that storage.
 */
export function repairStorageSerialContinuity(runs: ArchiveRun[]): { runs: ArchiveRun[]; repaired: number } {
  const ordered = [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const state = new Map<string, { prefix: string; highest: number }>();
  const replacements = new Map<string, ArchiveRun>();
  let repaired = 0;

  for (const run of ordered) {
    let changed = false;
    const items = run.manifest.items.map((item) => {
      const key = item.inventory_id
        ? `inventory::${item.inventory_id}`
        : run.manifest.inventory_id
          ? `inventory::${run.manifest.inventory_id}`
          : canonicalRunStorageKey(run);
      if (!key) return item;
      const current = state.get(key) ?? { prefix: "", highest: 0 };
      const match = item.serial?.match(/^(.*)-(\d+)$/);
      const prefix = match?.[1] ?? "";
      const number = Number(match?.[2]);
      if (!current.prefix && prefix) current.prefix = prefix;
      if (!current.prefix && run.manifest.intake) current.prefix = defaultStorageSerialPrefix(run.manifest.intake);
      const continues = Boolean(match)
        && Number.isFinite(number)
        && number > current.highest
        && (!current.prefix || prefix === current.prefix);
      if (continues) {
        current.highest = number;
        state.set(key, current);
        return item;
      }

      current.highest += 1;
      state.set(key, current);
      changed = true;
      repaired += 1;
      return { ...item, serial: `${current.prefix || "STORE"}-${String(current.highest).padStart(4, "0")}` };
    });
    if (changed) replacements.set(run.id, { ...run, manifest: { ...run.manifest, items } });
  }

  return { runs: runs.map((run) => replacements.get(run.id) ?? run), repaired };
}

export function listSeries(runs: ArchiveRun[]): Array<{ name: string; runs: number; artifacts: number; plates: number; bytes: number }> {
  const map = new Map<string, { name: string; runs: number; artifacts: number; plates: number; bytes: number }>();
  for (const run of runs) {
    const name = runSeries(run);
    const entry = map.get(name) ?? { name, runs: 0, artifacts: 0, plates: 0, bytes: 0 };
    entry.runs += 1;
    entry.artifacts += run.manifest.items.length;
    entry.plates += run.crops.length;
    for (const crop of run.crops) entry.bytes += crop.blob.size;
    map.set(name, entry);
  }
  return [...map.values()].sort((left, right) => right.artifacts - left.artifacts || left.name.localeCompare(right.name));
}

/** Every artefact across every run in a series, in serial order. */
export function seriesArtifacts(runs: ArchiveRun[], series: string | null) {
  const rows = [];
  for (const run of runs) {
    if (series && runSeries(run) !== series) continue;
    for (const item of run.manifest.items) {
      rows.push({ item, run, series: runSeries(run) });
    }
  }
  return rows.sort((left, right) => (left.item.serial ?? "").localeCompare(right.item.serial ?? "")
    || left.run.createdAt.localeCompare(right.run.createdAt)
    || left.item.order - right.item.order);
}
