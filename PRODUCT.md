# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cataloguing staff at one specific antiquities institution, working from bound
registers of the Egyptian Antiquities Service (مصلحة الآثار). They sit with a
scanned register sheet and need its contents turned into a structured record:
which artefacts the page lists, what each one is, and which pasted photograph
belongs to which entry. Seshat is a commissioned tool for that institution, not
a general-purpose product; the developer is not the day-to-day operator.

## Product Purpose

Turn one scan or an ordered batch of scans into a serialized, exportable image
collection. Seshat locates every embedded photograph, drawing, seal, map, or
illustration, crops it at original source resolution, and seals the result into
a local archive with a JSON manifest. Success is a folder an archivist can hand
on: permanently numbered image files with source names and crop coordinates.

Handwriting transcription and register-table analysis are intentionally out of
scope for this branch. Existing archived table data is preserved but not shown.

## Positioning

A dedicated open-vocabulary detector (Grounding DINO with OpenCV refinement)
owns the coordinates, and the vision-language model is only allowed to describe
and categorise what sits inside those fixed boxes. Crops are therefore cut from
original source pixels rather than from a model's guess at a bounding box, and
a model that fabricates prose cannot move, invent, or drop a region.

The unit of record is the artefact, not the page. Serial ownership follows a
permanent inventory UUID representing the physical storage location. Later
runs explicitly linked to that inventory continue its atomic counter, while a
new inventory begins its own sequence at one. Names remain descriptive and do
not become the permanent identity of already linked records.

## Operating Context

- Source material: Egyptian Antiquities Service register sheets. Printed ruled
  form with bilingual column headers (Arabic plus French/English), filled in by
  hand in cursive Arabic, with Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) in the
  number, date and dimension columns.
- Columns observed: رقم الأثر, موضع الأثر, وصف الأثر, تاريخ الأثر,
  المادة المصنوع منها, مقاييس الأثر, المصدر, المكتشف, رقم الأثر عند الكشف,
  تاريخ القيد, ملاحظات عامة, صورة الأثر ورسمه.
- Photographs are pasted onto the right-hand page, roughly level with the row
  they belong to. Stamps, signatures and marginal notes overlap the text.
- **Scan quality is the binding constraint.** The sample in hand is 1600×1131
  for a full double-page spread — roughly 10 px per handwritten line. At that
  resolution the cursive columns are unreadable, and every model tested (local
  Qwen2.5-VL and Gemini alike) fabricates plausible Arabic instead of failing.
  Usable transcription needs single-page scans at 300–400 DPI, grayscale,
  TIFF or PNG. This is an input problem no model choice solves.
- Printed headers, row numbers, material and date columns are recoverable at
  current resolution; the free-text description column is not.

## Capabilities and Constraints

- One operation: extract embedded images, crop original pixels, serialize, and
  archive. The dedicated local detector is the only analysis dependency.
- Runs and permanent inventory counters are stored in the browser's IndexedDB
  on the operator's machine. Export uses the
  File System Access API where available (Chromium), otherwise falls back to
  individual downloads.
- Known limits: 14 MB per source file and 12 ordered image sources per batch.
- Plate-to-row pairing is inferred from vertical position. It is a heuristic,
  is labelled as such in the interface, and can be overridden per row.
- **Undecided:** total volume of the digitisation job. Nobody has scoped whether
  this is one register, a full archive, or continuous intake, so batch
  throughput, resumability and storage ceilings are unresolved. IndexedDB in a
  single browser profile has not been validated beyond small runs.
- **Undecided:** whether corrected transcriptions will feed a fine-tuned
  handwriting model later.

## Brand Commitments

- The product is named **Seshat**, after the scribe deity of records.
- The interface direction is an ancient-Egyptian archival aesthetic; the user
  made this binding. `public/egyptian-lotus-relief.png` is a committed asset.
- Locality is a stated promise, not just a default: the interface tells the
  operator where their sources are going, and cloud analysis must stay an
  explicit, visible opt-in. Any copy asserting local-only handling has to change
  the moment a cloud provider is selected.

## Evidence on Hand

- `samples/register.jpg` — a real register sheet (1600×1131), the only source
  document tested against.
- `public/egyptian-lotus-relief.png` — the committed relief asset.
- `tools/gemini-htr.py` — harness that runs each model twice at temperature 0
  and diffs the runs, built because agreement between runs is the only cheap
  signal of guessing.
- Measured, not claimed: Gemini reads printed headers and row numbers reliably
  at current resolution; run-to-run agreement on the description column fell to
  0.199, and an upscaled single row produced identical fabricated text twice.
- **No ground truth exists.** No page has been transcribed by hand, so no
  accuracy figure for this material can be stated. Future work must not present
  a transcription as verified, and must not invent institution names, holdings,
  provenance, or catalogue numbers that are not on the sheet.

## Product Principles

1. A wrong reading is worse than a missing one. Unreadable content is marked,
   never completed from context.
2. The detector owns coordinates; the model only describes what is inside them.
3. Local by default, cloud only by explicit choice, and the interface always
   states which is in effect.
4. The artefact is the unit of record; its storage location owns the persistent serial sequence.
5. Human correction is authoritative, is stored with the record, and travels
   into the export.

## Accessibility & Inclusion

Arabic content must render right-to-left with a typeface that actually covers
Arabic; bilingual Arabic/Latin text appears throughout the source material and
the interface. No institution-specific accessibility standard has been
established.
