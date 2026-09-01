import type { AnalysisItem, Asset, CoordinateSpace } from "./types.ts";
import { ollamaVisionDimensions } from "./crops.ts";

export type NormalizedBox = [number, number, number, number];

const clamp = (value: number, minimum = 0, maximum = 1000) => Math.max(minimum, Math.min(maximum, value));

export function normalizedBox(box: number[]): NormalizedBox | null {
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) return null;
  const [firstX, firstY, secondX, secondY] = box;
  const x1 = clamp(Math.min(firstX, secondX));
  const y1 = clamp(Math.min(firstY, secondY));
  const x2 = clamp(Math.max(firstX, secondX));
  const y2 = clamp(Math.max(firstY, secondY));
  return x2 - x1 >= 1 && y2 - y1 >= 1 ? [x1, y1, x2, y2] : null;
}

function coordinateLimits(asset: Pick<Asset, "width" | "height">, space: CoordinateSpace) {
  const width = Math.max(1, asset.width ?? 1000);
  const height = Math.max(1, asset.height ?? 1000);
  if (space === "normalized_1000") return { width: 1000, height: 1000 };
  if (space === "ollama_pixels") return ollamaVisionDimensions(width, height);
  return { width, height };
}

export function bboxToNormalized(box: number[], asset: Pick<Asset, "width" | "height">, space: CoordinateSpace): NormalizedBox | null {
  if (box.length !== 4) return null;
  const limits = coordinateLimits(asset, space);
  return normalizedBox([
    box[0] / limits.width * 1000,
    box[1] / limits.height * 1000,
    box[2] / limits.width * 1000,
    box[3] / limits.height * 1000,
  ]);
}

export function normalizedToBbox(box: NormalizedBox, asset: Pick<Asset, "width" | "height">, space: CoordinateSpace): number[] {
  const limits = coordinateLimits(asset, space);
  return [
    Math.round(box[0] / 1000 * limits.width),
    Math.round(box[1] / 1000 * limits.height),
    Math.round(box[2] / 1000 * limits.width),
    Math.round(box[3] / 1000 * limits.height),
  ];
}

export function manualCropItem(box: number[], sourceIndex: number): AnalysisItem {
  return {
    title: "صورة مضافة يدوياً",
    category: "صورة أثرية",
    description: "تم تحديد حدود هذه الصورة يدوياً من المصدر الأصلي.",
    confidence: 1,
    bbox: box,
    source_index: sourceIndex,
  };
}
