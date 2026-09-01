"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AccountMenu from "./account-menu";
import ArchiveView, { ArchiveMode, ArchiveSort } from "./views/archive-view";
import InventoriesView from "./views/inventories-view";
import TaxonomyView from "./views/taxonomy-view";
import SettingsView from "./views/settings-view";
import IntakeView from "./views/intake-view";
import ManualCropEditor from "./manual-crop-editor";
import { tableToCsv } from "./views/result-table";
import {
  AnalysisResult, ArchiveRun, Asset, BatchRelationship, CropFormat, IntakeMetadata, InventoryRecord, SourceAssignmentDraft,
  RunOptions, RunStatus, SystemStatus, TaskId, ViewId,
  artifactDisplaySerial, batchRelationshipLabel, defaultRunOptions, formatDate, formatSize, matchPlateAssignments, normalizeWrittenSerial,
  UNFILED, listInventories, listSeries, nextStorageSerial as calculateNextStorageSerial, runSeries, seriesSlug,
} from "./types";
import {
  archiveSerialNumber, clearArchiveStore, deleteArchiveRun, getArchiveRun, loadArchiveRuns, migrateArchiveDatabase,
  renumberArchiveRun, saveArchiveRun, sealArchiveRun, seedStarterInventories,
} from "./archive-db";
import { buildArchiveRun } from "./crops";
import {
  buildSeriesCsv, buildSeriesManifest, directoryPicker, downloadBlob, writeRunToDirectory, writeSeriesToDirectory,
} from "./export";

type ViewScale = "fit" | number;
type ControlGroup = "detection" | "archiving" | null;
const EXTRACTION_INSTRUCTION = "Find every pasted or mounted photographic image panel containing an artifact. Include small, dark, or low-contrast photographs, but require a distinct rectangular photo or mounting-paper boundary. Exclude handwriting, printed cells, labels, page stamps, circular seals inked directly on the register, and the page itself. Do not merge touching photographs.";

const SETTINGS_KEY = "seshat-settings-v1";
const INTAKE_DEFAULTS_KEY = "seshat-intake-defaults-v1";
// A cold catalogue run reads six register columns twice over. The ceiling sits
// well above that, so only a genuinely stalled service trips it.
const RUN_TIMEOUT_MS = 15 * 60_000;
const MAX_SOURCE_FILES = 12;
const MAX_SOURCE_BYTES = 14 * 1024 * 1024;
const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
const emptyIntake: IntakeMetadata = {
  title: "", governorate: "", archaeologicalArea: "", storehouseName: "", storeRegisterName: "",
  storeRegisterNumber: "", registerPageNumber: "", storeRegisterType: "", otherLanguage: "",
  institution: "", collection: "",
  language: "ar", documentType: "register", batchRelationship: "same_register", notes: "",
};
const fileLabel = (asset: Asset) => asset.type.startsWith("image/") ? "IMAGE" : asset.type.includes("pdf") ? "PDF" : asset.name.split(".").pop()?.toUpperCase() || "FILE";

export const enhancementLabels: Record<string, { title: string; method: string; status: string }> = {
  original: { title: "Original crop", method: "Unprocessed source pixels", status: "Source evidence" },
  opencv: { title: "OpenCV cleanup", method: "Illumination removal, CLAHE, denoise and sharpening", status: "Evidence-preserving" },
  swinir: { title: "Neural preview (SwinIR ×2)", method: "Synthetic comparison only — excluded from OCR", status: "Not transcription evidence" },
};

export type CellView = {
  row: number;
  column: number;
  columnLabel: string;
  bbox: number[];
  warning: string | null;
  views: Array<{ kind: string; imageUrl: string }>;
};

// The reading aid. At this scan resolution a person transcribing by hand is the
// realistic path, so the point of this panel is legibility for an eye — never a
// reading the machine is allowed to keep.
export function CellViewer({ view, loading, onClose }: { view: CellView | null; loading: boolean; onClose: () => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (!view && !loading) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [view, loading, onClose]);
  if (!view && !loading) return null;
  // Derived rather than synchronised: each cell offers whatever views the
  // service could build, and the clearest one is last.
  const available = view?.views ?? [];
  const shown = available.find((entry) => entry.kind === chosen) ?? available[available.length - 1];
  const kind = shown?.kind;
  return <div className="enhancement-lightbox" role="dialog" aria-modal="true" aria-labelledby="cell-view-title">
    <button type="button" className="enhancement-lightbox-scrim" aria-label="Close the cell view" onClick={onClose} />
    <div className="enhancement-lightbox-panel">
      <header>
        <div>
          <span>Reading aid · not transcription evidence</span>
          <h3 id="cell-view-title">{loading || !view ? "Enlarging the cell…" : `Row ${view.row + 1} · ${view.columnLabel}`}</h3>
          {view && <p>source [{view.bbox.join(", ")}]</p>}
        </div>
        <button type="button" className="enhancement-close" onClick={onClose} aria-label="Close the cell view">×</button>
      </header>
      <div className="enhancement-lightbox-image">
        {loading || !shown
          ? <p className="empty-note">Cleaning and enlarging this cell…</p>
          : <img src={shown.imageUrl} alt={`Register row ${view!.row + 1}, ${view!.columnLabel}, enlarged`} />}
      </div>
      <footer>
        {view && <div className="provider-toggle" role="group" aria-label="Cell view">
          {view.views.map((entry) => <button
            key={entry.kind}
            className={entry.kind === kind ? "active" : ""}
            aria-pressed={entry.kind === kind}
            onClick={() => setChosen(entry.kind)}
          >{enhancementLabels[entry.kind]?.title ?? entry.kind}</button>)}
        </div>}
        <p>Read the hand here, then type it into the cell. The restored view may invent strokes, so what you type is the record — nothing here is transcribed for you.</p>
      </footer>
    </div>
  </div>;
}

export function EnhancementReference({ preview }: { preview: NonNullable<AnalysisResult["enhancement_preview"]> }) {
  type PreviewVariant = (typeof preview.variants)[number];
  const [selectedVariant, setSelectedVariant] = useState<PreviewVariant | null>(null);
  const [showSynthetic, setShowSynthetic] = useState(false);
  const syntheticCount = preview.variants.filter((variant) => variant.kind === "swinir").length;
  const visibleVariants = preview.variants.filter((variant) => variant.kind !== "swinir" || showSynthetic);
  const selectedLabel = selectedVariant
    ? enhancementLabels[selectedVariant.kind] ?? { title: selectedVariant.kind, method: "Processed view", status: "Review" }
    : null;

  useEffect(() => {
    if (!selectedVariant) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedVariant(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedVariant]);

  return <section className="enhancement-proof" aria-labelledby="enhancement-reference-title">
    <header>
      <div>
        <h3 id="enhancement-reference-title">Enhancement reference</h3>
        <p>Original and OpenCV are the transcription evidence. Neural restoration is hidden by default because it can invent Arabic dots, joins, and stroke endings.</p>
        {syntheticCount > 0 && <button
          type="button"
          className="synthetic-toggle"
          aria-pressed={showSynthetic}
          onClick={() => {
            setSelectedVariant(null);
            setShowSynthetic((current) => !current);
          }}
        >{showSynthetic ? "Hide neural preview" : "Show neural preview (not OCR evidence)"}</button>}
      </div>
      <dl>
        <div><dt>Source cell</dt><dd>Row {preview.row + 1} · {preview.columnLabel}</dd></div>
        <div><dt>Original pixels</dt><dd>[{preview.bbox.join(", ")}] of {preview.sourceWidth} × {preview.sourceHeight}</dd></div>
      </dl>
    </header>
    <div className="enhancement-comparison">
      {visibleVariants.map((variant) => {
        const label = enhancementLabels[variant.kind] ?? { title: variant.kind, method: "Processed view", status: "Review" };
        return <figure key={variant.kind} className={`enhancement-variant ${variant.kind === "swinir" ? "is-restored" : ""}`}>
          <button type="button" className="enhancement-open" onClick={() => setSelectedVariant(variant)} aria-label={`Open full-size ${label.title}`}>
            <img src={variant.imageUrl} alt={`${label.title} of register row ${preview.row + 1}, ${preview.columnLabel}`} />
          </button>
          <figcaption>
            <span>{label.status}</span>
            <strong>{label.title}</strong>
            <small>{label.method}</small>
            {variant.width && variant.height && <small className="enhancement-dimensions">{variant.width} × {variant.height} px{variant.scale && variant.scale > 1 ? ` · ${variant.scale}× source raster` : " · source size"}</small>}
            {variant.kind === "swinir" && <em>May invent strokes · never sent to handwriting OCR</em>}
          </figcaption>
        </figure>;
      })}
    </div>
    {selectedVariant && selectedLabel && <div
      className="enhancement-lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enhancement-lightbox-title"
    >
      {/* A real button behind the panel, so dismissing by clicking away is
          reachable from the keyboard too, not only with a pointer. */}
      <button
        type="button"
        className="enhancement-lightbox-scrim"
        aria-label="Close full-size image"
        onClick={() => setSelectedVariant(null)}
      />
      <div className="enhancement-lightbox-panel">
        <header>
          <div>
            <span>{selectedLabel.status}</span>
            <h3 id="enhancement-lightbox-title">{selectedLabel.title}</h3>
            <p>Register row {preview.row + 1} · {preview.columnLabel} · source [{preview.bbox.join(", ")}]</p>
            {selectedVariant.width && selectedVariant.height && <b>{selectedVariant.width} × {selectedVariant.height} pixels{selectedVariant.scale && selectedVariant.scale > 1 ? ` · ${selectedVariant.scale}× source raster` : " · native source size"}</b>}
          </div>
          <button type="button" className="enhancement-close" onClick={() => setSelectedVariant(null)} aria-label="Close full-size image">×</button>
        </header>
        <div className="enhancement-lightbox-image">
          <img src={selectedVariant.imageUrl} alt={`Full-size ${selectedLabel.title} of register row ${preview.row + 1}`} />
        </div>
        <footer>
          <p>{selectedLabel.method}{selectedVariant.kind === "swinir" ? ". It may invent strokes and is never sent to handwriting OCR." : "."}</p>
          <a href={selectedVariant.imageUrl} download={`seshat-row-${preview.row + 1}-${selectedVariant.kind}.png`}>Download PNG</a>
        </footer>
      </div>
    </div>}
  </section>;
}

// Settings are read during state initialization rather than in an effect: the
// stored values never reach the server-rendered markup, so there is nothing to
// mismatch during hydration.
function readStoredSettings(): { options: RunOptions; series: string } {
  const empty = { options: defaultRunOptions, series: UNFILED };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as { options?: Partial<RunOptions>; series?: string };
    return {
      options: { ...defaultRunOptions, ...parsed.options, provider: "gemini" },
      series: typeof parsed.series === "string" && parsed.series.trim() ? parsed.series : UNFILED,
    };
  } catch {
    return empty;
  }
}

