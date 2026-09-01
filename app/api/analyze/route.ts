import { mapWithConcurrency } from "../../bounded-concurrency.ts";
import { authenticatedUser, unauthorizedResponse } from "../../local-auth.ts";
import {
  configuredOpenRouterModels,
  creditAwareOpenRouterLimit,
  DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENROUTER_MODEL,
} from "../../cloud-models.ts";

type OllamaResponse = {
  model?: string;
  message?: { content?: string };
  total_duration?: number;
  eval_count?: number;
  error?: string;
};

type DetectorResponse = {
  model?: string;
  image?: { width?: number; height?: number };
  items?: Array<{ bbox?: number[]; score?: number; label?: string }>;
  detail?: string;
};

type LocatedDetection = {
  bbox: number[];
  score: number | null;
  label: string;
  sourceIndex: number;
};

type CellAlternative = { row: number; column: number; first: string; second: string };
type RegisterTable = { columns: string[]; rows: string[][]; row_bounds?: number[]; source_height?: number; review_cells?: string[]; human_cells?: string[]; alternatives?: CellAlternative[] };

type AnalysisResult = {
  summary: string;
  items: Array<{
    title: string;
    category: string;
    description: string;
    confidence: number | null;
    bbox: number[] | null;
    source_index: number | null;
    plate_serial?: string | null;
    plate_label_bbox?: number[] | null;
  }>;
  transcription: string | null;
  table: RegisterTable | null;
  review_table?: RegisterTable | null;
  handwriting_review?: { status: "accepted" | "rejected"; agreement: number; verifiedCells: number; candidateCells: number; proposedCells?: number; enhancementVariants?: string[]; secondaryVariants?: string[] };
  enhancement_preview?: EnhancementPreview | null;
  warnings: string[];
  coordinate_space: "ollama_pixels" | "pixels" | "normalized_1000";
};

type EnhancementPreview = {
  row: number;
  column: number;
  columnLabel: string;
  bbox: number[];
  sourceWidth: number;
  sourceHeight: number;
  variants: Array<{ kind: string; imageUrl: string; width?: number; height?: number; scale?: number }>;
};

// This form is stable across the Egyptian Antiquities Service register pages
// the application is currently designed to ingest.  Letting a generative
// model rename/reorder the columns on every run made otherwise identical
// transcriptions impossible to compare.
const REGISTER_COLUMNS = [
  "مسلسل",
  "موضع الأثر",
  "وصف الأثر",
  "تاريخ الأثر",
  "المادة المصنوع منها",
  "مقاييس الأثر",
  "المصدر",
  "المكتشف",
  "رقم الأثر عند الكشف",
  "تاريخ القيد",
  "ملاحظات عامة",
  "صورة الأثر ورقمه",
] as const;
const REGISTER_ROW_COUNT = 10;
const MATERIAL_COLUMN_INDEX = 4;
type RegisterColumnProfile = {
  key: string;
  expected: string;
  guidance: string;
  maxLength: number;
  validate: (value: string) => boolean;
};

type PreparedPlateLabel = {
  index: number;
  bbox: number[];
  method?: 'tag' | 'band';
  views: Array<{ kind: string; image: string; width?: number; height?: number }>;
};

type VerifiedPlateLabel = { serial: string | null; bbox: number[] | null };

const MATERIAL_REFERENCE_TERMS = [
  "جرانيت", "حجر رملي", "حجر جيري", "رخام", "بازلت", "ألباستر", "مرمر",
  "فخار", "طين", "خشب", "برونز", "نحاس", "حديد", "ذهب", "فضة",
  "زجاج", "فيانس", "عاج", "نسيج", "جلد", "بردي",
] as const;

const REGISTER_COLUMN_PROFILES: RegisterColumnProfile[] = [
  {
    key: "serial",
    expected: "a short register or artefact number",
    guidance: "Preserve Arabic or Western digits, slashes, dashes, parentheses, and a visibly written short prefix. Never turn it into a sentence or copy the neighbouring location.",
    maxLength: 32,
    validate: (value) => /[0-9٠-٩]/u.test(value) && value.split(/\s+/u).length <= 4,
  },
  {
    key: "location",
    expected: "a short find-place, box, room, shelf, or storage-location phrase",
    guidance: "Read only the location phrase. Do not copy the serial on one side or an object description on the other. A visible ditto mark may be returned exactly as written.",
    maxLength: 100,
    validate: (value) => value.split(/\s+/u).length <= 14,
  },
  {
    key: "description",
    expected: "a free-text description of the artefact",
    guidance: "This field may contain several handwritten lines. Preserve the wording and line content; never infer an object, period, material, or missing ending from the pasted photograph.",
    maxLength: 900,
    validate: () => true,
  },
  {
    key: "period",
    expected: "a short archaeological date, period, dynasty, or attribution",
    guidance: "This is the artefact's historical date or period, not the register-entry date. Preserve a visible term such as a period name, dynasty, or explicit date without expanding it from context.",
    maxLength: 80,
    validate: (value) => value.split(/\s+/u).length <= 12,
  },
  {
    key: "material",
    expected: "one short material name or an explicit ditto abbreviation",
    guidance: "Return only the material. Never copy words from the description or period columns. If Latin ‘do.’ is visibly written, return exactly ‘do.’; do not append فوق or other neighbouring words. The reference vocabulary is a spelling aid, not permission to choose a material when the strokes are unclear.",
    maxLength: 60,
    validate: (value) => /^(?:do\.?|[\p{Script=Arabic}\s.،()-]+)$/iu.test(value) && value.split(/\s+/u).length <= 6 && !/[0-9٠-٩]/u.test(value),
  },
  {
    key: "dimensions",
    expected: "short dimensions or measurements",
    guidance: "Preserve every visible number, decimal mark, multiplication sign, unit, and orientation. Do not calculate, convert units, or borrow a number from another row.",
    maxLength: 64,
    validate: (value) => /[0-9٠-٩]/u.test(value) && value.split(/\s+/u).length <= 8,
  },
];
// Accepts only readings supported by two independent OCR passes, with each pass
// seeing only original and evidence-preserving OpenCV views. SwinIR is generated
// solely for operator comparison and is never OCR evidence. A reviewer guess is
// not evidence when the source pixels do not hold enough handwriting detail.
//
// v10 read the six columns concurrently, let a column that could not be read
// degrade to [؟] instead of failing the page, and refused to cache a run that
// lost columns. v11 cuts records on boundaries detected from the page rather
// than ten even bands, and retires every earlier entry: those were transcribed
// from cells that drifted by up to a full row down the sheet.
const HTR_PIPELINE_VERSION = "register-cell-paired-evidence-v17-plate-geometry";
const MIN_REGISTER_AGREEMENT = 0.75;
const REGISTER_TEXT_COLUMN_COUNT = 6;

const taskInstructions: Record<string, string> = {
  extract: "Find every pasted or mounted photographic image panel containing an artifact. Include small, dark, or low-contrast photographs, but require a distinct rectangular photo or mounting-paper boundary. Exclude handwriting, printed cells, labels, page stamps, circular seals inked directly on the register, and the page itself. Return exactly one item per photographic panel and do not merge touching photographs. Name and classify the artifact visible inside each panel, never the photographic panel itself. Include a precise normalized bounding box using coordinates from 0 to 1000.",
  classify: "Identify the visual material and assign useful archival categories. Be conservative and flag ambiguity.",
  transcribe: "Transcribe all visible text faithfully. Preserve Arabic as Arabic, preserve line order where possible, and do not guess illegible writing.",
  summarize: "Summarize the source and identify important people, places, dates, object types, and unresolved details.",
  catalogue: "This is a ruled register sheet. Account for every photograph pasted on it. Do not transcribe the handwritten table in this pass; a separate isolated-cell verifier handles it. Set table to null.",
};

function bytesToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function parseTable(value: unknown): { columns: string[]; rows: string[][] } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { columns?: unknown; rows?: unknown };
  const columns = Array.isArray(candidate.columns)
    ? candidate.columns.map((entry) => typeof entry === "string" ? entry : "").filter(Boolean)
    : [];
  const rows = Array.isArray(candidate.rows)
    ? candidate.rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => row.map((cell) => cell === null || cell === undefined ? "" : String(cell)))
      .filter((row) => row.some((cell) => cell.trim()))
    : [];
  if (!columns.length || !rows.length) return null;
  return { columns, rows };
}

function parseModelJson(content: string): AnalysisResult {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as Partial<AnalysisResult>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : cleaned,
      items: Array.isArray(parsed.items) ? parsed.items.map((item) => ({
        title: typeof item?.title === "string" ? item.title : "Detected item",
        category: typeof item?.category === "string" ? item.category : "Uncategorized",
        description: typeof item?.description === "string" ? item.description : "",
        confidence: typeof item?.confidence === "number" ? Math.max(0, Math.min(1, item.confidence > 1 ? item.confidence / 100 : item.confidence)) : null,
        bbox: Array.isArray(item?.bbox) ? item.bbox.filter((value) => typeof value === "number") : null,
        source_index: typeof item?.source_index === "number" ? item.source_index : null,
        plate_serial: typeof item?.plate_serial === "string" && !/^\s*\[(?:\?|؟)\]\s*$/u.test(item.plate_serial)
          ? item.plate_serial.trim() || null
          : null,
      })) : [],
      transcription: typeof parsed.transcription === "string" ? parsed.transcription : null,
      table: parseTable(parsed.table),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === "string") : [],
      coordinate_space: parsed.coordinate_space === "ollama_pixels" ? "ollama_pixels" : parsed.coordinate_space === "pixels" ? "pixels" : "normalized_1000",
    };
  } catch {
    return { summary: cleaned, items: [], transcription: null, table: null, warnings: ["The model returned unstructured text."], coordinate_space: "normalized_1000" };
  }
}

