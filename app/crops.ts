"use client";

// Cutting plates out of the source. The detector owns the coordinates; this
// module only converts them into pixels and never adjusts a box on its own.

import type {
  AnalysisResult, ArchiveManifest, ArchiveRun, Asset, CoordinateSpace, CropFormat, IntakeMetadata,
  ManifestItem, RunOptions, SavedCrop, TaskId,
} from "./types.ts";
import { cropExtension, cropMime, storageIdentity } from "./types.ts";

export const safeName = (value: string) =>
  value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).toLowerCase() || "item";

export function canvasBlob(canvas: HTMLCanvasElement, format: CropFormat): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Could not encode the extracted image.")),
    cropMime[format],
    format === "png" ? undefined : 0.92,
  ));
}

export function ollamaVisionDimensions(width: number, height: number) {
  const factor = 28;
  const maxPixels = 1_003_520;
  let visionWidth = Math.max(factor, Math.round(width / factor) * factor);
  let visionHeight = Math.max(factor, Math.round(height / factor) * factor);
  if (visionWidth * visionHeight > maxPixels) {
    const scale = Math.sqrt((width * height) / maxPixels);
    visionWidth = Math.max(factor, Math.floor(width / scale / factor) * factor);
    visionHeight = Math.max(factor, Math.floor(height / scale / factor) * factor);
  }
  return { width: visionWidth, height: visionHeight };
}

export async function cropSource(asset: Asset, bbox: number[], coordinateSpace: CoordinateSpace, paddingPercent: number, format: CropFormat): Promise<Blob | null> {
  if (!asset.type.startsWith("image/") || bbox.length !== 4) return null;
  const image = await createImageBitmap(asset.file);
  const [rawX1, rawY1, rawX2, rawY2] = bbox;
  const vision = ollamaVisionDimensions(image.width, image.height);
  const usesVisionCanvas = coordinateSpace === "ollama_pixels";
  const usesOriginalPixels = coordinateSpace === "pixels";
  const scaleX = usesVisionCanvas ? image.width / vision.width : usesOriginalPixels ? 1 : image.width / 1000;
  const scaleY = usesVisionCanvas ? image.height / vision.height : usesOriginalPixels ? 1 : image.height / 1000;
  const limitX = usesVisionCanvas ? vision.width : usesOriginalPixels ? image.width : 1000;
  const limitY = usesVisionCanvas ? vision.height : usesOriginalPixels ? image.height : 1000;
  const ratio = Math.max(0, paddingPercent) / 100;
  const paddingX = ratio > 0 ? Math.max(2, Math.abs(rawX2 - rawX1) * ratio) : 0;
  const paddingY = ratio > 0 ? Math.max(2, Math.abs(rawY2 - rawY1) * ratio) : 0;
  const x1 = Math.max(0, Math.min(limitX, rawX1 - paddingX));
  const y1 = Math.max(0, Math.min(limitY, rawY1 - paddingY));
  const x2 = Math.max(x1, Math.min(limitX, rawX2 + paddingX));
  const y2 = Math.max(y1, Math.min(limitY, rawY2 + paddingY));
  const sx = Math.round(x1 * scaleX);
  const sy = Math.round(y1 * scaleY);
  const sw = Math.max(1, Math.round((x2 - x1) * scaleX));
  const sh = Math.max(1, Math.round((y2 - y1) * scaleY));
  if (sw < 8 || sh < 8) { image.close(); return null; }
  const canvas = document.createElement("canvas");
  canvas.width = sw; canvas.height = sh;
  canvas.getContext("2d")?.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  image.close();
  return canvasBlob(canvas, format);
}

/**
 * Resolve which source image a reported index refers to. Models count from
 * zero or from one depending on the day, so accept both when the value is
 * otherwise in range, and give up rather than guess when it is not.
 */
export function resolveSourceIndex(reportedIndex: number | null, imageCount: number): number | null {
  if (imageCount === 1) return 0;
  if (reportedIndex === null) return null;
  if (reportedIndex >= 0 && reportedIndex < imageCount) return reportedIndex;
  if (reportedIndex > 0 && reportedIndex <= imageCount) return reportedIndex - 1;
  return null;
}

/** Extraction is an archival capture step: every accepted Gemini detection
 * must be cropped and sealed. The legacy maximum remains available only to
 * non-extraction tasks that intentionally request a sample. */