function readIntakeDefaults(): IntakeMetadata {
  if (typeof window === "undefined") return emptyIntake;
  try {
    const raw = window.localStorage.getItem(INTAKE_DEFAULTS_KEY);
    return raw ? { ...emptyIntake, ...JSON.parse(raw) as Partial<IntakeMetadata> } : emptyIntake;
  } catch {
    return emptyIntake;
  }
}

async function readSystemStatus(): Promise<SystemStatus> {
  const response = await fetch("/api/system");
  if (!response.ok) throw new Error(`The status check returned ${response.status}.`);
  return await response.json() as SystemStatus;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewsRef = useRef<string[]>([]);
  const cropPreviewsRef = useRef<string[]>([]);
  const previewStageRef = useRef<HTMLDivElement>(null);
  const cropUrlsRef = useRef<string[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<ViewId>("workbench");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const task: TaskId = "extract";
  const instruction = EXTRACTION_INSTRUCTION;
  const [status, setStatus] = useState<RunStatus>("ready");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [modelName, setModelName] = useState("qwen2.5vl:7b");
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [savedRun, setSavedRun] = useState<ArchiveRun | null>(null);
  const [serialStartDraft, setSerialStartDraft] = useState("");
  const [archiveRuns, setArchiveRuns] = useState<ArchiveRun[]>([]);
  const [inventoryRecords, setInventoryRecords] = useState<InventoryRecord[]>([]);
  const [cropPreviews, setCropPreviews] = useState<Record<number, string>>({});
  const [cropEditorOpen, setCropEditorOpen] = useState(false);
  const [cropCorrectionsDirty, setCropCorrectionsDirty] = useState(false);
  const [cropUrls, setCropUrls] = useState<Record<string, string>>({});
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const [exportMessage, setExportMessage] = useState("");
  const [archiveMessage, setArchiveMessage] = useState("");
  const [clearMessage, setClearMessage] = useState("");
  const [viewScale, setViewScale] = useState<ViewScale>("fit");
  const [viewerFocused, setViewerFocused] = useState(false);
  const [fittedSize, setFittedSize] = useState<{ width: number; height: number } | null>(null);
  const [options, setOptions] = useState<RunOptions>(() => readStoredSettings().options);
  const [series, setSeries] = useState(() => readStoredSettings().series);
  const [openControls, setOpenControls] = useState<ControlGroup>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveSort, setArchiveSort] = useState<ArchiveSort>("newest");
  const [archiveMode, setArchiveMode] = useState<ArchiveMode>("collections");
  const [seriesFilter, setSeriesFilter] = useState("");
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openInventoryKey, setOpenInventoryKey] = useState<string | null>(null);
  const [selectedInventoryId, setSelectedInventoryId] = useState<string | null>(null);
  const [sourceAssignments, setSourceAssignments] = useState<Record<string, SourceAssignmentDraft>>({});
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intake, setIntake] = useState<IntakeMetadata>(() => readIntakeDefaults());

  const seriesList = useMemo(() => listSeries(archiveRuns), [archiveRuns]);
  const inventoryList = useMemo(() => listInventories(archiveRuns, inventoryRecords), [archiveRuns, inventoryRecords]);
  const seriesNames = useMemo(() => {
    const names = new Set(seriesList.map((entry) => entry.name));
    names.add(UNFILED);
    if (series.trim()) names.add(series.trim());
    return [...names].sort();
  }, [seriesList, series]);
  const intakeInventory = useMemo(() => selectedInventoryId
    ? inventoryRecords.find((entry) => entry.id === selectedInventoryId) ?? null
    : null, [inventoryRecords, selectedInventoryId]);
  const nextStorageSerial = useMemo(
    () => intakeInventory
      ? `${intakeInventory.serialPrefix}-${String(intakeInventory.nextSerial).padStart(4, "0")}`
      : calculateNextStorageSerial(archiveRuns, intake),
    [archiveRuns, intake, intakeInventory],
  );
  const refreshStatus = useCallback(async () => {
    setStatusLoading(true); setStatusError("");
    try {
      setSystemStatus(await readSystemStatus());
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "The status check failed.");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // One object URL per stored crop, rebuilt whenever the archive reloads. Doing
  // this at load time keeps the URLs out of render and out of an effect, so
  // they are created exactly once per blob.
  const applyRuns = useCallback((runs: ArchiveRun[]) => {
    cropUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    const created: string[] = [];
    const map: Record<string, string> = {};
    const sourceMap: Record<string, string> = {};
    for (const run of runs) {
      for (const crop of run.crops) {
        const url = URL.createObjectURL(crop.blob);
        map[`${run.id}::${crop.name}`] = url;
        created.push(url);
      }
      for (const source of run.sources ?? []) {
        const url = URL.createObjectURL(source.blob);
        sourceMap[`${run.id}::source::${source.sourceIndex}`] = url;
        created.push(url);
      }
    }
    cropUrlsRef.current = created;
    setArchiveRuns(runs);
    setCropUrls(map);
    setSourceUrls(sourceMap);
  }, []);

  useEffect(() => {
    seedStarterInventories().then(async (seeded) => ({ seeded, migration: await migrateArchiveDatabase() })).then(({ seeded, migration }) => {
      setInventoryRecords(migration.inventories);
      if (seeded || migration.repaired || migration.assigned) {
        const messages = [];
        if (seeded) messages.push(`added ${seeded} empty starter inventor${seeded === 1 ? "y" : "ies"}`);
        if (migration.assigned) messages.push(`linked ${migration.assigned} saved page${migration.assigned === 1 ? "" : "s"} to permanent inventory IDs`);
        if (migration.repaired) messages.push(`repaired ${migration.repaired} restarted serial${migration.repaired === 1 ? "" : "s"}`);
        setArchiveMessage(`${messages.join(" and ")}.`);
      }
      applyRuns(migration.runs);
    }).catch(() => applyRuns([]));

    // The status is worth re-checking: services get restarted underneath a page
    // that is already open, and a stale red pill is worse than no pill.
    const probe = () => readSystemStatus()
      .then((status) => { setSystemStatus(status); setStatusError(""); })
      .catch((error: unknown) => setStatusError(error instanceof Error ? error.message : "The status check failed."));
    probe();
    const timer = window.setInterval(probe, 60_000);
    window.addEventListener("focus", probe);
    const previews = previewsRef.current;
    const resultPreviews = cropPreviewsRef.current;
    const archiveUrls = cropUrlsRef.current;
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", probe);
      [...previews, ...resultPreviews, ...archiveUrls].forEach((url) => URL.revokeObjectURL(url));
    };
  }, [applyRuns]);

  useEffect(() => {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ options: { ...options, provider: "gemini" }, series })); } catch { /* storage may be full or blocked */ }
  }, [options, series]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
    window.scrollTo({ top: 0, left: 0 });
  }, [view, intakeOpen, assets.length]);

  useEffect(() => {
    if (!viewerFocused) return;
    const closeFocusedViewer = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewerFocused(false);
    };
    window.addEventListener("keydown", closeFocusedViewer);
    return () => window.removeEventListener("keydown", closeFocusedViewer);
  }, [viewerFocused]);

  // A catalogue run drives twelve model passes over the isolated cells. Without
  // a clock on screen a legitimate multi-minute run is indistinguishable from a
  // hang, so the elapsed time keeps ticking for as long as the run is in flight.
  useEffect(() => {
    if (runStartedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - runStartedAt);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [runStartedAt]);

  const selected = assets.find((item) => item.id === selectedId) ?? assets[0];
  const totalSize = useMemo(() => assets.reduce((sum, item) => sum + item.size, 0), [assets]);
  const archiveBytes = useMemo(() => archiveRuns.reduce((sum, run) => sum + run.crops.reduce((inner, crop) => inner + crop.blob.size, 0), 0), [archiveRuns]);
  const archiveImages = useMemo(() => archiveRuns.reduce((sum, run) => sum + run.crops.length, 0), [archiveRuns]);
  const categoryCount = useMemo(() => {
    const names = new Set<string>();
    for (const run of archiveRuns) for (const item of run.manifest.items) if (item.category) names.add(item.category.toLowerCase());
    return names.size;
  }, [archiveRuns]);

  const changeViewScale = (step: number) => setViewScale((current) => {
    const base = current === "fit" ? 1 : current;
    return Math.max(0.25, Math.min(2, Math.round((base + step) * 4) / 4));
  });

  useEffect(() => {
    const stage = previewStageRef.current;
    const sourceWidth = selected?.width;
    const sourceHeight = selected?.height;
    if (!stage || !sourceWidth || !sourceHeight) {
      setFittedSize(null);
      return;
    }
    const fitDocument = () => {
      const styles = window.getComputedStyle(stage);
      const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
      const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
      const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
      setFittedSize({ width: Math.floor(sourceWidth * scale), height: Math.floor(sourceHeight * scale) });
    };
    fitDocument();
    const observer = new ResizeObserver(fitDocument);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [selected?.id, selected?.width, selected?.height, viewerFocused, view]);

  const resetResult = () => {
    cropPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url)); cropPreviewsRef.current = [];
    setCropPreviews({}); setResult(null); setSavedRun(null); setSerialStartDraft(""); setExportMessage(""); setAnalysisError(null); setStatus("ready");
    setCropEditorOpen(false); setCropCorrectionsDirty(false);
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const startsNewIntake = assets.length === 0;
    const candidates = await Promise.all(files.map(async (file) => {
      try {
        const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return { file, digest };
      } catch {
        return { file, digest: `${file.name}:${file.size}:${file.lastModified}` };
      }
    }));
    const existing = new Set(assets.map((asset) => asset.digest ?? `${asset.name}:${asset.size}:${asset.file.lastModified}`));
    const rejected: string[] = [];
    const unique = candidates.filter(({ file, digest }) => {
      if (existing.has(digest)) {
        rejected.push(`${file.name} نسخة مطابقة لصورة موجودة ولم تُضف مرة أخرى`);
        return false;
      }
      existing.add(digest);
      if (file.size > MAX_SOURCE_BYTES) {
        rejected.push(`${file.name} أكبر من الحد المسموح 14 ميجابايت`);
        return false;
      }
      if (!file.type.startsWith("image/") && !file.type.startsWith("text/") && !/\.(txt|md|csv|json|xml)$/i.test(file.name)) {
        rejected.push(`${file.name} ليس صورة أو ملف نص مدعومًا`);
        return false;
      }
      return true;
    });
    const room = Math.max(0, MAX_SOURCE_FILES - assets.length);
    const accepted = unique.slice(0, room);
    if (unique.length > room) rejected.push(`تجاوز ${unique.length - room} من الملفات الحد الأقصى وهو ${MAX_SOURCE_FILES} مصدرًا`);
    if (!accepted.length) {
      setUploadMessage(rejected.join(". ") || `تحتوي هذه الدفعة بالفعل على ${MAX_SOURCE_FILES} مصدرًا.`);
      return;
    }
    const next = await Promise.all(accepted.map(async ({ file, digest }) => {
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (preview) previewsRef.current.push(preview);
      let width: number | undefined;
      let height: number | undefined;
      if (file.type.startsWith("image/")) {
        try {
          const image = await createImageBitmap(file);
          width = image.width; height = image.height; image.close();
        } catch {
          rejected.push(`تعذّر عرض معاينة ${file.name}`);
        }
      }
      return { id: crypto.randomUUID(), name: file.name, type: file.type || "application/octet-stream", size: file.size, preview, width, height, digest, file };
    }));
    setView("workbench");
    setAssets((current) => [...current, ...next]); setSelectedId(next[0].id); resetResult();
    setUploadMessage(`تمت إضافة ${next.length} من صور المصدر${rejected.length ? `. ${rejected.join(". ")}.` : "."}`);
    if (startsNewIntake) {
      const suggestedTitle = next[0].name.replace(/\.[^.]+$/, "");
      setIntake((current) => ({ ...current, title: current.title.trim() || suggestedTitle }));
      setSelectedInventoryId(null);
      setIntakeOpen(true);
    }
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addFiles(files); };
  const handleDrop = (event: DragEvent<HTMLElement>) => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); };
  const openFilePicker = () => {
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };
  const removeAsset = (id: string) => {
    const target = assets.find((item) => item.id === id); if (target?.preview) URL.revokeObjectURL(target.preview);
    const next = assets.filter((item) => item.id !== id); setAssets(next); if (selectedId === id) setSelectedId(next[0]?.id ?? null); resetResult();
    setSourceAssignments((current) => { const nextAssignments = { ...current }; delete nextAssignments[id]; return nextAssignments; });
  };
  const moveAsset = (id: string, direction: -1 | 1) => {
    setAssets((current) => {
      const index = current.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    resetResult();
  };
  const newWorkspace = () => {
    previewsRef.current.forEach((url) => URL.revokeObjectURL(url)); previewsRef.current = [];
    setAssets([]); setSelectedId(null); resetResult(); setUploadMessage(""); setSidebarOpen(false); setView("workbench"); setIntake(readIntakeDefaults()); setSelectedInventoryId(null); setSourceAssignments({}); setIntakeOpen(false);
  };
  const updateOptions = (patch: Partial<RunOptions>) => setOptions((current) => ({ ...current, ...patch }));
  const clearInventoryDetails = (current: IntakeMetadata, governorate = current.governorate): IntakeMetadata => ({
    ...current,
    governorate,
    archaeologicalArea: "",
    storehouseName: "",
    storeRegisterName: "",
    storeRegisterNumber: "",
    storeRegisterType: "",
  });
  const chooseGovernorate = (governorate: string) => {
    setSelectedInventoryId(null);
    setIntake((current) => clearInventoryDetails(current, governorate));
  };
  const chooseInventory = (id: string) => {
    if (!id) {
      setSelectedInventoryId(null);
      setIntake((current) => clearInventoryDetails(current));
      return;
    }
    setSelectedInventoryId(id);
    const record = inventoryRecords.find((candidate) => candidate.id === id);
    if (!record) return;
    setIntake((current) => ({ ...current, ...record.intake, title: current.title, registerPageNumber: current.registerPageNumber, notes: current.notes }));
  };
  const chooseBatchRelationship = (relationship: BatchRelationship) => {
    setIntake((current) => ({ ...current, batchRelationship: relationship }));
    if (relationship !== "mixed" && relationship !== "same_governorate") return;
    setSourceAssignments((current) => {
      const next = { ...current };
      for (const asset of assets) {
        if (!next[asset.id]) next[asset.id] = {
          governorate: intakeInventory?.intake.governorate ?? "",
          inventoryId: intakeInventory?.id ?? "",
        };
      }
      return next;
    });
  };
  const chooseSourceGovernorate = (assetId: string, governorate: string) => {
    setSourceAssignments((current) => ({ ...current, [assetId]: { governorate, inventoryId: "" } }));
  };
  const chooseSourceInventory = (assetId: string, inventoryId: string) => {
    const record = inventoryRecords.find((candidate) => candidate.id === inventoryId);
    setSourceAssignments((current) => ({
      ...current,
      [assetId]: { governorate: record?.intake.governorate ?? current[assetId]?.governorate ?? "", inventoryId },
    }));
  };

  const persistResult = async (currentResult: AnalysisResult, usedModel: string, existing?: ArchiveRun) => {
    const draft = await buildArchiveRun(currentResult, assets, task, usedModel, options, series, intake, existing);
    const relationship = intake.batchRelationship ?? "same_register";
    const assignsSourcesIndividually = assets.length > 1 && (relationship === "mixed" || relationship === "same_governorate");
    const sourceInventoryIds = assignsSourcesIndividually ? Object.fromEntries(assets.map((asset, index) => [index, sourceAssignments[asset.id]?.inventoryId ?? ""])) : undefined;
    const preparedDraft = assignsSourcesIndividually ? {
      ...draft,
      manifest: {
        ...draft.manifest,
        sources: draft.manifest.sources.map((source, index) => {
          const inventoryId = sourceInventoryIds?.[index];
          const owner = inventoryRecords.find((entry) => entry.id === inventoryId);
          return {
            ...source,
            inventory_id: inventoryId,
            governorate: owner?.intake.governorate,
            archaeological_area: owner?.intake.archaeologicalArea,
            storehouse_name: owner?.intake.storehouseName,
          };
        }),
      },
    } : draft;
    const sealed = await sealArchiveRun(preparedDraft, intake, selectedInventoryId, sourceInventoryIds);
    const run = sealed.run;
    setSelectedInventoryId(sealed.inventory.id);
    cropPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url));
    cropPreviewsRef.current = [];
    const previews: Record<number, string> = {};
    run.crops.forEach((crop) => {
      const url = URL.createObjectURL(crop.blob);
      cropPreviewsRef.current.push(url);
      previews[crop.itemIndex] = url;
    });
    setCropPreviews(previews);
    setSavedRun(run);
    setResult({
      ...currentResult,
      items: currentResult.items.map((item, index) => {
        const archived = run.manifest.items[index];
        return archived ? {
          ...item,
          id: archived.id,
          serial: archived.serial,
          display_serial: archived.display_serial,
          inventory_id: archived.inventory_id,
        } : item;
      }),
    });
    setCropCorrectionsDirty(false);
    setSerialStartDraft(String(archiveSerialNumber(run.manifest.items[0]?.serial) ?? ""));
    const state = await migrateArchiveDatabase();
    setInventoryRecords(state.inventories);
    applyRuns(state.runs);
    return run;
  };

  const runAnalysis = async () => {
    if (!assets.length || status === "running" || status === "saving") return;
    setStatus("running"); setResult(null); setSavedRun(null); setSerialStartDraft(""); setAnalysisError(null); setDurationMs(null);
    setRunStartedAt(Date.now()); setElapsedMs(0);
    const form = new FormData();
    form.set("task", task);
    form.set("instruction", instruction);
    form.set("provider", "auto");
    form.set("detector_prompt", options.detectorPrompt);
    form.set("box_threshold", String(options.boxThreshold));
    form.set("text_threshold", String(options.textThreshold));
    form.set("image_dimensions", JSON.stringify(assets.filter((asset) => asset.type.startsWith("image/")).map(({ width, height }) => ({ width, height }))));
    assets.forEach((asset) => form.append("files", asset.file, asset.name));
    try {
      // A bounded deadline, so a request that never comes back surfaces as an
      // error the operator can act on instead of a spinner that runs forever.
      const response = await fetch("/api/analyze", { method: "POST", body: form, signal: AbortSignal.timeout(RUN_TIMEOUT_MS) });
      const payload = await response.json() as { error?: string; warnings?: string[]; model?: string; provider?: string; raw?: string; duration_ms?: number; result?: AnalysisResult };
      if (!response.ok || !payload.result) throw new Error(`${payload.error || "The extraction service did not return a result."}${payload.warnings?.length ? ` ${payload.warnings.join(" ")}` : ""}`);
      const usedModel = payload.model || "automatic";
      setResult(payload.result); setModelName(usedModel); setDurationMs(payload.duration_ms ?? null);
      setStatus("saving");
      await persistResult(payload.result, usedModel);
      setStatus("complete");
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      setAnalysisError(timedOut
        ? `The run passed ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes without a reply and was stopped. The services are probably still busy — re-check them in Settings before running again.`
        : error instanceof Error ? error.message : "Unknown local model error.");
      setStatus("error");
    } finally {
      setRunStartedAt(null);
    }
  };

  const repairCrops = async () => {
    if (!result || !savedRun) return;
    setStatus("saving"); setAnalysisError(null);
    try {
      const repaired = await persistResult(result, modelName, savedRun);
      if (!repaired.crops.length) throw new Error("The bounding boxes could not be converted into image crops.");
      setStatus("complete");
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Could not repair the extracted images.");
      setStatus("error");
    }
  };

  const exportRun = async (runId?: string) => {
    setExportMessage(""); setArchiveMessage("");
    if (cropCorrectionsDirty && (!runId || runId === savedRun?.id)) {
      setExportMessage("احفظ تصحيحات القصاصات قبل التصدير.");
      return;
    }
    try {
      const run = savedRun?.id === runId || (!runId && savedRun) ? savedRun : runId ? await getArchiveRun(runId) : undefined;
      if (!run) throw new Error("No saved archive is available to export.");
      const picker = directoryPicker();
      if (picker) {
        const written = await writeRunToDirectory(await picker({ mode: "readwrite" }), run);
        const report = `Exported ${written} images and manifest.json to ${run.id}.`;
        setExportMessage(report); setArchiveMessage(report);
      } else {
        downloadBlob(`${run.id}-manifest.json`, new Blob([JSON.stringify(run.manifest, null, 2)], { type: "application/json" }));
        run.crops.forEach((crop) => downloadBlob(crop.name, crop.blob));
        const fallback = `Downloaded ${run.crops.length} images and the manifest.`;
        setExportMessage(fallback); setArchiveMessage(fallback);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "Export failed.";
      setExportMessage(message); setArchiveMessage(message);
    }
  };

  const exportSeries = async (name: string) => {
    setArchiveMessage("");
    try {
      const runs = archiveRuns.filter((run) => runSeries(run) === name);
      if (!runs.length) throw new Error("That series has no collections yet.");
      const slug = seriesSlug(name);
      const exportedAt = new Date().toISOString();
      const picker = directoryPicker();
      if (picker) {
        const plateCount = await writeSeriesToDirectory(await picker({ mode: "readwrite" }), runs, name, slug, exportedAt);
        const artifactCount = buildSeriesManifest(runs, name, exportedAt).artifact_count;
        setArchiveMessage(`Exported ${artifactCount} artefacts and ${plateCount} plates from ${runs.length} page${runs.length === 1 ? "" : "s"} into ${slug}.`);
      } else {
        downloadBlob(`${slug}-series.json`, new Blob([JSON.stringify(buildSeriesManifest(runs, name, exportedAt), null, 2)], { type: "application/json" }));
        downloadBlob(`${slug}-catalogue.csv`, new Blob([buildSeriesCsv(runs, name)], { type: "text/csv;charset=utf-8" }));
        setArchiveMessage(`Downloaded the ${name} catalogue. Use a Chromium browser to export plates into a folder.`);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setArchiveMessage(error instanceof Error ? error.message : "The series export failed.");
    }
  };

  const moveRunToSeries = async (id: string, name: string) => {
    const run = archiveRuns.find((entry) => entry.id === id);
    if (!run || !name.trim()) return;
    const target = name.trim();
    await saveArchiveRun({ ...run, series: target, manifest: { ...run.manifest, series: target } });
    applyRuns(await loadArchiveRuns());
    setArchiveMessage(`Moved to “${target}”.`);
  };

  const removeRun = async (id: string) => {
    await deleteArchiveRun(id);
    if (savedRun?.id === id) { setSavedRun(null); setSerialStartDraft(""); }
    if (openRunId === id) setOpenRunId(null);
    applyRuns(await loadArchiveRuns());
    setArchiveMessage("Collection removed from this browser.");
  };

  const renameRun = async (id: string, label: string) => {
    const run = archiveRuns.find((entry) => entry.id === id);
    if (!run || !label.trim()) return;
    await saveArchiveRun({ ...run, label: label.trim() });
    applyRuns(await loadArchiveRuns());
    setArchiveMessage("Collection renamed.");
  };

  // Human-in-the-loop correction: whatever the operator types wins over the
  // model, and travels with the collection into manifest.json.
  const saveTranscription = async (id: string, text: string) => {
    const run = archiveRuns.find((entry) => entry.id === id);
    if (!run) return;
    const trimmed = text.trim();
    await saveArchiveRun({ ...run, manifest: { ...run.manifest, transcription: trimmed ? text : null } });
    applyRuns(await loadArchiveRuns());
    setArchiveMessage(trimmed ? "Transcription saved to the local archive." : "Transcription cleared.");
  };

  const setRowPlate = async (id: string, rowIndex: number, file: string | null) => {
    const run = archiveRuns.find((entry) => entry.id === id);
    if (!run?.manifest.table) return;
    const auto = matchPlateAssignments(run.manifest.items, run.manifest.table);
    const current = { ...(run.manifest.table_plates ?? {}) };
    // Store only an operator override. Selecting the automatic match again
    // removes the override and restores its serial/position provenance.
    if (file && file !== auto[String(rowIndex)]?.file) current[String(rowIndex)] = file;
    else delete current[String(rowIndex)];
    await saveArchiveRun({ ...run, manifest: { ...run.manifest, table_plates: current } });
    applyRuns(await loadArchiveRuns());
  };

  const setTableCell = async (id: string, rowIndex: number, columnIndex: number, value: string) => {
    const run = archiveRuns.find((entry) => entry.id === id);
    if (!run?.manifest.table?.rows[rowIndex]) return;
    const rows = run.manifest.table.rows.map((row) => [...row]);
    rows[rowIndex][columnIndex] = value;
    const correctedKey = `${rowIndex}:${columnIndex}`;
    const reviewCells = run.manifest.table.review_cells?.filter((key) => key !== correctedKey);
    const alternatives = run.manifest.table.alternatives?.filter((entry) => entry.row !== rowIndex || entry.column !== columnIndex);
    const humanCells = [...new Set([...(run.manifest.table.human_cells ?? []), correctedKey])];
    await saveArchiveRun({
      ...run,
      manifest: {
        ...run.manifest,
        table: { ...run.manifest.table, rows, review_cells: reviewCells, human_cells: humanCells, alternatives },
        table_status: reviewCells?.length ? "needs_review" : "verified",
      },
    });
    applyRuns(await loadArchiveRuns());
    setArchiveMessage("Corrected cell saved locally.");
  };

  const _setReviewTableCell = (rowIndex: number, columnIndex: number, value: string) => {
    setResult((current) => {
      if (!current?.review_table?.rows[rowIndex]) return current;
      const rows = current.review_table.rows.map((row) => [...row]);
      rows[rowIndex][columnIndex] = value.trim();
      const key = `${rowIndex}:${columnIndex}`;
      return {
        ...current,
        review_table: {
          ...current.review_table,
          rows,
          review_cells: current.review_table.review_cells?.filter((entry) => entry !== key),
          human_cells: [...new Set([...(current.review_table.human_cells ?? []), key])],
          alternatives: current.review_table.alternatives?.filter((entry) => entry.row !== rowIndex || entry.column !== columnIndex),
        },
      };
    });
  };

  const _saveReviewedTable = async () => {
    if (!result?.review_table || !savedRun) return;
    const reviewedTable = { ...result.review_table };
    const unresolved = reviewedTable.review_cells?.length ?? 0;
    const updatedRun: ArchiveRun = {
      ...savedRun,
      manifest: { ...savedRun.manifest, table: reviewedTable, table_status: unresolved ? "needs_review" : "verified" },
    };
    await saveArchiveRun(updatedRun);
    setSavedRun(updatedRun);
    setResult(unresolved
      ? { ...result, review_table: reviewedTable }
      : { ...result, table: reviewedTable, review_table: null });
    applyRuns(await loadArchiveRuns());
    setArchiveMessage(unresolved
      ? `Draft register saved locally with ${unresolved} unverified OCR cell${unresolved === 1 ? "" : "s"}.`
      : "Operator-reviewed table saved to the local archive.");
  };

  const saveCropCorrections = async (): Promise<boolean> => {
    if (!result || !savedRun) return false;
    setStatus("saving"); setAnalysisError(null);
    try {
      await persistResult(result, modelName, savedRun);
      setStatus("complete");
      setArchiveMessage("تم حفظ تصحيحات القصاصات في الأرشيف المحلي.");
      return true;
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "تعذّر حفظ تصحيحات القصاصات.");
      setStatus("error");
      return false;
    }
  };

  const updateManualCropItems = (items: AnalysisResult["items"]) => {
    setResult((current) => current ? { ...current, items } : current);
    setCropCorrectionsDirty(true);
  };

  const setRunStartingSerial = async (runId: string, value: string) => {
    const match = normalizeWrittenSerial(value).match(/\d+/u);
    const startingNumber = match ? Number(match[0]) : Number.NaN;
    const run = archiveRuns.find((entry) => entry.id === runId) ?? (savedRun?.id === runId ? savedRun : null);
    if (!run || !Number.isInteger(startingNumber) || startingNumber < 1) {
      setAnalysisError("أدخل رقم بداية صحيحاً أكبر من صفر.");
      const current = archiveSerialNumber(run?.manifest.items[0]?.serial);
      setSerialStartDraft(current === null ? "" : String(current));
      return;
    }
    if (archiveSerialNumber(run.manifest.items[0]?.serial) === startingNumber) {
      setSerialStartDraft(String(startingNumber));
      return;
    }
    setStatus("saving");
    setAnalysisError(null);
    try {
      const updated = await renumberArchiveRun(runId, startingNumber);
      if (savedRun?.id === runId) setSavedRun(updated.run);
      setInventoryRecords((current) => current.map((entry) => entry.id === updated.inventory.id ? updated.inventory : entry));
      setSerialStartDraft(String(startingNumber));
      applyRuns(await loadArchiveRuns());
      const finalNumber = startingNumber + updated.run.manifest.items.length - 1;
      setArchiveMessage(`أعيد ترقيم الدفعة من ${startingNumber} إلى ${finalNumber}. الرقم التالي في المخزن هو ${updated.inventory.nextSerial}.`);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "تعذر تغيير بداية الترقيم.");
      const current = archiveSerialNumber(run.manifest.items[0]?.serial);
      setSerialStartDraft(current === null ? "" : String(current));
    } finally {
      setStatus("complete");
    }
  };

  const setArtifactSerial = async (runId: string, itemId: string, value: string) => {
    const run = archiveRuns.find((entry) => entry.id === runId) ?? (savedRun?.id === runId ? savedRun : null);
    if (!run) return;
    if (run.manifest.items[0]?.id === itemId) {
      await setRunStartingSerial(runId, value);
      return;
    }
    const displaySerial = value.trim();
    const items = run.manifest.items.map((item) => item.id === itemId
      ? { ...item, display_serial: displaySerial || undefined }
      : item);
    const updated = { ...run, manifest: { ...run.manifest, items } };
    await saveArchiveRun(updated);
    if (savedRun?.id === runId) setSavedRun(updated);
    applyRuns(await loadArchiveRuns());
    setArchiveMessage(`Saved ${artifactDisplaySerial(items.find((item) => item.id === itemId)!)}.`);
  };

  const eraseArchive = async () => {
    await clearArchiveStore();
    applyRuns([]); setInventoryRecords([]); setSelectedInventoryId(null); setOpenRunId(null); setSavedRun(null); setSerialStartDraft("");
    setClearMessage("Every collection has been erased from this browser.");
  };

  const openCollection = (id: string) => { setView("archive"); setOpenRunId(id); };

  const servicesReady = Boolean(systemStatus?.analysis.configured);
  const statusLabel = statusLoading ? "جارٍ التحقق"
    : !systemStatus ? "جارٍ التحقق…"
      : servicesReady ? "الخدمة جاهزة" : "الخدمة غير متاحة";
  const selectedInventory = openInventoryKey ? inventoryList.find((entry) => entry.key === openInventoryKey) : null;
  const viewTitle = view === "inventories" ? selectedInventory?.name ?? "سجلات المخزن" : view === "archive" ? "الأرشيف" : view === "taxonomy" ? "التصنيفات" : view === "settings" ? "الإعدادات" : intakeOpen ? "بيانات الدفعة الجديدة" : assets.length ? assets[0].name : "مساحة العمل";
  const viewCrumb = view === "inventories" ? "السجلات" : view === "archive" ? "الأرشيف" : view === "taxonomy" ? "التصنيفات" : view === "settings" ? "الإعدادات" : intakeOpen ? "بيانات الدفعة" : assets.length ? "الدفعة الحالية" : "الرئيسية";

  return <main className={`shell ${view === "workbench" && assets.length && !intakeOpen ? "workspace-active" : ""} ${intakeOpen ? "intake-active" : ""}`}>
    <aside className={`nav ${sidebarOpen ? "nav-open" : ""}`}>
      <div className="brand"><span className="lotus-mark" aria-hidden="true" /><div><strong>Seshat</strong><small>Local archive intelligence</small></div></div>
      <button className="create-button" onClick={newWorkspace}><b>+</b><span>New archive run</span></button>
      <nav aria-label="Main navigation">
        <p>مساحة العمل</p>
        <button className={view === "workbench" ? "active" : ""} title="مساحة العمل" onClick={() => { setView("workbench"); setSidebarOpen(false); }}><i>٠١</i><strong>مساحة العمل</strong></button>
        <button className={view === "inventories" ? "active" : ""} title="السجلات" onClick={() => { setView("inventories"); setOpenInventoryKey(null); setSidebarOpen(false); }}><i>٠٢</i><strong>السجلات</strong><span>{inventoryList.length}</span></button>
        <button className={view === "archive" ? "active" : ""} title="الأرشيف" onClick={() => { setView("archive"); setOpenRunId(null); setSidebarOpen(false); }}><i>٠٣</i><strong>الأرشيف</strong><span>{archiveRuns.length}</span></button>
        <button className={view === "taxonomy" ? "active" : ""} title="التصنيفات" onClick={() => { setView("taxonomy"); setSidebarOpen(false); }}><i>٠٤</i><strong>التصنيفات</strong><span>{categoryCount}</span></button>
        <p>خطوات العمل</p>
        <div className="method-note"><b>استخراج</b><span /><b>ترقيم</b><span /><b>حفظ</b></div>
        <p>الأدوات</p>
        <button className={view === "settings" ? "active" : ""} title="الإعدادات" onClick={() => { setView("settings"); setSidebarOpen(false); }}><i>٠٥</i><strong>الإعدادات</strong></button>
      </nav>
      <div className="nav-bottom"><div className="local-card"><span className="status-dot" /><div><strong>خدمة الاستخراج</strong><small>جاهزة لمعالجة الصور</small></div></div><div className="privacy-seal"><span>محلي</span><p>تُحفظ الصور والنتائج في هذا الجهاز.</p></div></div>
    </aside>
    {sidebarOpen && <button className="scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <section className="main" ref={mainRef}>
      <header className="topbar"><div className="title-row"><button className="mobile-menu" aria-label="فتح القائمة" onClick={() => setSidebarOpen(true)}>القائمة</button><div><small>سشات / {viewCrumb}</small><strong>{viewTitle}</strong></div></div><div className="top-actions"><button className={`model-pill ${!systemStatus || statusLoading ? "idle" : servicesReady ? "" : "warn"}`} onClick={() => setView("settings")} title="فتح الإعدادات"><i /> {statusLabel}</button><span className="avatar">MA</span></div></header>

      <div className="account-menu-overlay"><AccountMenu /></div>
      {view === "inventories" ? <InventoriesView
        runs={archiveRuns}
        inventories={inventoryList}
        cropUrls={cropUrls}
        openKey={openInventoryKey}
        onOpen={setOpenInventoryKey}
        onOpenRun={openCollection}
        onSetArtifactSerial={(runId, itemId, value) => void setArtifactSerial(runId, itemId, value)}
      /> : view === "archive" ? <ArchiveView
        runs={archiveRuns}
        cropUrls={cropUrls}
        sourceUrls={sourceUrls}
        query={archiveQuery}
        onQueryChange={setArchiveQuery}
        sort={archiveSort}
        onSortChange={setArchiveSort}
        openId={openRunId}
        onOpen={setOpenRunId}
        onExport={(id) => void exportRun(id)}
        onDelete={(id) => void removeRun(id)}
        onRename={(id, label) => void renameRun(id, label)}
        onSetArtifactSerial={(runId, itemId, value) => void setArtifactSerial(runId, itemId, value)}
        onDownloadCrop={(crop) => downloadBlob(crop.name, crop.blob)}
        onDownloadManifest={(run) => downloadBlob(`${run.id}-manifest.json`, new Blob([JSON.stringify(run.manifest, null, 2)], { type: "application/json" }))}
        onSaveTranscription={(id, text) => void saveTranscription(id, text)}
        onDownloadCsv={(run, plates) => { if (run.manifest.table) downloadBlob(`${run.id}-table.csv`, new Blob([tableToCsv(run.manifest.table, plates)], { type: "text/csv;charset=utf-8" })); }}
        onSetRowPlate={(id, rowIndex, file) => void setRowPlate(id, rowIndex, file)}
        onSetTableCell={(id, rowIndex, columnIndex, value) => void setTableCell(id, rowIndex, columnIndex, value)}
        mode={archiveMode}
        onModeChange={setArchiveMode}
        seriesFilter={seriesFilter}
        onSeriesFilterChange={setSeriesFilter}
        seriesList={seriesList}
        onExportSeries={(name) => void exportSeries(name)}
        onMoveRun={(id, name) => void moveRunToSeries(id, name)}
        message={archiveMessage}
      /> : view === "taxonomy" ? <TaxonomyView
        runs={archiveRuns}
        cropUrls={cropUrls}
        onOpenRun={openCollection}
      /> : view === "settings" ? <SettingsView
        status={systemStatus}
        statusLoading={statusLoading}
        statusError={statusError}
        onRefresh={() => void refreshStatus()}
        options={options}
        onOptionsChange={updateOptions}
        onResetOptions={() => setOptions(defaultRunOptions)}
        runCount={archiveRuns.length}
        archiveBytes={archiveBytes}
        onClearArchive={() => void eraseArchive()}
        clearMessage={clearMessage}
      /> : intakeOpen && assets.length ? <IntakeView
        assets={assets}
        value={intake}
        series={series}
        seriesNames={seriesNames}
        inventories={inventoryRecords}
        selectedInventoryId={selectedInventoryId}
        sourceAssignments={sourceAssignments}
        nextSerial={nextStorageSerial}
        maxSources={MAX_SOURCE_FILES}
        onChange={(patch) => setIntake((current) => ({ ...current, ...patch }))}
        onRelationshipChange={chooseBatchRelationship}
        onSourceGovernorateChange={chooseSourceGovernorate}
        onSourceInventoryChange={chooseSourceInventory}
        onGovernorateChange={chooseGovernorate}
        onInventoryChange={chooseInventory}
        onSeriesChange={(name) => setSeries(name || UNFILED)}
        onRemoveAsset={removeAsset}
        onMoveAsset={moveAsset}
        onContinue={() => setIntakeOpen(false)}
        onCancel={newWorkspace}
        onSaveDefaults={() => {
          const reusable = { ...intake, title: "", registerPageNumber: "", notes: "" };
          try { window.localStorage.setItem(INTAKE_DEFAULTS_KEY, JSON.stringify(reusable)); } catch { /* local storage may be blocked */ }
        }}
      /> : !assets.length ? <div className="home-view">
        <section className="home-hero"><div className="hero-copy"><h1>استخرج كل صورة.<br /><em>وامنح كل قطعة رقماً دائماً.</em></h1><p>أضف صورة واحدة أو دفعة مرتبة. يحدد سشات الصور المضمّنة، ويقصّها من المصدر، ويرقمها ويحفظها مع سجل بيانات كامل.</p></div><div className="hero-seal"><span>{archiveRuns.length}</span><small>دفعات<br />محفوظة</small></div></section>
        <section className={`upload-panel ${dragging ? "dropping" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { setDragging(false); handleDrop(event); }}><div className="upload-symbol" aria-hidden="true"><span className="glyph-ankh" /></div><div className="upload-copy"><span>دفعة استخراج جديدة</span><h2>اختر صور المصادر معاً</h2><p>اختر عدة صور أو اسحب حتى {MAX_SOURCE_FILES} صورة. يمكنك مراجعتها وحذفها وترتيبها قبل الاستخراج.</p></div><button type="button" className="primary file-trigger" onClick={openFilePicker}>اختيار الصور</button><div className="format-list"><span>JPG / JFIF</span><span>PNG</span><span>WEBP</span><span>TIFF</span><span>حتى {MAX_SOURCE_FILES} صورة</span><span>14 MB لكل صورة</span></div></section>
        <div className="series-bar desk">
          <label className="select-field">
            <span>File this run into a series</span>
            <input list="series-options-home" value={series} placeholder={UNFILED}
              onChange={(event) => setSeries(event.target.value || UNFILED)} />
            <datalist id="series-options-home">{seriesNames.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          <p>Pages of one register belong in one series. The storage selected during intake owns the artefact serial sequence and continues it across later sessions.</p>
        </div>
        <div className="stat-row home-stats">
          <div className="stat-card"><small>المجموعات المحفوظة</small><strong>{archiveRuns.length}</strong></div>
          <div className="stat-card"><small>الصور المؤرشفة</small><strong>{archiveImages}</strong></div>
          <div className="stat-card"><small>التصنيفات</small><strong>{categoryCount}</strong></div>
          <div className="stat-card"><small>الحجم</small><strong>{formatSize(archiveBytes)}</strong></div>
        </div>
        <section className="process-section"><div className="section-heading"><div><h2>من المسح إلى مجموعة صور مرقمة</h2></div><small>بسيط وتلقائي</small></div><div className="process-grid"><article><span>٠١</span><div><h3>تحديد</h3><p>تحديد الصور والرسوم والأختام والخرائط المضمّنة داخل كل مصدر.</p></div></article><article><span>٠٢</span><div><h3>قص</h3><p>قص كل صورة من البكسلات الأصلية مع حفظ اسم المصدر والإحداثيات.</p></div></article><article><span>٠٣</span><div><h3>ترقيم</h3><p>منح كل قطعة رقماً دائماً وحفظه مع الصورة وسجل البيانات.</p></div></article></div></section>
        <section className="recent-section"><div className="section-heading"><div><span className="eyebrow">LOCAL ARCHIVE</span><h2>Recent collections</h2></div>{archiveRuns.length ? <button className="secondary" onClick={() => { setView("archive"); setOpenRunId(null); }}>Open the chamber →</button> : <small>{archiveRuns.length} saved on this browser</small>}</div>{archiveRuns.length ? <div className="archive-list">{archiveRuns.slice(0, 5).map((run, index) => <article key={run.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{run.label}</strong><small>{run.id} · {formatDate(run.createdAt)}</small></div><p>{run.crops.length} images / {run.manifest.items.length} records</p><button onClick={() => openCollection(run.id)}>Open</button></article>)}</div> : <div className="empty-row"><span className="glyph-mark" aria-hidden="true" /><div><strong>The archive is waiting</strong><p>Your first serialized collection will appear here.</p></div><button type="button" className="file-trigger" onClick={openFilePicker}>Choose a source</button></div>}</section>
      </div> : <div className="workspace-view">
        <div className="workspace-toolbar"><div className="workflow-mark"><span className="lotus-mark" aria-hidden="true" /><div><strong>استخراج الصور وترقيمها</strong><small>الصورة الأصلية أولاً، ثم النتائج أسفلها</small></div></div>
          <div><button className="secondary" onClick={() => setIntakeOpen(true)}>مراجعة الدفعة</button><button type="button" className="secondary file-trigger" onClick={openFilePicker}>إضافة صور ({assets.length}/{MAX_SOURCE_FILES})</button><button className="secondary gold" onClick={() => exportRun()} disabled={!savedRun}>تصدير المجموعة</button></div></div>
        <div className="series-bar">
          <label className="select-field">
            <span>السلسلة</span>
            <input list="series-options" value={series} placeholder={UNFILED}
              onChange={(event) => setSeries(event.target.value || UNFILED)} />
            <datalist id="series-options">{seriesNames.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          <p>Serials continue within <strong>{intake.storehouseName || "the selected storage"}</strong>, independently of other storage locations — next serial <b>{nextStorageSerial}</b>.</p>
        </div>
        <div className="run-ribbon"><span>الدفعة الحالية</span><b>{assets.length} مصدر</b><i /><span>الحجم</span><b>{formatSize(totalSize)}</b>{assets.length > 1 && <><i /><span>علاقة الصور</span><b>{batchRelationshipLabel(intake.batchRelationship)}</b></>}<i /><span>الحفظ التلقائي</span><b>{status === "complete" ? "محفوظ" : status === "saving" ? "جارٍ الحفظ" : "جاهز"}</b>{savedRun && <><i /><span>معرّف الدفعة</span><b>{savedRun.id}</b></>}</div>{uploadMessage && <div className="notice batch-notice"><strong>صور الدفعة</strong><p>{uploadMessage}</p></div>}
        <div className="analysis-grid"><section className={`source-panel ${viewerFocused ? "viewer-focus" : ""}`}><div className="panel-head"><div><span className="source-position">المصدر {assets.findIndex((asset) => asset.id === selected?.id) + 1} من {assets.length}</span><h2>{selected?.name}</h2></div><div className="viewer-meta"><span>{selected ? `${fileLabel(selected)} · ${formatSize(selected.size)}${selected.width && selected.height ? ` · ${selected.width} × ${selected.height}` : ""}` : ""}</span>{selected?.preview && <div className="zoom-controls" aria-label="أدوات تكبير الصورة"><button className={viewScale === "fit" ? "active" : ""} onClick={() => setViewScale("fit")}>ملاءمة</button><button aria-label="تصغير" onClick={() => changeViewScale(-0.25)} disabled={viewScale !== "fit" && viewScale <= 0.25}>−</button><output>{viewScale === "fit" ? "كامل" : `${Math.round(viewScale * 100)}%`}</output><button aria-label="تكبير" onClick={() => changeViewScale(0.25)} disabled={viewScale !== "fit" && viewScale >= 2}>+</button><button className="focus-toggle" aria-pressed={viewerFocused} onClick={() => setViewerFocused((current) => !current)}>{viewerFocused ? "إنهاء التركيز" : "عرض مركّز"}</button></div>}</div></div><div ref={previewStageRef} className={`preview-stage ${viewScale === "fit" ? "fit-view" : "scaled-view"}`}>{selected?.preview ? <div className={`document-mat ${viewScale === "fit" ? "fit" : "scaled"}`} style={viewScale === "fit" ? fittedSize ? { width: `${fittedSize.width}px`, height: `${fittedSize.height}px` } : { aspectRatio: `${selected.width ?? 4} / ${selected.height ?? 3}` } : { width: `${Math.max(240, (selected.width ?? 1000) * viewScale)}px` }}><img src={selected.preview} alt={`معاينة ${selected.name}`} draggable={false} /></div> : <div className="generic-preview"><span>{selected ? fileLabel(selected) : "ملف"}</span><strong>{selected?.name}</strong><small>تعذّر عرض هذا الملف كصورة.</small></div>}</div><div className="source-strip" aria-label="صور الدفعة بالترتيب">{assets.map((asset, index) => <div key={asset.id} className={`source-chip ${selected?.id === asset.id ? "active" : ""}`}><button className="chip-select" aria-pressed={selected?.id === asset.id} onClick={() => setSelectedId(asset.id)}><span>{asset.preview ? <img src={asset.preview} alt="" /> : fileLabel(asset)}</span><div><strong>{index + 1} · {asset.name}</strong><small>{result ? `${result.items.filter((item) => item.source_index === index).length} صورة مستخرجة · ` : ""}{formatSize(asset.size)}</small></div></button><div className="source-chip-actions"><button aria-label={`تحريك ${asset.name} للأمام`} disabled={index === 0} onClick={() => moveAsset(asset.id, -1)}>السابق</button><button aria-label={`تحريك ${asset.name} للخلف`} disabled={index === assets.length - 1} onClick={() => moveAsset(asset.id, 1)}>التالي</button><button className="chip-remove" aria-label={`حذف ${asset.name}`} onClick={() => removeAsset(asset.id)}>حذف</button></div></div>)}{assets.length < MAX_SOURCE_FILES && <button type="button" className="source-add file-trigger" onClick={openFilePicker}><strong>إضافة صور</strong><small>متبقٍ {MAX_SOURCE_FILES - assets.length}</small></button>}</div></section>
          <aside className="inspector"><div className="inspector-head"><strong>نتائج الاستخراج</strong><span className={`run-status ${status}`}>{status === "running" ? `جارٍ الاستخراج · ${formatElapsed(elapsedMs)}` : status === "saving" ? "جارٍ الترقيم والحفظ" : status === "complete" ? "محفوظ" : status === "error" ? "يحتاج مراجعة" : "جاهز"}</span></div><div className="selected-task"><span aria-hidden="true">{assets.length}</span><div><small>خطة الدفعة</small><strong>{assets.length} صورة مصدر بالترتيب</strong><p>تحديد الصور المضمّنة، قصّها من الأصل، ثم ترقيمها وحفظها.</p></div></div>
            {!result && <>

              <div className="control-block">
                <button className="control-toggle" aria-expanded={openControls === "detection"} onClick={() => setOpenControls(openControls === "detection" ? null : "detection")}>
                  <span>Detection controls</span><b>{openControls === "detection" ? "−" : "+"}</b>
                </button>
                <div className="chip-row">
                  <span className="chip">box {options.boxThreshold.toFixed(2)}</span>
                  <span className="chip">text {options.textThreshold.toFixed(2)}</span>
                  <span className="chip">{options.detectorPrompt ? "custom prompt" : "default prompt"}</span>
                </div>
                {openControls === "detection" && <div className="control-body">
                  <label className="text-field"><span>Detector prompt</span><textarea rows={2} value={options.detectorPrompt} placeholder="photograph. illustration. drawing. carved artifact." onChange={(event) => updateOptions({ detectorPrompt: event.target.value })} /><small>Open-vocabulary prompt for Grounding DINO. Empty uses the safe default that excludes page stamps.</small></label>
                  <label className="slider-row"><span className="slider-label">Box threshold<b>{options.boxThreshold.toFixed(2)}</b></span><input type="range" min={0.05} max={0.6} step={0.01} value={options.boxThreshold} onChange={(event) => updateOptions({ boxThreshold: Number(event.target.value) })} /><small>Lower finds more regions, and more false positives.</small></label>
                  <label className="slider-row"><span className="slider-label">Text threshold<b>{options.textThreshold.toFixed(2)}</b></span><input type="range" min={0.05} max={0.6} step={0.01} value={options.textThreshold} onChange={(event) => updateOptions({ textThreshold: Number(event.target.value) })} /><small>How strongly a region must match the prompt wording.</small></label>
                </div>}
              </div>

              <div className="control-block">
                <button className="control-toggle" aria-expanded={openControls === "archiving"} onClick={() => setOpenControls(openControls === "archiving" ? null : "archiving")}>
                  <span>إعدادات الحفظ</span><b>{openControls === "archiving" ? "−" : "+"}</b>
                </button>
                <div className="chip-row">
                  <span className="chip">≥ {Math.round(options.minConfidence * 100)}%</span>
                  <span className="chip">pad {options.cropPadding}%</span>
                  <span className="chip">{options.cropFormat.toUpperCase()}</span>
                </div>
                {openControls === "archiving" && <div className="control-body">
                  <label className="slider-row"><span className="slider-label">الحد الأدنى للثقة<b>{Math.round(options.minConfidence * 100)}%</b></span><input type="range" min={0} max={0.9} step={0.05} value={options.minConfidence} onChange={(event) => updateOptions({ minConfidence: Number(event.target.value) })} /><small>تُستبعد النتائج الأضعف قبل الحفظ.</small></label>
                  <label className="slider-row"><span className="slider-label">هامش القص<b>{options.cropPadding}%</b></span><input type="range" min={0} max={25} step={1} value={options.cropPadding} onChange={(event) => updateOptions({ cropPadding: Number(event.target.value) })} /><small>مساحة إضافية حول كل صورة مستخرجة.</small></label>
                  <label className="select-field"><span>صيغة الصورة</span><select value={options.cropFormat} onChange={(event) => updateOptions({ cropFormat: event.target.value as CropFormat })}><option value="png">PNG · بدون فقد</option><option value="jpeg">JPEG · حجم أصغر</option><option value="webp">WebP · أصغر حجم</option></select></label>
                </div>}
              </div>

              <div className="analysis-options">
                <label><input type="checkbox" checked={options.recordCoordinates} onChange={(event) => updateOptions({ recordCoordinates: event.target.checked })} /> حفظ إحداثيات المصدر</label>
                <label><input type="checkbox" checked={options.saveCrops} onChange={(event) => updateOptions({ saveCrops: event.target.checked })} /> حفظ الصور تلقائياً</label>
                <label><input type="checkbox" checked={options.flagUncertain} onChange={(event) => updateOptions({ flagUncertain: event.target.checked })} /> تمييز النتائج غير المؤكدة</label>
              </div>
              <button className="run-button" onClick={runAnalysis} disabled={status === "running" || status === "saving"}>{status === "running" ? `جارٍ استخراج الصور · ${formatElapsed(elapsedMs)}` : status === "saving" ? `جارٍ الترقيم والحفظ · ${formatElapsed(elapsedMs)}` : assets.length === 1 ? "استخراج الصور وترقيمها وحفظها" : `استخراج صور ${assets.length} مصادر`}<span>تشغيل</span></button>
              {(status === "running" || status === "saving") && <p className="run-progress-note">تُعالج الصور بالترتيب، ثم تُحفظ القصاصات بأبعادها الأصلية.</p>}</>}
            {analysisError && <div className="notice error"><strong>توقفت العملية</strong><p>{analysisError}</p></div>}
            {result && <section className="results"><div className="results-title">
              <div><h3>{result.items.length} صورة مستخرجة</h3><p>تمت معالجة {assets.length} صورة مصدر بالترتيب</p></div>
              <div className="results-title-actions">
                {savedRun && <label className="serial-start-control"><span>بداية الترقيم</span><input type="number" min="1" step="1" inputMode="numeric" value={serialStartDraft} disabled={status === "saving"} onChange={(event) => setSerialStartDraft(event.target.value)} onBlur={(event) => void setRunStartingSerial(savedRun.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>يستمر الباقي تلقائياً</small></label>}
                {durationMs !== null && <small>{(durationMs / 1000).toFixed(1)} ثانية</small>}
              </div>
            </div>
              <p className="result-summary">{result.summary}</p>{savedRun && <div className={`save-confirm ${savedRun.crops.length ? "" : "warning"}`}><span>{savedRun.crops.length ? "✓" : "!"}</span><div><strong>{savedRun.crops.length ? "تم حفظ الصور المرقمة في الأرشيف" : "تم حفظ السجل، لكن بعض الصور مفقودة"}</strong><small>{savedRun.crops.length ? `${savedRun.crops.length} صورة مرقمة مع ملف البيانات` : "أعد إنشاء القصاصات لإكمال الحفظ."}</small></div>{!savedRun.crops.length && <button onClick={repairCrops}>إعادة إنشاء الصور</button>}</div>}
              <div className="batch-result-summary">{assets.map((asset, sourceIndex) => { const count = result.items.filter((item) => item.source_index === sourceIndex).length; return <button key={asset.id} className={selected?.id === asset.id ? "active" : ""} onClick={() => setSelectedId(asset.id)}><span>{sourceIndex + 1}</span><strong>{asset.name}</strong><small>{count} صورة</small></button>; })}</div>
              {result.items.length > 0 ? <div className="result-items">{result.items.map((item, index) => { const sealedItem = savedRun?.manifest.items[index]; const sourceIndex = item.source_index ?? 0; const source = assets[sourceIndex]; return <article key={`${item.title}-${index}`} className={options.flagUncertain && item.confidence !== null && item.confidence < 0.4 ? "uncertain" : ""}>{cropPreviews[index] && <img src={cropPreviews[index]} alt={`الصورة المستخرجة ${index + 1} من ${source?.name ?? "المصدر"}`} />}<div className="item-body"><div className="item-title">{sealedItem ? <input key={artifactDisplaySerial(sealedItem)} className="serial-editor" dir="rtl" lang="ar" aria-label={index === 0 ? "بداية ترقيم الدفعة" : "رقم القطعة"} defaultValue={artifactDisplaySerial(sealedItem)} onBlur={(event) => void setArtifactSerial(savedRun!.id, sealedItem.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /> : <span>{`قطعة رقم ${index + 1}`}</span>}<strong title={item.title}>{item.title}</strong>{item.confidence !== null && <b>{Math.round(item.confidence * 100)}%</b>}</div><small>{item.category} · المصدر {sourceIndex + 1}</small>{item.description && <p className="item-description">{item.description}</p>}<p className="item-source">{source?.name ?? "مصدر غير معروف"}</p>{sealedItem?.file && <code>{sealedItem.file}</code>}{item.bbox?.length === 4 && <code>الإحداثيات [{item.bbox.join(", ")}]</code>}</div></article>; })}</div> : <div className="empty-extraction"><strong>لم يتم العثور على صور مضمّنة</strong><p>راجع الصورة الأصلية ثم شغّل الدفعة مرة أخرى.</p></div>}
              <button className="export-button" onClick={() => exportRun()} disabled={!savedRun}>تصدير المجلد <span>ملف البيانات + {savedRun?.crops.length ?? 0} صور</span></button>{exportMessage && <p className="export-message">{exportMessage}</p>}<div className="result-actions"><button className="text-button" onClick={repairCrops} disabled={!savedRun || status === "saving"}>إعادة إنشاء القصاصات</button><button className="text-button" onClick={resetResult}>تشغيل الدفعة مرة أخرى</button></div></section>}
          </aside></div>
      </div>}
      {result && savedRun && <button
        type="button"
        className={`manual-crop-launch ${cropCorrectionsDirty ? "dirty" : ""}`}
        onClick={() => setCropEditorOpen(true)}
        disabled={status === "saving"}
      >
        <span>✥</span><strong>{cropCorrectionsDirty ? "متابعة تصحيح القصاصات" : "تصحيح القصاصات يدوياً"}</strong><small>{cropCorrectionsDirty ? "تعديلات غير محفوظة" : "إضافة · تحريك · تغيير الحجم · حذف"}</small>
      </button>}
      {cropEditorOpen && result && <ManualCropEditor
        assets={assets.filter((asset) => asset.type.startsWith("image/"))}
        items={result.items}
        coordinateSpace={result.coordinate_space ?? "normalized_1000"}
        initialSourceIndex={Math.max(0, assets.filter((asset) => asset.type.startsWith("image/")).findIndex((asset) => asset.id === selected?.id))}
        dirty={cropCorrectionsDirty}
        saving={status === "saving"}
        onItemsChange={updateManualCropItems}
        onSave={saveCropCorrections}
        onClose={() => setCropEditorOpen(false)}
      />}
      <input ref={fileInputRef} id="source-file-input" className="sr-only" type="file" accept="image/*,.jfif,.tif,.tiff" multiple onChange={handleFiles} />
    </section>
  </main>;
}
