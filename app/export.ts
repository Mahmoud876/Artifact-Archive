"use client";

// Writing a collection back out to disk. The File System Access API gives a
// real folder on Chromium; everything else falls back to individual downloads.

import type { ArchiveRun } from "./types.ts";
import { artifactGovernorate, seriesArtifacts, sourceMetadataForItem } from "./types.ts";

export type WritableHandle = { write(data: Blob | string): Promise<void>; close(): Promise<void> };
export type FileHandle = { createWritable(): Promise<WritableHandle> };
export type DirectoryHandle = {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>;
};

export type DirectoryPicker = (options?: { mode: string }) => Promise<DirectoryHandle>;

/** The picker only exists on Chromium; callers fall back to downloads without it. */
export const directoryPicker = (): DirectoryPicker | undefined =>
  (window as typeof window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

export async function writeFile(directory: DirectoryHandle, name: string, content: Blob | string) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const NEWLINE = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const BOM = String.fromCharCode(0xFEFF);

const escapeCsv = (value: string) =>
  value.includes(",") || value.includes('"') || value.includes(NEWLINE)
    ? `"${value.replace(/"/g, '""')}"`
    : value;

/** The plate file name an artefact carries into the exported folder. */
export const platePath = (serial: string | undefined, id: string, file: string | null) =>
  file ? (serial && file.startsWith(`${serial}-`) ? file : `${serial ?? id}-${file}`) : null;

/**
 * A series is the deliverable: every artefact from every page in one numbered
 * sequence, with plates named by serial so the folder and the catalogue line up.
 */
export function buildSeriesManifest(runs: ArchiveRun[], name: string, exportedAt: string) {
  const artifacts = seriesArtifacts(runs, name);
  return {
    schema: "seshat.series.v1",
    series: name,
    exported_at: exportedAt,
    page_count: runs.length,
    artifact_count: artifacts.length,
    pages: runs.map((run) => ({
      id: run.id,
      inventory_id: run.manifest.inventory_id ?? null,
      inventory_ids: run.manifest.inventory_ids ?? (run.manifest.inventory_id ? [run.manifest.inventory_id] : []),
      label: run.label,
      created_at: run.createdAt,
      task: run.manifest.task,
      model: run.manifest.model,
    })),
    artifacts: artifacts.map(({ item, run }) => ({
      serial: item.serial ?? null,
      inventory_id: item.inventory_id ?? run.manifest.inventory_id ?? null,
      governorate: artifactGovernorate(run, item) || null,
      source: sourceMetadataForItem(run, item)?.name ?? item.source_name ?? null,
      title: item.title,
      category: item.category,
      description: item.description,
      confidence: item.confidence,
      bbox: item.bbox,
      page: run.label,
      run_id: run.id,
      plate: platePath(item.serial, item.id, item.file),
    })),
  };
}

/** Excel opens Arabic correctly only with a leading BOM and CRLF line endings. */
export function buildSeriesCsv(runs: ArchiveRun[], name: string) {
  const lines = [["serial", "title", "category", "confidence", "page", "run id", "plate"].join(",")];
  for (const { item, run } of seriesArtifacts(runs, name)) {
    lines.push([
      item.serial ?? "",
      item.title,
      item.category,
      item.confidence === null ? "" : String(Math.round(item.confidence * 100)),
      run.label,
      run.id,
      platePath(item.serial, item.id, item.file) ?? "",
    ].map((cell) => escapeCsv(String(cell))).join(","));
  }
  return BOM + lines.join(CRLF);
}

/** Write one sealed run — manifest plus every plate — into a chosen folder. */
export async function writeRunToDirectory(root: DirectoryHandle, run: ArchiveRun) {
  const directory = await root.getDirectoryHandle(run.id, { create: true });
  await writeFile(directory, "manifest.json", JSON.stringify(run.manifest, null, 2));
  for (const crop of run.crops) await writeFile(directory, crop.name, crop.blob);
  return run.crops.length;
}

/** Write a whole series: catalogue, manifest, and a flat plates folder. */
export async function writeSeriesToDirectory(root: DirectoryHandle, runs: ArchiveRun[], name: string, slug: string, exportedAt: string) {
  const directory = await root.getDirectoryHandle(slug, { create: true });
  const plateDir = await directory.getDirectoryHandle("plates", { create: true });
  await writeFile(directory, "series.json", JSON.stringify(buildSeriesManifest(runs, name, exportedAt), null, 2));
  await writeFile(directory, "catalogue.csv", new Blob([buildSeriesCsv(runs, name)], { type: "text/csv;charset=utf-8" }));
  let plateCount = 0;
  for (const run of runs) {
    for (const crop of run.crops) {
      const item = run.manifest.items[crop.itemIndex];
      await writeFile(plateDir, `${item?.serial ?? item?.id ?? run.id}-${crop.name}`, crop.blob);
      plateCount += 1;
    }
  }
  return plateCount;
}