function qualityEscalationReasons(result: AnalysisResult, task: string): string[] {
  if (task !== "catalogue" && task !== "transcribe") return [];
  const reasons: string[] = [];
  const warningText = result.warnings.join(" ");
  if (/illegible|unreadable|uncertain|low[- ]resolution|cannot read|can't read/i.test(warningText)) {
    reasons.push("the first pass flagged uncertain or unreadable writing");
  }

  if (task === "transcribe") {
    if (!result.transcription || result.transcription.trim().length < 40) {
      reasons.push("the transcription is missing or unusually short");
    }
    return reasons;
  }

  // Catalogue handwriting is handled by the isolated-cell consensus path.
  // The whole-page pass intentionally returns no table because its fluent
  // guesses are not safe archival evidence.
  if (!result.table) return reasons;
  if (result.table.columns.length < 4) reasons.push("too few table columns were recovered");
  if (!result.table.rows.length) reasons.push("no written rows were recovered");

  const cells = result.table.rows.flat();
  const nonBlank = cells.filter((cell) => cell.trim());
  const uncertain = nonBlank.filter((cell) => /\u061f|\ufffd|\[\s*\?\s*\]/u.test(cell)).length;
  if (nonBlank.length && uncertain >= Math.max(3, Math.ceil(nonBlank.length * 0.12))) {
    reasons.push("too many cells contain uncertain characters");
  }
  if (cells.length && nonBlank.length / cells.length < 0.18) {
    reasons.push("most recovered table cells are empty");
  }
  return reasons;
}

