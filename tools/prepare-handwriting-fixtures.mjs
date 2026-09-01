import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "samples", "handwriting", "saqr");
const endpoint = "https://datasets-server.huggingface.co/first-rows?dataset=mahmoudsalah01%2FSAQR&config=default&split=test";

const response = await fetch(endpoint);
if (!response.ok) throw new Error(`SAQR dataset server returned ${response.status}.`);
const payload = await response.json();
const selected = payload.rows.slice(0, 8).map(({ row_idx, row }) => ({
  row: row_idx,
  pair_id: row.pair_id,
  text: row.text,
  student_id: row.student_id,
  source_url: row.hw_image.src,
  file: `saqr-test-${String(row_idx).padStart(2, "0")}.jpg`,
}));

await mkdir(output, { recursive: true });
for (const item of selected) {
  const image = await fetch(item.source_url);
  if (!image.ok) throw new Error(`Image ${item.row} returned ${image.status}.`);
  await writeFile(join(output, item.file), Buffer.from(await image.arrayBuffer()));
  console.log(`downloaded ${item.file}`);
}

await writeFile(join(output, "ground-truth.json"), `${JSON.stringify({
  dataset: "SAQR: Paired Printed-Handwritten Arabic Line Dataset",
  source: "https://huggingface.co/datasets/mahmoudsalah01/SAQR",
  license: "CC-BY-4.0",
  split: "test",
  samples: selected.map(({ source_url: _sourceUrl, ...item }) => item),
  documents: [
    { file: "saqr-register-a.jpg", rows: selected.slice(0, 4).map((item) => item.row), difficulty: "clean structured page" },
    { file: "saqr-register-b-faded.jpg", rows: selected.slice(4, 8).map((item) => item.row), difficulty: "faded structured page" },
  ],
}, null, 2)}\n`, "utf8");

console.log(`saved ${selected.length} handwriting fixtures and ground truth`);
