import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(root, "samples", "handwriting", "saqr");
const truth = JSON.parse(await readFile(join(fixtureDir, "ground-truth.json"), "utf8"));
const api = process.env.SESHAT_ANALYZE_URL || "http://127.0.0.1:3000/api/analyze";
const registersOnly = process.argv.includes("--registers-only");

function normalizeArabic(value = "") {
  return value.normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function characterErrorRate(reference, prediction) {
  const expected = normalizeArabic(reference);
  const actual = normalizeArabic(prediction);
  return editDistance(expected, actual) / Math.max(1, expected.length);
}

async function analyze(fileName, task, instruction) {
  const bytes = await readFile(join(fixtureDir, fileName));
  const form = new FormData();
  form.set("task", task);
  form.set("provider", "gemini");
  form.set("model", "gemini-3.5-flash-lite");
  form.set("model_fallbacks", "gemini-3.6-flash,gemini-2.5-flash");
  form.set("instruction", instruction);
  form.append("files", new File([bytes], fileName, { type: "image/jpeg" }));
  const response = await fetch(api, { method: "POST", body: form, signal: AbortSignal.timeout(360_000) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `Seshat returned ${response.status}.`);
  return payload;
}

let lineResults = [];
if (registersOnly) {
  try {
    lineResults = JSON.parse(await readFile(join(fixtureDir, "results.json"), "utf8")).line_results ?? [];
  } catch {
    lineResults = [];
  }
} else {
  for (const sample of truth.samples) {
    console.log(`transcribing ${sample.file}`);
    const payload = await analyze(sample.file, "transcribe", "Transcribe only the handwritten Arabic line. Preserve the words exactly and do not translate or explain.");
    const prediction = payload.result.transcription || "";
    lineResults.push({
      row: sample.row,
      file: sample.file,
      reference: sample.text,
      prediction,
      cer: characterErrorRate(sample.text, prediction),
      first_model: payload.routing?.first_model ?? payload.model,
      final_model: payload.routing?.final_model ?? payload.model,
      escalated: payload.routing?.escalated ?? false,
      duration_ms: payload.duration_ms,
    });
  }
}

const registerResults = [];
for (const document of truth.documents) {
  console.log(`reading ${document.file}`);
  const payload = await analyze(document.file, "catalogue", "Read each register row into table cells, preserve the Arabic handwriting exactly, and identify each plate image.");
  const expectedRows = document.rows.map((row) => truth.samples.find((sample) => sample.row === row));
  const returnedCells = (payload.result.table?.rows ?? []).flat();
  const rowScores = expectedRows.map((sample) => {
    const bestCer = returnedCells.length
      ? Math.min(...returnedCells.map((cell) => characterErrorRate(sample.text, cell)))
      : 1;
    return { row: sample.row, reference: sample.text, best_cell_cer: bestCer };
  });
  registerResults.push({
    file: document.file,
    difficulty: document.difficulty,
    expected_rows: expectedRows.length,
    returned_rows: payload.result.table?.rows?.length ?? 0,
    returned_columns: payload.result.table?.columns?.length ?? 0,
    detected_items: payload.result.items.length,
    mean_best_cell_cer: rowScores.reduce((sum, row) => sum + row.best_cell_cer, 0) / Math.max(1, rowScores.length),
    row_scores: rowScores,
    first_model: payload.routing?.first_model ?? payload.model,
    final_model: payload.routing?.final_model ?? payload.model,
    escalated: payload.routing?.escalated ?? false,
    escalation_reasons: payload.routing?.reasons ?? [],
    duration_ms: payload.duration_ms,
  });
}

const results = {
  generated_at: new Date().toISOString(),
  line_summary: {
    samples: lineResults.length,
    mean_cer: lineResults.reduce((sum, item) => sum + item.cer, 0) / Math.max(1, lineResults.length),
    escalated: lineResults.filter((item) => item.escalated).length,
  },
  line_results: lineResults,
  register_results: registerResults,
};

await writeFile(join(fixtureDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ line_summary: results.line_summary, register_results: registerResults.map((item) => ({
  file: item.file,
  returned_rows: item.returned_rows,
  returned_columns: item.returned_columns,
  detected_items: item.detected_items,
  mean_best_cell_cer: item.mean_best_cell_cer,
  first_model: item.first_model,
  final_model: item.final_model,
  escalated: item.escalated,
  duration_ms: item.duration_ms,
})) }, null, 2));