export function archiveCandidates(result: AnalysisResult, options: RunOptions, task: TaskId) {
  const accepted = result.items.filter((item) => options.minConfidence <= 0 || item.confidence === null || item.confidence >= options.minConfidence);
  return task === "extract" ? accepted : accepted.slice(0, options.maxItems);
}

export async function buildArchiveRun(result: AnalysisResult, assets: Asset[], task: TaskId, model: string, options: RunOptions, series: string, intake: IntakeMetadata, existing?: ArchiveRun): Promise<ArchiveRun> {
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const id = existing?.id ?? `SES-${createdAt.replace(/[-:TZ.]/g, "").slice(0, 17)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const crops: SavedCrop[] = [];
  const items: ManifestItem[] = [];
  const imageAssets = assets.filter((asset) => asset.type.startsWith("image/"));
  const sources = imageAssets.map((asset, sourceIndex) => ({
    sourceIndex,
    name: asset.name,
    type: asset.type || "image/jpeg",
    blob: asset.file.slice(0, asset.file.size, asset.type || "image/jpeg"),
    width: asset.width,
    height: asset.height,
  }));

  const kept = archiveCandidates(result, options, task);
  const discarded = result.items.length - kept.length;

  for (let index = 0; index < kept.length; index += 1) {
    const item = kept[index];
    const previous = item.id
      ? existing?.manifest.items.find((candidate) => candidate.id === item.id)
      : existing?.manifest.items[index];
    const sourceIndex = resolveSourceIndex(Number.isInteger(item.source_index) ? item.source_index : null, imageAssets.length);
    const source = sourceIndex !== null ? imageAssets[sourceIndex] : undefined;
    let file: string | null = null;
    // Transcribe and Summarize return no real regions; any bbox they emit is a
    // guess, and cropping it produces a meaningless "plate" in the archive.
    const cropsMakeSense = task === "extract" || task === "classify" || task === "catalogue";
    if (options.saveCrops && cropsMakeSense && source && item.bbox?.length === 4) {
      const blob = await cropSource(source, item.bbox, result.coordinate_space ?? "normalized_1000", options.cropPadding, options.cropFormat);
      if (blob) {
        file = `${String(index + 1).padStart(3, "0")}-${safeName(item.category || item.title)}.${cropExtension[options.cropFormat]}`;
        crops.push({ itemIndex: index, name: file, blob });
      }
    }
    items.push({
      ...item,
      // Match an edited item by permanent id rather than by array position.
      // Removing a false detection must not move another artefact onto its
      // serial; a newly drawn crop intentionally has no id or serial yet.
      serial: item.serial ?? previous?.serial,
      display_serial: item.display_serial ?? previous?.display_serial,
      inventory_id: item.inventory_id ?? previous?.inventory_id,
      bbox: options.recordCoordinates ? item.bbox : null,
      source_index: sourceIndex,
      id: item.id ?? previous?.id ?? `${id}-${String(index + 1).padStart(3, "0")}`,
      order: index + 1,
      source_name: source?.name ?? null,
      file,
    });
  }

  const warnings = [...result.warnings];
  if (discarded > 0) warnings.push(`${discarded} detection${discarded === 1 ? "" : "s"} were discarded by the run filters.`);
  if (!options.saveCrops) warnings.push("Crop saving was disabled for this run; only the manifest was sealed.");
  if (task === "transcribe" && !result.transcription) warnings.push("The model returned no transcription text for this source.");

  // A rejected automatic reading is still valuable operator-review work. Keep
  // it in the local manifest with an explicit status instead of silently
  // writing `null` and losing the refined cells when the page is reopened.
  const archivedTable = result.table ?? result.review_table ?? null;
  const tableStatus = result.table ? "verified" : result.review_table ? "needs_review" : undefined;
  const manifest: ArchiveManifest = {
    schema: "seshat.archive.v1",
    id,
    series,
    inventory_id: existing?.manifest.inventory_id,
    inventory_ids: existing?.manifest.inventory_ids,
    storage_key: existing?.manifest.storage_key ?? storageIdentity(intake),
    created_at: createdAt,
    task,
    model,
    summary: result.summary,
    coordinate_space: result.coordinate_space ?? "normalized_1000",
    sources: assets.map(({ name, type, size, width, height }) => ({ name, type, size, width, height })),
    items,
    transcription: result.transcription,
    table: archivedTable,
    table_status: tableStatus,
    warnings,
    options,
    intake: existing?.manifest.intake ?? intake,
  };
  return { id, createdAt, label: existing?.label ?? (intake.title.trim() || assets[0]?.name || "Untitled archive"), series, manifest, crops, sources };
}