function ollamaVisionDimensions(width: number, height: number) {
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

type DetectorTuning = { prompt: string; boxThreshold: number; textThreshold: number };

async function locateEmbeddedImages(files: File[], tuning: DetectorTuning) {
  const baseUrl = (process.env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
  const detections: LocatedDetection[] = [];
  let detectorModel = "Grounding DINO";

  for (let sourceIndex = 0; sourceIndex < files.length; sourceIndex += 1) {
    const body = new FormData();
    body.append("file", files[sourceIndex], files[sourceIndex].name);
    if (tuning.prompt) body.append("prompt", tuning.prompt);
    body.append("box_threshold", String(tuning.boxThreshold));
    body.append("text_threshold", String(tuning.textThreshold));
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/detect`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError"
        ? "The detector timed out while loading or analyzing the page."
        : `The local image detector is offline at ${baseUrl}.`;
      throw new Error(`${reason} Start the complete system with 'npm run start:local'.`);
    }
    const payload = await response.json() as DetectorResponse;
    if (!response.ok) {
      throw new Error(payload.detail || `The local detector returned ${response.status}.`);
    }
    detectorModel = payload.model || detectorModel;
    for (const item of payload.items ?? []) {
      if (!Array.isArray(item.bbox) || item.bbox.length !== 4 || !item.bbox.every(Number.isFinite)) continue;
      detections.push({
        bbox: item.bbox.map(Math.round),
        score: typeof item.score === "number" ? Math.max(0, Math.min(1, item.score)) : null,
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "embedded image",
        sourceIndex,
      });
    }
  }

  return { detections, detectorModel };
}

function detectorCategory(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("photograph")) return "Photograph";
  if (normalized.includes("illustration") || normalized.includes("drawing")) return "Illustration";
  if (normalized.includes("tablet") || normalized.includes("artifact")) return "Archaeological artifact";
  return "Embedded visual material";
}

type GeminiReply = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
type OpenRouterReply = {
  model?: string;
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { message?: string };
};
type CloudProvider = "gemini" | "openrouter";
const GEMINI_MODEL_COOLDOWN_MS = 5 * 60_000;
const geminiModelUnavailableUntil = new Map<string, number>();

// Cloud fallback. Only reached when the operator both sets GEMINI_API_KEY and
// explicitly selects the Gemini provider for the run, because it uploads the
// source images off this machine.
async function askGemini(candidates: string[], apiKey: string, prompt: string, images: string[], mimes: string[], unusable = new Set<string>()) {
  const now = Date.now();
  const queue = [...new Set(candidates.filter(Boolean))].filter((name) =>
    !unusable.has(name) && (geminiModelUnavailableUntil.get(name) ?? 0) <= now
  );
  let lastMessage = candidates.length && !queue.length
    ? "Every candidate Gemini model is temporarily cooling down after a quota or overload response."
    : "Gemini could not be reached.";

  // Walk the candidate list: a model can be retired (Google names its
  // replacement in the error) or simply overloaded, and neither should end the
  // run while another usable model is available.
  while (queue.length) {
    const active = queue.shift() as string;
    if (unusable.has(active)) continue;
    let redirected = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      let payload: GeminiReply;
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(active)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                ...images.map((data, index) => ({ inline_data: { mime_type: mimes[index] ?? "image/jpeg", data } })),
              ],
            }],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
              ...(/^gemini-3\.(?:5|6)-flash(?:-|$)/.test(active)
                ? { thinkingConfig: { thinkingLevel: "low" } }
                : {}),
            },
          }),
          signal: AbortSignal.timeout(Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 60_000),
        });
        payload = await response.json() as GeminiReply;
      } catch (error) {
        lastMessage = error instanceof Error && error.name === "TimeoutError"
          ? `${active} did not respond within the Gemini request deadline.`
          : error instanceof Error ? error.message : `${active} could not be reached.`;
        geminiModelUnavailableUntil.set(active, Date.now() + GEMINI_MODEL_COOLDOWN_MS);
        unusable.add(active);
        if (queue.length) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }

      if (response.ok && !payload.error) {
        const text = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error("Gemini returned an empty response.");
        geminiModelUnavailableUntil.delete(active);
        return { text, model: active };
      }

      lastMessage = payload.error?.message || `Gemini returned ${response.status}.`;

      const replacement = lastMessage.match(/use\s+models\/([A-Za-z0-9.-]+)/)?.[1];
      if (replacement && replacement !== active && !queue.includes(replacement)) {
        queue.unshift(replacement);
        redirected = true;
        break;
      }

      // A 429 that names a quota is not a busy signal: this key has no allowance
      // for that model at all, so a second attempt only delays the fallback.
      const exhausted = response.status === 429 && /quota|billing/i.test(lastMessage);
      const overloaded = response.status === 503
        && /high demand|overload|temporar|unavailable/i.test(lastMessage);
      if (exhausted || overloaded) {
        geminiModelUnavailableUntil.set(active, Date.now() + GEMINI_MODEL_COOLDOWN_MS);
        unusable.add(active);
        if (queue.length) break;
      }
      const transient = !exhausted && (response.status === 503 || response.status === 429);
      if (!transient) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // This model is spent for the rest of the request. Recording it stops the
    // sibling column reads from paying the same quota wall and overload timeout
    // all over again — the difference between one slow call and twelve.
    if (!redirected) unusable.add(active);
  }

  throw new Error(lastMessage);
}

function openRouterText(payload: OpenRouterReply) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("").trim();
}

async function askOpenRouter(model: string, apiKey: string, prompt: string, images: string[], mimes: string[]) {
  let outputTokenBudget = Math.max(
    1,
    Math.min(
      128_000,
      Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS) || DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS,
    ),
  );
  const requestBody = () => JSON.stringify({
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((data, index) => ({
          type: "image_url",
          image_url: { url: `data:${mimes[index] || "image/jpeg"};base64,${data}` },
        })),
      ],
    }],
    max_completion_tokens: outputTokenBudget,
    response_format: { type: "json_object" },
    provider: { allow_fallbacks: false, require_parameters: true },
  });
  let lastMessage = "OpenRouter could not be reached.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Seshat Archive Extraction",
      },
      body: requestBody(),
      signal: AbortSignal.timeout(300_000),
    });
    const raw = await response.text();
    let payload: OpenRouterReply = {};
    try {
      payload = raw ? JSON.parse(raw) as OpenRouterReply : {};
    } catch {
      payload = {};
    }
    if (response.ok && !payload.error) {
      const text = openRouterText(payload);
      if (!text) throw new Error("OpenRouter returned an empty response.");
      return { text, model: payload.model || model, provider: "openrouter" as const };
    }
    lastMessage = payload.error?.message || `OpenRouter returned ${response.status}.`;
    const creditLimit = response.status === 402
      ? creditAwareOpenRouterLimit(lastMessage, outputTokenBudget)
      : null;
    if (creditLimit && attempt < 2) {
      outputTokenBudget = creditLimit;
      continue;
    }
    const transient = [404, 429, 502, 503].includes(response.status);
    if (!transient || attempt >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  throw new Error(lastMessage);
}

async function askCloud(
  mode: "auto" | CloudProvider,
  geminiCandidates: string[],
  geminiKey: string,
  openRouterModel: string,
  openRouterKey: string,
  prompt: string,
  images: string[],
  mimes: string[],
) {
  if (mode === "openrouter") {
    if (!openRouterKey) throw new Error("The OpenRouter model is selected, but OPENROUTER_API_KEY is not set on the server.");
    return askOpenRouter(openRouterModel, openRouterKey, prompt, images, mimes);
  }

  if (mode === "gemini") {
    if (!geminiKey) throw new Error("The Gemini model is selected, but GEMINI_API_KEY is not set on the server.");
    const reply = await askGemini(geminiCandidates, geminiKey, prompt, images, mimes);
    return { ...reply, provider: "gemini" as const };
  }

  let geminiError = "";
  if (geminiKey) {
    try {
      const reply = await askGemini(geminiCandidates, geminiKey, prompt, images, mimes);
      return { ...reply, provider: "gemini" as const };
    } catch (error) {
      geminiError = error instanceof Error ? error.message : "Gemini failed.";
    }
  } else {
    geminiError = "GEMINI_API_KEY is not set.";
  }

  if (openRouterKey) {
    try {
      return await askOpenRouter(openRouterModel, openRouterKey, prompt, images, mimes);
    } catch (error) {
      const openRouterError = error instanceof Error ? error.message : "OpenRouter failed.";
      throw new Error(`Gemini failed: ${geminiError} OpenRouter fallback also failed: ${openRouterError}`);
    }
  }
  throw new Error(`${geminiError} OpenRouter fallback is not configured.`);
}

type VerifiedRegister = {
  table: RegisterTable;
  disagreements: number;
  verifiedCells: number;
  candidateCells: number;
  agreementRate: number;
  accepted: boolean;
  totalCells: number;
  firstModel: string;
  reviewModel: string;
  enhancementVariants?: string[];
  secondaryVariants?: string[];
  enhancementWarning?: string | null;
  /** Whether the record boundaries were read off the page or merely assumed. */
  geometrySource?: string;
  geometryWarning?: string | null;
  /** Printed column headers whose two reading passes could not be completed. */
  unverifiedColumns?: string[];
  enhancementPreview?: EnhancementPreview | null;
  sourceWidth?: number;
  sourceHeight?: number;
  cacheHit?: boolean;
};

function stripJsonFence(content: string) {
  return content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function normalizeRegisterCell(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKC")
    .replace(/\[\s*[?؟]\s*\]/gu, "[؟]")
    .replace(/\s+/gu, " ")
    .trim();
}

async function preparePlateLabels(file: File, boxes: number[][]): Promise<PreparedPlateLabel[]> {
  const baseUrl = (process.env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("boxes", JSON.stringify(boxes));
  const response = await fetch(`${baseUrl}/prepare-plate-labels`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json() as { labels?: PreparedPlateLabel[]; detail?: string };
  if (!response.ok || !Array.isArray(payload.labels)) {
    throw new Error(payload.detail || "The plate labels could not be isolated.");
  }
  return payload.labels;
}

export function parsePlateSerials(content: string, count: number) {
  try {
    const parsed = JSON.parse(stripJsonFence(content)) as { serials?: unknown } | unknown[];
    const serials = Array.isArray(parsed) ? parsed : Array.isArray(parsed.serials) ? parsed.serials : [];
    return Array.from({ length: count }, (_, index) => {
      const raw = serials[index];
      const candidate = raw && typeof raw === "object"
        ? (raw as { serial?: unknown; value?: unknown; label?: unknown }).serial
          ?? (raw as { value?: unknown }).value
          ?? (raw as { label?: unknown }).label
        : raw;
      const value = typeof candidate === "string"
        ? candidate.trim()
        : typeof candidate === "number" && Number.isFinite(candidate)
          ? String(candidate)
          : "";
      return value && /[0-9٠-٩۰-۹]/u.test(value) && value.length <= 24 ? value : null;
    });
  } catch {
    return Array.from({ length: count }, () => null as string | null);
  }
}

function plateLabelPrompt(count: number) {
  return `Read the small physical serial label attached across the lower edge of each pasted archaeological photograph.
You receive ${count} label regions. Every region has exactly two consecutive images: first the original pixels, then an evidence-preserving OpenCV cleanup. Return one result per region in the same order.
Transcribe only the short serial visibly written on the paper label. Preserve its prefix, digits, slash, dash, and parentheses. Do not read the photographed artefact, register handwriting, captions, or row numbers outside the label. Do not infer a likely serial. Use null whenever the label is absent, clipped, or any digit is uncertain.
Every readable serial must be a JSON string, even when it contains digits only. Return one JSON object whose "serials" array contains exactly ${count} string-or-null entries in region order. Do not return an example or schema. Use null for unreadable regions.`;
}

async function readPlateSerialsLocally(labels: PreparedPlateLabel[], model: string) {
  const baseUrl = (process.env.QWEN_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const readings: Array<string | null> = [];
  // Two 420px evidence images use roughly 2.3k Qwen vision tokens. Sending all
  // nine labels together used ~19k tokens and exceeded the model's 4096-token
  // context, causing one local failure to discard every plate on the page.
  // Isolate each label so its context and failure are independent.
  for (const label of labels) {
    try {
      const images = label.views.map((view) => view.image);
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          keep_alive: "8m",
          options: { temperature: 0, num_ctx: 4096, num_predict: 80 },
          messages: [{ role: "user", content: plateLabelPrompt(1), images }],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const payload = await response.json() as OllamaResponse;
      if (!response.ok || payload.error) throw new Error(payload.error || `The local plate-label reader returned ${response.status}.`);
      readings.push(parsePlateSerials(payload.message?.content ?? "", 1)[0]);
    } catch {
      readings.push(null);
    }
  }
  return readings;
}

async function verifyPlateSerials(
  files: File[],
  detections: LocatedDetection[],
  apiKey: string,
  selectedModel: string,
  fallbacks: string[],
) {
  const output: VerifiedPlateLabel[] = Array.from(
    { length: detections.length },
    () => ({ serial: null, bbox: null }),
  );
  for (let sourceIndex = 0; sourceIndex < files.length; sourceIndex += 1) {
    const indexed = detections.map((detection, index) => ({ detection, index }))
      .filter((entry) => entry.detection.sourceIndex === sourceIndex);
    if (!indexed.length) continue;
    const labels = await preparePlateLabels(files[sourceIndex], indexed.map((entry) => entry.detection.bbox));
    if (!labels.length) continue;
    const images = labels.flatMap((label) => label.views.map((view) => view.image));
    const mimes = images.map(() => "image/png");
    const prompt = plateLabelPrompt(labels.length);
    const cloud = await askGemini([selectedModel, ...fallbacks], apiKey, prompt, images, mimes);
    const cloudSerials = parsePlateSerials(cloud.text, labels.length);
    const localSerials = await readPlateSerialsLocally(labels, LOCAL_REVIEW_MODEL);
    labels.forEach((label, labelIndex) => {
      const cloudValue = cloudSerials[labelIndex];
      const localValue = localSerials[labelIndex];
      const globalIndex = indexed[label.index]?.index;
      if (globalIndex === undefined) return;
      // Gemini is the selected provider and the stronger tiny-label reader.
      // Qwen is an abstention fallback, not a veto: the 7B model can produce a
      // confident conflicting digit on these few-pixel labels. A reading still
      // cannot attach a photo unless the client matcher finds one unique row
      // serial in a physically compatible register row.
      output[globalIndex] = {
        serial: cloudValue || localValue || null,
        bbox: label.method === 'tag' && label.bbox?.length === 4 ? label.bbox : null,
      };
    });
  }
  return output;
}

function normalizeMaterialReading(value: string) {
  const normalized = normalizeRegisterCell(value);
  if (/^(?:do\.?\s*فوق|فوق\s*do\.?)$/iu.test(normalized)) return "do.";
  if (/^do$/iu.test(normalized)) return "do.";
  return normalized
    .replace(/^حجر\s+رملى$/u, "حجر رملي")
    .replace(/^حجر\s+جيرى$/u, "حجر جيري");
}

export function normalizeRegisterColumnReading(columnIndex: number, value: unknown) {
  const normalized = normalizeRegisterCell(value);
  return columnIndex === MATERIAL_COLUMN_INDEX ? normalizeMaterialReading(normalized) : normalized;
}

export function isPlausibleRegisterColumnReading(columnIndex: number, value: unknown) {
  const normalized = normalizeRegisterColumnReading(columnIndex, value);
  if (isUncertainRegisterCell(normalized)) return true;
  const profile = REGISTER_COLUMN_PROFILES[columnIndex];
  if (!profile) return true;
  return normalized.length <= profile.maxLength && profile.validate(normalized);
}

function isUncertainRegisterCell(value: string) {
  return !value || value === "[؟]";
}

function comparableArabic(value: string) {
  return normalizeRegisterCell(value)
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, "")
    .replace(/\u0640/gu, "")
    .replace(/[أإآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function readingsAgree(left: string, right: string, columnIndex = -1) {
  const first = comparableArabic(normalizeRegisterColumnReading(columnIndex, left));
  const second = comparableArabic(normalizeRegisterColumnReading(columnIndex, right));
  if (!first || !second) return false;
  return first === second;
}

/**
 * A rejected register must never expose fluent single-pass guesses as if they
 * were transcription. Keep only exact two-model consensus values, mark every
 * surviving value for human review, and leave disagreements as [؟].
 */
export function buildDiagnosticReviewTable(verified: VerifiedRegister["table"]) {
  const reviewCells = new Set(verified.review_cells ?? []);
  const rows = verified.rows.map((verifiedRow, rowIndex) =>
    REGISTER_COLUMNS.map((_, columnIndex) => {
      const matchedValue = normalizeRegisterCell(verifiedRow[columnIndex]);
      if (!isUncertainRegisterCell(matchedValue)) {
        reviewCells.add(`${rowIndex}:${columnIndex}`);
        return matchedValue;
      }
      return matchedValue || "[?]";
    }),
  );
  return {
    table: {
      columns: [...REGISTER_COLUMNS],
      rows,
      row_bounds: verified.row_bounds,
      source_height: verified.source_height,
      review_cells: [...reviewCells],
      alternatives: verified.alternatives ?? [],
    },
    proposedCells: verified.alternatives?.length ?? 0,
  };
}

function parseRegisterColumn(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const candidate = parsed as { cells?: unknown; rows?: unknown };
  const rawCells = Array.isArray(candidate.cells)
    ? candidate.cells
    : Array.isArray(candidate.rows) ? candidate.rows.flat() : [];
  return Array.from({ length: REGISTER_ROW_COUNT }, (_, rowIndex) =>
    normalizeRegisterCell(rawCells[rowIndex]));
}

type PreparedRegisterCellVariant = { kind: string; image: string; width?: number; height?: number; scale?: number };
type PreparedRegisterCell = {
  row: number;
  column: number;
  bbox: number[];
  image: string;
  ink_ratio?: number;
  variants?: PreparedRegisterCellVariant[];
  reference_variants?: PreparedRegisterCellVariant[];
};

type RegisterColumnHints = { material: string[] };

function parseRegisterColumnHints(raw: string): RegisterColumnHints {
  try {
    const parsed = JSON.parse(raw) as { material?: unknown };
    const material = Array.isArray(parsed?.material)
      ? parsed.material
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeMaterialReading(value))
        .filter((value) => value && value !== "[؟]" && isPlausibleRegisterColumnReading(MATERIAL_COLUMN_INDEX, value))
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 30)
      : [];
    return { material };
  } catch {
    return { material: [] };
  }
}

async function prepareRegisterCells(file: File) {
  const baseUrl = (process.env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("rows", String(REGISTER_ROW_COUNT));
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/prepare-register-cells`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`The local image preparation service is offline at ${baseUrl}.`);
  }
  const payload = await response.json() as {
    cells?: PreparedRegisterCell[];
    rows?: number;
    columns?: number;
    image?: { width?: number; height?: number };
    enhancement?: { pipeline?: string; swinir?: boolean; variants?: string[]; warning?: string | null };
    geometry?: { source?: string; columns_agreeing?: number; row_bounds?: number[]; warning?: string | null };
    source_hash?: string;
    detail?: string;
  };
  if (!response.ok || !Array.isArray(payload.cells)
    || payload.cells.length !== REGISTER_ROW_COUNT * REGISTER_TEXT_COLUMN_COUNT) {
    throw new Error(payload.detail || "The register cell crops could not be prepared.");
  }
  return {
    cells: payload.cells,
    width: payload.image?.width ?? 0,
    height: payload.image?.height ?? 0,
    sourceHash: payload.source_hash || createHash("sha256").update(payload.cells.map((cell) => cell.image).join("|")).digest("hex"),
    enhancementVariants: payload.enhancement?.variants?.filter(Boolean) ?? ["opencv"],
    enhancementWarning: payload.enhancement?.warning || null,
    geometrySource: payload.geometry?.source ?? "unknown",
    geometryWarning: payload.geometry?.warning || null,
    rowBounds: payload.geometry?.row_bounds?.filter(Number.isFinite) ?? [],
  };
}

function buildEnhancementPreview(
  cells: PreparedRegisterCell[],
  width: number,
  height: number,
): EnhancementPreview | null {
  const candidates = cells.filter((cell) =>
    (cell.reference_variants && cell.reference_variants.length >= 2)
    || (cell.variants && cell.variants.length >= 2));
  const cell = candidates.sort((left, right) => (right.ink_ratio ?? 0) - (left.ink_ratio ?? 0))[0];
  const referenceVariants = cell?.reference_variants?.length ? cell.reference_variants : cell?.variants;
  if (!referenceVariants?.length) return null;
  return {
    row: cell.row,
    column: cell.column,
    columnLabel: REGISTER_COLUMNS[cell.column] ?? `Column ${cell.column + 1}`,
    bbox: cell.bbox,
    sourceWidth: width,
    sourceHeight: height,
    variants: referenceVariants.map((variant) => ({
      kind: variant.kind,
      imageUrl: `data:image/png;base64,${variant.image}`,
      width: variant.width,
      height: variant.height,
      scale: variant.scale,
    })),
  };
}

function registerColumnPrompt(columnIndex: number, variants: string[], learnedHints: string[] = []) {
  const column = REGISTER_COLUMNS[columnIndex];
  const variantList = variants.join(", ");
  const profile = REGISTER_COLUMN_PROFILES[columnIndex];
  const materialVocabulary = columnIndex === MATERIAL_COLUMN_INDEX
    ? [...MATERIAL_REFERENCE_TERMS, ...learnedHints].filter((value, index, values) => values.indexOf(value) === index).slice(0, 50)
    : [];
  const columnGuidance = profile
    ? `\nColumn-specific profile (${profile.key}):\n- Expected content: ${profile.expected}.\n- ${profile.guidance}\n${materialVocabulary.length ? `- Reference spellings seen in this archive: ${materialVocabulary.join("، ")}. Use one only when its complete letter shapes are visible; otherwise use [؟].\n` : ""}- A familiar value is still not evidence: preserve [؟] wherever the source strokes do not support the reading.\n`
    : "";
  return `You are performing conservative handwritten-text recognition on an Egyptian Antiquities Service object register.

You receive exactly ${REGISTER_ROW_COUNT * variants.length} images for ${REGISTER_ROW_COUNT} isolated cells from the printed column "${column}". Images are grouped by row in top-to-bottom order. Every row has these ${variants.length} views in this exact order: ${variantList}. All views in a group show the same cell; return one reading for the group, not one reading per image.

The original view is authoritative evidence. OpenCV only adjusts illumination and contrast. No generative restoration is included in these OCR inputs. A reading must be supported by visible source strokes in both views.

Archival rules:
- Transcribe only marks actually visible inside each isolated cell. Do not describe, summarize, translate, modernize spelling, or complete a word from context.
- A plausible Arabic phrase is not evidence. If any character or word is not visually supported, write [؟] for that uncertain part.
- Use "" only for a cell that is visibly blank. Use [؟] when ink exists but cannot be read reliably.
- Preserve Arabic and Eastern Arabic numerals exactly as written.
- Do not use likely archaeological vocabulary to fill blurred strokes.
- Do not move text between images or invent missing rows.
${columnGuidance}

Return JSON only in exactly this shape:
{"cells":["row 1","row 2","row 3","row 4","row 5","row 6","row 7","row 8","row 9","row 10"]}
The cells array must contain exactly ${REGISTER_ROW_COUNT} strings.`;
}

// The verification pass deliberately runs on a different reader from the first.
// A local model is the default one: it costs no quota, and a separate
// architecture is a stronger independence check than a second cloud model from
// the same family. Set SESHAT_REVIEW_PROVIDER=gemini to use a cloud reviewer,
// which needs paid quota — the free tier allows 20 requests a day per model and
// a single page spends more than that.
const REVIEW_PROVIDER = (process.env.SESHAT_REVIEW_PROVIDER || "local").trim().toLowerCase();
const LOCAL_REVIEW_MODEL = process.env.SESHAT_REVIEW_MODEL || process.env.QWEN_MODEL || "qwen2.5vl:7b";
// The tiny material cells are the one field where the local reviewer repeatedly
// returned unreadable while the stronger cloud reader recovered stable short
// values. Use one stronger request for this column only; all other columns keep
// the configured reviewer. Set this to "local" to return to an entirely local
// second pass.
const MATERIAL_REVIEW_PROVIDER = (process.env.SESHAT_MATERIAL_REVIEW_PROVIDER || "gemini").trim().toLowerCase();

// Deliberately shows no example characters. An earlier version listed the
// Eastern Arabic numerals and the model copied that list back as its reading.
const localCellPrompt = (columnIndex: number) => {
  const column = REGISTER_COLUMNS[columnIndex] ?? `column ${columnIndex + 1}`;
  const profile = REGISTER_COLUMN_PROFILES[columnIndex];
  return `The two images show the same cell cut from the printed column "${column}" of a handwritten Arabic archival register.
The first image is the source crop and the second is an evidence-preserving contrast cleanup. Compare both views before answering.
Write out exactly the characters supported by the visible pen strokes, and nothing more.
${profile ? `This is ${profile.expected}. ${profile.guidance}` : ""}
If the cell has no writing at all, answer with an empty string.
If there is writing but you cannot make it out, answer with a single question mark.
Never guess a word from context and never describe the image.
Answer as JSON: {"text":"..."}`;
};

async function readRegisterCellLocally(cell: PreparedRegisterCell, model: string): Promise<string> {
  const baseUrl = (process.env.QWEN_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const images = ["original", "opencv"].map((kind) =>
    cell.variants?.find((variant) => variant.kind === kind)?.image).filter((image): image is string => Boolean(image));
  if (!images.length) images.push(cell.image);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      keep_alive: "6m",
      options: { temperature: 0, num_ctx: 4096, num_predict: 80 },
      messages: [{ role: "user", content: localCellPrompt(cell.column), images }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json() as OllamaResponse;
  if (!response.ok || payload.error) throw new Error(payload.error || `The local reader returned ${response.status}.`);
  let text: unknown;
  try {
    text = JSON.parse(stripJsonFence(payload.message?.content ?? "")).text;
  } catch {
    return "[؟]";
  }
  if (typeof text !== "string") return "[؟]";
  const trimmed = text.trim();
  // A bare question mark is the model reporting illegible ink, which is the
  // register's own [؟], not a character it claims to have read.
  if (trimmed === "?" || trimmed === "؟") return "[؟]";
  return normalizeRegisterColumnReading(cell.column, trimmed);
}

/** Read one printed column, one isolated cell at a time, on the local model. */
async function readRegisterColumnLocally(cells: PreparedRegisterCell[], model: string): Promise<string[]> {
  const readings: string[] = [];
  for (const cell of cells) {
    readings.push(await readRegisterCellLocally(cell, model));
  }
  return readings;
}

export function buildRegisterConsensus(first: string[][], second: string[][], firstModel: string, reviewModel: string, preferredSecondColumns = new Set<number>()): VerifiedRegister {
  let disagreements = 0;
  let verifiedCells = 0;
  let candidateCells = 0;
  const reviewCells: string[] = [];
  const alternatives: CellAlternative[] = [];
  const rows = Array.from({ length: REGISTER_ROW_COUNT }, (_, rowIndex) =>
    Array.from({ length: REGISTER_COLUMNS.length }, (_, columnIndex) => {
      if (columnIndex === REGISTER_COLUMNS.length - 1) return "";
      const left = normalizeRegisterColumnReading(columnIndex, first[rowIndex]?.[columnIndex]);
      const right = normalizeRegisterColumnReading(columnIndex, second[rowIndex]?.[columnIndex]);
      if (!isUncertainRegisterCell(left) || !isUncertainRegisterCell(right)) candidateCells += 1;
      const leftPlausible = isPlausibleRegisterColumnReading(columnIndex, left);
      const rightPlausible = isPlausibleRegisterColumnReading(columnIndex, right);
      if (!leftPlausible || !rightPlausible) {
        disagreements += 1;
        reviewCells.push(`${rowIndex}:${columnIndex}`);
        if (!isUncertainRegisterCell(left) || !isUncertainRegisterCell(right)) {
          alternatives.push(preferredSecondColumns.has(columnIndex)
            ? { row: rowIndex, column: columnIndex, first: right || "[?]", second: left || "[?]" }
            : { row: rowIndex, column: columnIndex, first: left || "[?]", second: right || "[?]" });
        }
        return left === "" && right === "" ? "" : "[؟]";
      }
      if (left === right) {
        if (!isUncertainRegisterCell(left)) verifiedCells += 1;
        if (left === "[؟]") reviewCells.push(`${rowIndex}:${columnIndex}`);
        return left;
      }
      if (!isUncertainRegisterCell(left) && !isUncertainRegisterCell(right) && readingsAgree(left, right, columnIndex)) {
        verifiedCells += 1;
        reviewCells.push(`${rowIndex}:${columnIndex}`);
        return right;
      }
      disagreements += 1;
      reviewCells.push(`${rowIndex}:${columnIndex}`);
      if (!isUncertainRegisterCell(left) || !isUncertainRegisterCell(right)) {
        alternatives.push(preferredSecondColumns.has(columnIndex)
          ? { row: rowIndex, column: columnIndex, first: right || "[?]", second: left || "[?]" }
          : { row: rowIndex, column: columnIndex, first: left || "[?]", second: right || "[?]" });
      }
      return left === "" && right === "" ? "" : "[؟]";
    }));
  const agreementRate = verifiedCells / Math.max(1, candidateCells);
  return {
    table: { columns: [...REGISTER_COLUMNS], rows, review_cells: reviewCells, alternatives },
    disagreements,
    verifiedCells,
    candidateCells,
    agreementRate,
    accepted: candidateCells > 0 && agreementRate >= MIN_REGISTER_AGREEMENT,
    totalCells: REGISTER_ROW_COUNT * (REGISTER_COLUMNS.length - 1),
    firstModel,
    reviewModel,
  };
}

async function readVerifiedRegisterCache(key: string): Promise<VerifiedRegister | null> {
  try {
    const value = JSON.parse(await readFile(join(process.cwd(), "data", "htr-cache", `${key}.json`), "utf8")) as VerifiedRegister;
    if (!value?.table?.rows?.length) return null;
    return { ...value, cacheHit: true };
  } catch {
    return null;
  }
}

async function writeVerifiedRegisterCache(key: string, result: VerifiedRegister) {
  const directory = join(process.cwd(), "data", "htr-cache");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${key}.json`), JSON.stringify(result, null, 2), "utf8");
}

async function verifyRegisterWithGemini(
  file: File,
  apiKey: string,
  selectedModel: string,
  fallbacks: string[],
  columnHints: RegisterColumnHints,
): Promise<VerifiedRegister> {
  const prepared = await prepareRegisterCells(file);
  const reviewModel = process.env.GEMINI_ESCALATION_MODEL || "gemini-3.5-flash";
  const key = createHash("sha256")
    .update([HTR_PIPELINE_VERSION, prepared.sourceHash, selectedModel, reviewModel, JSON.stringify(columnHints)].join("|"))
    .digest("hex");
  const enhancementPreview = buildEnhancementPreview(prepared.cells, prepared.width, prepared.height);
  const cached = await readVerifiedRegisterCache(key);
  if (cached) return { ...cached, enhancementPreview };

  const firstRows = Array.from({ length: REGISTER_ROW_COUNT }, () => Array.from({ length: REGISTER_COLUMNS.length }, () => ""));
  const secondRows = Array.from({ length: REGISTER_ROW_COUNT }, () => Array.from({ length: REGISTER_COLUMNS.length }, () => ""));
  const firstModels = new Set<string>();
  const reviewModels = new Set<string>();
  // Shared across all twelve calls below, so a model that runs out of quota
  // on one column is not retried on the remaining five.
  const unusableModels = new Set<string>();
  const commonVariants = prepared.enhancementVariants.filter((kind) =>
    prepared.cells.every((cell) => cell.variants?.some((variant) => variant.kind === kind)));
  // Generative restoration is prepared for visual review but deliberately
  // excluded from trusted OCR consensus after A/B testing reduced agreement.
  const evidenceVariants = commonVariants.filter((kind) => kind === "original" || kind === "opencv");
  const enhancementVariants = evidenceVariants.length ? evidenceVariants : ["opencv"];
  const secondaryVariants = commonVariants.filter((kind) => !enhancementVariants.includes(kind));

  // Each column is an independent read of the same page, so the six of them run
  // concurrently: twelve serial round trips became six parallel pairs. The two
  // passes inside one column stay sequential, because the review pass still
  // picks a model the first pass did not already use.
  const columnReadings = await Promise.all(
    Array.from({ length: REGISTER_TEXT_COLUMN_COUNT }, async (_, columnIndex) => {
      const columnCells = prepared.cells
        .filter((cell) => cell.column === columnIndex)
        .sort((left, right) => left.row - right.row);
      if (columnCells.length !== REGISTER_ROW_COUNT) throw new Error(`Column ${columnIndex + 1} did not contain ${REGISTER_ROW_COUNT} cell crops.`);
      const images = columnCells.flatMap((cell) => enhancementVariants.map((kind) =>
        cell.variants?.find((variant) => variant.kind === kind)?.image ?? cell.image));
      const mimes = images.map(() => "image/png");
      const prompt = registerColumnPrompt(
        columnIndex,
        enhancementVariants,
        columnIndex === MATERIAL_COLUMN_INDEX ? columnHints.material : [],
      );
      try {
        const firstReply = await askGemini([selectedModel, ...fallbacks], apiKey, prompt, images, mimes, unusableModels);
        // The reviewer is a different reader by design. Locally that means a
        // separate model on this machine; in the cloud it means a second Gemini
        // model, which the free tier cannot supply for a whole page.
        const useCloudReviewer = REVIEW_PROVIDER === "gemini"
          || (columnIndex === MATERIAL_COLUMN_INDEX && MATERIAL_REVIEW_PROVIDER === "gemini");
        let secondReply;
        if (useCloudReviewer) {
          try {
            secondReply = await askGemini(
              [reviewModel, ...fallbacks.filter((name) => name !== firstReply.model)],
              apiKey,
              `${prompt}

This is an independent verification pass. Judge every visible stroke again; do not copy or infer a likely reading.`,
              images,
              mimes,
              unusableModels,
            );
          } catch (cloudReviewError) {
            if (REVIEW_PROVIDER === "gemini") throw cloudReviewError;
            secondReply = {
              model: `${LOCAL_REVIEW_MODEL} (local fallback)`,
              cells: await readRegisterColumnLocally(columnCells, LOCAL_REVIEW_MODEL),
            };
          }
        } else {
          secondReply = {
            model: `${LOCAL_REVIEW_MODEL} (local)`,
            cells: await readRegisterColumnLocally(columnCells, LOCAL_REVIEW_MODEL),
          };
        }
        const preferSecond = columnIndex === MATERIAL_COLUMN_INDEX && !secondReply.model.includes("(local");
        return { columnIndex, firstReply, secondReply, preferSecond, failure: null as string | null };
      } catch (error) {
        // One column running out of model quota must not discard the columns
        // that did read. Its cells stay [؟]: unread and marked for a human,
        // never silently blank and never filled in from the other passes.
        return { columnIndex, firstReply: null, secondReply: null, preferSecond: false, failure: error instanceof Error ? error.message : "the column could not be read" };
      }
    }),
  );

  // Applied in column order so the recorded model list stays deterministic.
  const unverifiedColumns: string[] = [];
  const preferredSecondColumns = new Set<number>();
  let verificationFailure: string | null = null;
  for (const { columnIndex, firstReply, secondReply, preferSecond, failure } of columnReadings) {
    if (!firstReply || !secondReply) {
      unverifiedColumns.push(REGISTER_COLUMNS[columnIndex]);
      verificationFailure ??= failure;
      for (let rowIndex = 0; rowIndex < REGISTER_ROW_COUNT; rowIndex += 1) {
        firstRows[rowIndex][columnIndex] = "[؟]";
        secondRows[rowIndex][columnIndex] = "[؟]";
      }
      continue;
    }
    firstModels.add(firstReply.model);
    reviewModels.add(secondReply.model);
    if (preferSecond) preferredSecondColumns.add(columnIndex);
    const firstColumn = parseRegisterColumn(firstReply.text);
    const secondColumn = "cells" in secondReply ? secondReply.cells : parseRegisterColumn(secondReply.text);
    for (let rowIndex = 0; rowIndex < REGISTER_ROW_COUNT; rowIndex += 1) {
      firstRows[rowIndex][columnIndex] = firstColumn[rowIndex];
      secondRows[rowIndex][columnIndex] = secondColumn[rowIndex];
    }
  }
  if (unverifiedColumns.length === REGISTER_TEXT_COLUMN_COUNT) {
    throw new Error(verificationFailure ?? "no register column could be read");
  }
  const verified = {
    ...buildRegisterConsensus(firstRows, secondRows, [...firstModels].join(" + "), [...reviewModels].join(" + "), preferredSecondColumns),
    sourceWidth: prepared.width,
    sourceHeight: prepared.height,
    enhancementVariants,
    secondaryVariants,
    enhancementWarning: prepared.enhancementWarning,
    geometrySource: prepared.geometrySource,
    geometryWarning: prepared.geometryWarning,
    unverifiedColumns,
  };
  verified.table.row_bounds = prepared.rowBounds;
  verified.table.source_height = prepared.height;
  // Only a complete verification is worth remembering. Caching a run that lost
  // columns to a quota wall would freeze that outage into every later run on
  // this page, long after the quota came back.
  if (!unverifiedColumns.length) await writeVerifiedRegisterCache(key, verified);
  return { ...verified, enhancementPreview };
}

export async function POST(request: Request) {
  if (!await authenticatedUser(request)) return unauthorizedResponse();
  try {
    const form = await request.formData();
    // This product branch deliberately exposes one operation. Legacy helper
    // functions remain importable for old archived data, but new API requests
    // always take the detector-only extraction path.
    const task = "extract";
    const instruction = String(form.get("instruction") ?? "").trim();
    const requestedModel = String(form.get("model") ?? "").trim();
    const requestedProvider = String(form.get("provider") ?? "local");
    const provider: "local" | "auto" | CloudProvider = requestedProvider === "openrouter"
      ? "openrouter"
      : requestedProvider === "auto" ? "auto" : requestedProvider === "gemini" ? "gemini" : "local";
    const cloudRun = provider !== "local";
    const clampNumber = (value: FormDataEntryValue | null, min: number, max: number, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    };
    const tuning: DetectorTuning = {
      prompt: String(form.get("detector_prompt") ?? "").trim(),
      boxThreshold: clampNumber(form.get("box_threshold"), 0.05, 0.9, 0.22),
      textThreshold: clampNumber(form.get("text_threshold"), 0.05, 0.9, 0.18),
    };
    const rawDimensions = String(form.get("image_dimensions") ?? "[]");
    let imageDimensions: Array<{ width: number; height: number }> = [];
    try {
      const parsed = JSON.parse(rawDimensions) as Array<{ width?: unknown; height?: unknown }>;
      imageDimensions = Array.isArray(parsed) ? parsed.map((item) => ({
        width: typeof item.width === "number" ? Math.max(1, Math.round(item.width)) : 0,
        height: typeof item.height === "number" ? Math.max(1, Math.round(item.height)) : 0,
      })) : [];
    } catch {
      imageDimensions = [];
    }
    const columnHints = parseRegisterColumnHints(String(form.get("column_hints") ?? "{}"));
    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);

    if (!files.length) {
      return Response.json({ error: "Add at least one source file." }, { status: 400 });
    }
    if (files.length > 12) {
      return Response.json({ error: "A run can contain at most 12 source images. Start another batch for the remaining sources." }, { status: 400 });
    }

    const images: string[] = [];
    const imageMimes: string[] = [];
    const imageFiles: File[] = [];
    const textSources: string[] = [];
    const unsupported: string[] = [];

    for (const file of files) {
      if (file.type.startsWith("image/")) {
        if (file.size > 14 * 1024 * 1024) {
          unsupported.push(`${file.name} is larger than the 14 MB local limit.`);
          continue;
        }
        images.push(bytesToBase64(await file.arrayBuffer()));
        imageMimes.push(file.type || "image/jpeg");
        imageFiles.push(file);
      } else if (file.type.startsWith("text/") || /\.(txt|md|csv|json|xml)$/i.test(file.name)) {
        textSources.push(`\n--- ${file.name} ---\n${(await file.text()).slice(0, 120_000)}`);
      } else {
        unsupported.push(`${file.name} needs a document or media extraction adapter.`);
      }
    }

    if (!images.length && !textSources.length) {
      return Response.json({
        error: "Qwen is connected, but these files need preprocessing first. Use an image or plain-text file for this first integration.",
        warnings: unsupported,
      }, { status: 415 });
    }

    const startedAt = Date.now();
    // Cloud vision owns localization in cloud runs. Grounding DINO is useful
    // as a fast local-only option, but its coarse boxes are not safe enough to
    // seal as archival crops on these register pages.
    const located = provider === "local" && imageFiles.length && (task === "extract" || task === "catalogue")
      ? await locateEmbeddedImages(imageFiles, tuning)
      : { detections: [] as LocatedDetection[], detectorModel: "" };
    if (task === "extract" && provider === "local") {
      return Response.json({
        model: `${located.detectorModel} + OpenCV refinement`,
        duration_ms: Date.now() - startedAt,
        result: {
          summary: located.detections.length
            ? `Found ${located.detections.length} embedded visual regions and preserved their original source coordinates.`
            : "No embedded visual regions passed the local detector threshold.",
          items: located.detections.map((detection, index) => ({
            title: detection.label === "embedded image" ? `Embedded image ${index + 1}` : detection.label,
            category: detectorCategory(detection.label),
            description: `Detected visual region ${index + 1} in the source document. Use Categorize for a deeper Qwen description.`,
            confidence: detection.score,
            bbox: detection.bbox,
            source_index: detection.sourceIndex,
          })),
          transcription: null,
          table: null,
          warnings: located.detections.length ? [] : ["Try a clearer source image or adjust the detector thresholds."],
          coordinate_space: "pixels" as const,
        },
      });
    }
    const detectionGuide = located.detections.map((item, index) =>
      `Detection ${index + 1}: source ${item.sourceIndex}, bbox [${item.bbox.join(", ")}], detector label "${item.label}".`
    ).join("\n");

    const dimensionGuide = imageDimensions.map((size, index) => {
      const vision = ollamaVisionDimensions(size.width, size.height);
      return `Source image ${index}: original ${size.width} x ${size.height} pixels; Ollama vision canvas ${vision.width} x ${vision.height}. Return boxes on the Ollama canvas: x 0-${vision.width}, y 0-${vision.height}.`;
    }).join("\n");
    const prompt = `You are Seshat, a careful multimodal archival analysis system.

TASK
${taskInstructions[task] ?? taskInstructions.extract}

USER INSTRUCTIONS
${instruction || "Analyze the supplied source carefully."}

LANGUAGE
Write every user-visible value in Arabic: summary, title, category, description, and warnings. Keep only the JSON property names and technical coordinate values in their required form. Do not mention the provider or model name.

${task === "extract" ? `ARTIFACT NAMING
Describe the archaeological object visible inside each detected photograph. The title must be a short, specific Arabic identification based only on visible evidence, such as "لوحة حجرية منقوشة"، "قطعة حجرية تحمل كتابة"، "نقش دائري بارز"، or "جزء معماري مزخرف". Never use "لوحة فوتوغرافية"، "صورة فوتوغرافية"، "صورة أثرية"، "صورة أرشيفية"، or an ordinal number as the title or category. The category must describe the likely object type or material, not the photographic medium. The description must be one clear Arabic sentence stating the visible form, decoration, writing, material when supportable, and any uncertainty. Do not invent a date, dynasty, person, place, or material that is not visually supported.` : ""}

${(task === "extract" || task === "catalogue") && located.detections.length ? `AUTHORITATIVE VISUAL DETECTIONS
The dedicated detector found the regions listed below in original source pixels. Return exactly one item for every detection, in this exact order. Describe and categorize what is inside each region, but copy its bbox and source_index exactly. Do not add, remove, merge, split, or reposition detections.
For each detected photograph, inspect the small physical paper label attached to that photograph. Put only the label's visibly written serial in plate_serial, preserving Arabic or Western digits and any visible prefix, slash, dash, or parentheses. Use null when the label is absent or unreadable. Never infer this serial from the register row, the photograph's vertical position, or nearby handwriting.
${detectionGuide}` : task === "extract" && cloudRun ? `CLOUD VISUAL DETECTION
Locate every pasted or mounted photographic panel containing an artifact in each supplied source. Count the panels carefully from top to bottom before returning JSON, including small, dark, faded, and low-contrast panels. Each valid region must have a distinct rectangular photographic or mounting-paper boundary. Exclude handwriting, handwritten cells, printed text, table rules, physical number labels, page stamps, circular seals inked directly on the register, sparse page marks, and the full page itself. A photographed seal or inscription is valid only when it is visibly inside a separate rectangular pasted photograph. Return one tight bounding box for every distinct photographic panel using Gemini's native normalized 0-1000 order [top, left, bottom, right] (that is [y1, x1, y2, x2]), where 0 is the top/left edge and 1000 is the bottom/right edge of that source. Do not merge touching or overlapping photographs. source_index is the zero-based source order.` : ""}

SOURCE PIXEL DIMENSIONS
${dimensionGuide || "Use the actual pixel dimensions visible to you."}

OUTPUT
Return valid JSON only, with this exact shape:
{
  "summary": "concise overall finding",
  "coordinate_space": "${task === "extract" && cloudRun && !located.detections.length ? "normalized_1000" : task === "extract" ? "pixels" : "ollama_pixels"}",
  "items": [
    {
      "title": "short identifier",
      "category": "archival category",
      "description": "evidence-based description",
      "confidence": 0.0,
      "bbox": [100, 100, 500, 500],
      "source_index": 0,
      "plate_serial": "٢٤"
    }
  ],
  "transcription": null,
  "table": { "columns": ["column header as printed"], "rows": [["cell", "cell"]] },
  "warnings": []
}

${task === "catalogue"
  ? "For this catalogue pass, do not transcribe the handwritten register. Set table to null. A separate exact-consensus OCR stage handles isolated cells."
  : "If the source is a ruled register or table, fill table with the printed column order and one array per visible row. Use an empty string for a blank cell and [؟] for unreadable characters. Never invent a row. If the source is not tabular, set table to null."}

${task === "extract" ? (located.detections.length ? "For extraction, copy every authoritative bbox above exactly; those boxes use original source pixels." : "For cloud extraction, every bbox must be normalized to 0-1000 in [top, left, bottom, right] order. Validate top < bottom and left < right. Reject any candidate whose contents are only handwriting or printed text.") : "Bounding boxes must use the Ollama vision canvas coordinates listed above. Do not use original pixels and do not normalize to 0-1000. Validate that x2 and y2 remain within the listed Ollama canvas."} Use confidence values from 0 to 1. source_index is the zero-based position of the source image containing the item. Use null for confidence, bbox, or source_index when they cannot be supported. Never invent unreadable text. Include unsupported-source notes in warnings.
${unsupported.length ? `\nPREPROCESSING WARNINGS\n${unsupported.join("\n")}` : ""}
${textSources.join("\n")}`;

    let content: string;
    let usedModel: string;
    let usedProvider: "local" | CloudProvider | "mixed-cloud" = provider === "local"
      ? "local"
      : provider === "openrouter" ? "openrouter" : "gemini";
    let result: AnalysisResult | undefined;
    let firstModel: string | null = null;
    let escalationReasons: string[] = [];
    let verifiedPlateSerials: VerifiedPlateLabel[] | null = null;

    if (cloudRun) {
      const geminiKey = process.env.GEMINI_API_KEY || "";
      const openRouterKey = process.env.OPENROUTER_API_KEY || "";
      const allowedOpenRouterModels = configuredOpenRouterModels();
      const openRouterModel = provider === "openrouter"
        ? requestedModel || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL
        : process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
      if (provider === "openrouter" && !allowedOpenRouterModels.includes(openRouterModel)) {
        return Response.json({ error: "The requested analysis configuration is unavailable." }, { status: 400 });
      }
      if (!geminiKey && !openRouterKey) {
        return Response.json({ error: "The analysis service is not configured." }, { status: 400 });
      }
      usedModel = provider === "openrouter"
        ? openRouterModel
        : requestedModel === "gemini-3.5-flash"
          ? "gemini-3.6-flash"
          : requestedModel || process.env.GEMINI_ESCALATION_MODEL || "gemini-3.6-flash";
      const fallbacks = String(form.get("model_fallbacks") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      const geminiAvailabilityFallback = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";
      if (
        provider !== "openrouter"
        && geminiAvailabilityFallback !== usedModel
        && !fallbacks.includes(geminiAvailabilityFallback)
      ) {
        fallbacks.push(geminiAvailabilityFallback);
      }
      if (task === "extract" && requestedModel && requestedModel !== usedModel && !fallbacks.includes(requestedModel)) {
        fallbacks.push(requestedModel);
      }
      try {
        if (task === "extract" && images.length > 1) {
          const requestedConcurrency = Number(process.env.GEMINI_SOURCE_CONCURRENCY || 3);
          const concurrency = Math.max(
            1,
            Math.min(4, Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 3),
          );
          const analyzeSource = async (image: string, sourceIndex: number) => {
            const sourceDetections = located.detections.filter((item) => item.sourceIndex === sourceIndex);
            const sourceDetectionGuide = sourceDetections.map((item, index) =>
              `Detection ${index + 1}: source ${sourceIndex}, bbox [${item.bbox.join(", ")}], detector label "${item.label}".`
            ).join("\n");
            const sourceDimensionGuide = dimensionGuide.split("\n")[sourceIndex] || "";
            let sourcePrompt = prompt;
            if (located.detections.length) {
              sourcePrompt = sourcePrompt.replace(
                detectionGuide,
                sourceDetectionGuide || `Source ${sourceIndex}: the dedicated detector accepted no artifact panels.`,
              );
              if (sourceDimensionGuide) sourcePrompt = sourcePrompt.replace(dimensionGuide, sourceDimensionGuide);
            }
            sourcePrompt += `\n\nSOURCE ISOLATION\nOnly one source image is attached to this request. It is source_index ${sourceIndex} in the operator's batch. Analyze this image completely and set source_index to ${sourceIndex} on every returned item. Do not refer to or infer results from another source.${located.detections.length ? ` The dedicated detector accepted exactly ${sourceDetections.length} panel(s) in this source. Return exactly ${sourceDetections.length} item(s); do not add, omit, merge, or split them.` : ""}`;
            const sourceReply = await askCloud(
              provider,
              [usedModel, ...fallbacks],
              geminiKey,
              openRouterModel,
              openRouterKey,
              sourcePrompt,
              [image],
              [imageMimes[sourceIndex] ?? "image/jpeg"],
            );
            const sourceResult = parseModelJson(sourceReply.text);
            if (located.detections.length) {
              // Preserve one semantic slot per detector region. If the model
              // omits a description, final normalization supplies a safe
              // fallback without shifting later sources out of alignment.
              sourceResult.items = sourceDetections.map((_, detectionIndex) => {
                const item = sourceResult.items[detectionIndex];
                return item
                  ? { ...item, source_index: sourceIndex }
                  : {
                      title: "",
                      category: "",
                      description: "",
                      confidence: null,
                      bbox: null,
                      source_index: sourceIndex,
                      plate_serial: null,
                    };
              });
            } else {
              sourceResult.items = sourceResult.items.map((item) => ({ ...item, source_index: sourceIndex }));
            }
            return { result: sourceResult, model: sourceReply.model, provider: sourceReply.provider };
          };
          const sourceOutputs = await mapWithConcurrency(images, concurrency, analyzeSource);
          const sourceResults = sourceOutputs.map((entry) => entry.result);
          const sourceModels = sourceOutputs.map((entry) => entry.model);
          usedModel = sourceModels.at(-1) || usedModel;
          firstModel = sourceModels[0] || usedModel;
          const sourceProviders = [...new Set(sourceOutputs.map((entry) => entry.provider))];
          usedProvider = sourceProviders.length > 1 ? "mixed-cloud" : sourceProviders[0] || usedProvider;
          result = {
            summary: sourceResults.map((entry, index) => `المصدر ${index + 1}: ${entry.summary}`).join(" — "),
            items: sourceResults.flatMap((entry) => entry.items),
            transcription: null,
            table: null,
            warnings: sourceResults.flatMap((entry) => entry.warnings),
            coordinate_space: located.detections.length ? "pixels" : "normalized_1000",
          };
          content = JSON.stringify(result);
        } else {
        const reply = await askCloud(
          provider,
          [usedModel, ...fallbacks],
          geminiKey,
          openRouterModel,
          openRouterKey,
          prompt,
          images,
          imageMimes,
        );
        content = reply.text;
        usedModel = reply.model;
        usedProvider = reply.provider;
        firstModel = reply.model;
        result = parseModelJson(content);

        if (usedProvider === "gemini" && usedModel.includes("flash-lite")) {
          escalationReasons = qualityEscalationReasons(result, task);
          if (escalationReasons.length) {
            const escalationModel = process.env.GEMINI_ESCALATION_MODEL || "gemini-3.5-flash";
            const reviewPrompt = `${prompt}\n\nQUALITY REVIEW\nA low-cost first pass was incomplete for these reasons: ${escalationReasons.join("; ")}. Re-read the original source carefully, correct those weaknesses, and return a complete JSON result.`;
            try {
              const reviewed = await askCloud(
                provider === "auto" ? "auto" : "gemini",
                [escalationModel, ...fallbacks.filter((name) => !name.includes("flash-lite"))],
                geminiKey,
                openRouterModel,
                openRouterKey,
                reviewPrompt,
                images,
                imageMimes,
              );
              content = reviewed.text;
              usedModel = reviewed.model;
              usedProvider = reviewed.provider;
              result = parseModelJson(content);
              result.warnings.unshift(`Automatically escalated from ${firstModel} because ${escalationReasons.join("; ")}.`);
            } catch (error) {
              const reason = error instanceof Error ? error.message : "the stronger model was unavailable";
              result.warnings.unshift(`Flash-Lite completed this run, but automatic quality escalation failed: ${reason}`);
            }
          }
        }

        if (task === "catalogue" && imageFiles.length) {
          try {
            const verified = await verifyRegisterWithGemini(
              imageFiles[0],
              geminiKey,
              requestedModel || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
              fallbacks,
              columnHints,
            );
            result.enhancement_preview = verified.enhancementPreview;
            const coverage = Math.round(verified.agreementRate * 100);
            if (verified.accepted) {
              result.table = verified.table;
              result.handwriting_review = {
                status: "accepted",
                agreement: verified.agreementRate,
                verifiedCells: verified.verifiedCells,
                candidateCells: verified.candidateCells,
                enhancementVariants: verified.enhancementVariants,
                secondaryVariants: verified.secondaryVariants,
              };
              result.warnings.unshift(
                verified.cacheHit
                  ? `Loaded the saved two-pass handwriting verification for this unchanged page (${coverage}% model agreement).`
                  : `Handwriting was independently read by ${verified.firstModel} and ${verified.reviewModel}; ${coverage}% of candidate cells agreed.`,
              );
              if (verified.disagreements) {
                result.warnings.unshift(`${verified.disagreements} unsupported cell reading${verified.disagreements === 1 ? " was" : "s were"} withheld as [؟] for human review.`);
              }
            } else {
              const diagnostic = buildDiagnosticReviewTable(verified.table);
              result.table = null;
              result.review_table = diagnostic.table;
              result.handwriting_review = {
                status: "rejected",
                agreement: verified.agreementRate,
                verifiedCells: verified.verifiedCells,
                candidateCells: verified.candidateCells,
                proposedCells: diagnostic.proposedCells,
                enhancementVariants: verified.enhancementVariants,
                secondaryVariants: verified.secondaryVariants,
              };
              result.warnings.unshift(
                `${diagnostic.proposedCells} disagreement${diagnostic.proposedCells === 1 ? "" : "s"} retain the two isolated OCR readings as untrusted operator-review choices. No choice is archived automatically.`,
              );
              result.warnings.unshift(
                `Handwriting transcription rejected: the independent OCR passes agreed on only ${coverage}% of candidate cells. `
                + `The ${verified.sourceWidth ?? "unknown"} × ${verified.sourceHeight ?? "unknown"} source does not preserve enough pen-stroke detail for reliable automatic Arabic transcription. `
                + "Rescan one page at a time at 300–400 DPI (preferably PNG or TIFF). Image extraction remains available.",
              );
            }
            if (verified.geometryWarning) {
              result.warnings.unshift(verified.geometryWarning);
            }
            if (verified.unverifiedColumns?.length) {
              result.warnings.unshift(
                `${verified.unverifiedColumns.length} column${verified.unverifiedColumns.length === 1 ? "" : "s"} could not be read at all (${verified.unverifiedColumns.join(", ")}); every cell there stays [؟] rather than blank. This is usually the Gemini quota for the review model, not the page.`,
              );
            }
            if (verified.enhancementVariants?.length) {
              result.warnings.unshift(
                `Each isolated handwriting cell was compared across the evidence-preserving ${verified.enhancementVariants.join(", ")} views before the two-model consensus check.`,
              );
            }
            if (verified.secondaryVariants?.length) {
              result.warnings.unshift(
                `${verified.secondaryVariants.join(", ")} restoration is available as secondary visual evidence but is excluded from trusted OCR consensus because it may invent character strokes.`,
              );
            }
            if (verified.enhancementWarning) {
              result.warnings.unshift(`SwinIR enhancement was unavailable, so evidence-preserving views were used: ${verified.enhancementWarning}`);
            }
            if (imageFiles.length > 1) {
              result.warnings.push("Two-pass handwriting verification currently covers the first source page; analyze additional register pages as separate runs.");
            }
          } catch (error) {
            // An attractive but unverified table is more dangerous than no
            // table in an archive. Keep the image detections but suppress the
            // single-pass transcription when independent verification fails.
            result.table = null;
            const reason = error instanceof Error ? error.message : "the verification pass failed";
            result.warnings.unshift(`No handwriting table was sealed because independent verification failed: ${reason}`);
          }
          try {
            verifiedPlateSerials = await verifyPlateSerials(
              imageFiles,
              located.detections,
              geminiKey,
              requestedModel || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
              fallbacks,
            );
            const verifiedCount = verifiedPlateSerials.filter((entry) => entry.serial).length;
            result.warnings.unshift(
              `${verifiedCount} of ${located.detections.length} plate-label serials were read from enlarged label crops and checked against the register rows.`,
            );
          } catch (error) {
            verifiedPlateSerials = Array.from(
              { length: located.detections.length },
              () => ({ serial: null, bbox: null }),
            );
            const reason = error instanceof Error ? error.message : "the label verification failed";
            result.warnings.unshift(`Plate labels were not auto-linked because independent label verification failed: ${reason}`);
          }
        }
        }
      } catch (error) {
        console.error("[analysis] configured analysis service failed", error);
        return Response.json({ error: "The extraction service is temporarily unavailable. Please try again shortly." }, { status: 502 });
      }
    } else {
      const baseUrl = (process.env.QWEN_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
      const model = requestedModel || process.env.QWEN_MODEL || "qwen2.5vl:7b";
      const ollamaResponse = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          keep_alive: "10m",
          options: { temperature: 0.1, num_ctx: 4096, num_predict: 700 },
          messages: [{ role: "user", content: prompt, images }],
        }),
      });

      const payload = await ollamaResponse.json() as OllamaResponse;
      if (!ollamaResponse.ok || payload.error) {
        return Response.json({ error: payload.error || `Ollama returned ${ollamaResponse.status}.` }, { status: 502 });
      }

      const message = payload.message?.content?.trim();
      if (!message) {
        return Response.json({ error: "Qwen returned an empty response." }, { status: 502 });
      }
      content = message;
      usedModel = payload.model || model;
    }

    result ??= parseModelJson(content);
    if (provider !== "openrouter" && (usedProvider === "openrouter" || usedProvider === "mixed-cloud")) {
      result.warnings.unshift("The primary analysis service was unavailable, so the configured fallback completed this extraction.");
    }
    // Cloud object localization uses [top, left, bottom, right]
    // on a 0-1000 canvas. The archive and browser cropper use the conventional
    // [left, top, right, bottom] order, so transpose the axes exactly once at
    // the API boundary before the result is displayed or sealed.
    if (cloudRun && task === "extract" && !located.detections.length) {
      result.items = result.items.map((item) => {
        if (!item.bbox || item.bbox.length !== 4 || !item.bbox.every(Number.isFinite)) return item;
        const [top, left, bottom, right] = item.bbox;
        return { ...item, bbox: [left, top, right, bottom] };
      });
      result.coordinate_space = "normalized_1000";
    }
    if ((task === "extract" || task === "catalogue") && located.detections.length) {
      const semanticItems = result.items;
      result.items = located.detections.map((detection, index) => {
        const semantic = semanticItems[index];
        return {
          title: semantic?.title || `Embedded image ${index + 1}`,
          category: semantic?.category || detection.label,
          description: semantic?.description || `Detected ${detection.label} in the source document.`,
          confidence: detection.score,
          bbox: detection.bbox,
          source_index: detection.sourceIndex,
          // Never seal the whole-page model's tiny-label guess. Catalogue runs
          // use only the dedicated enlarged label crops; the row matcher then
          // requires a unique serial and compatible physical row.
          plate_serial: task === 'catalogue' ? verifiedPlateSerials?.[index]?.serial ?? null : semantic?.plate_serial ?? null,
          plate_label_bbox: task === 'catalogue' ? verifiedPlateSerials?.[index]?.bbox ?? null : null,
        };
      });
      result.coordinate_space = "pixels";
      if (located.detections.length && !result.items.some((item) => item.plate_serial)) {
        result.warnings.push("No attached plate-label serial was readable. Photos remain unlinked until an operator selects one or the source is re-read.");
      }
    } else if (images.length === 1) {
      result.items = result.items.map((item) => ({ ...item, source_index: 0 }));
    }
    result.items.sort((left, right) => {
      const sourceOrder = (left.source_index ?? 0) - (right.source_index ?? 0);
      if (sourceOrder) return sourceOrder;
      const verticalOrder = (left.bbox?.[1] ?? 0) - (right.bbox?.[1] ?? 0);
      return Math.abs(verticalOrder) > 24 ? verticalOrder : (right.bbox?.[0] ?? 0) - (left.bbox?.[0] ?? 0);
    });
    if (task !== "extract" && task !== "catalogue") result.coordinate_space = "ollama_pixels";

    return Response.json({
      model: task === "extract" && located.detectorModel ? `${located.detectorModel} + ${usedModel}` : usedModel,
      provider: usedProvider,
      routing: cloudRun ? {
        requested_provider: provider,
        final_provider: usedProvider,
        first_model: firstModel,
        final_model: usedModel,
        escalated: Boolean(firstModel && firstModel !== usedModel),
        openrouter_fallback: provider !== "openrouter"
          && (usedProvider === "openrouter" || usedProvider === "mixed-cloud"),
        reasons: escalationReasons,
      } : undefined,
      duration_ms: Date.now() - startedAt,
      raw: content.slice(0, 20_000),
      result,
    });
  } catch (error) {
    console.error("[analysis] extraction failed", error);
    return Response.json({ error: "The extraction could not be completed. Please try again." }, { status: 500 });
  }
}
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
