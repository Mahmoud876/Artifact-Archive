#!/usr/bin/env python
"""Evaluate Gemini models on handwritten Arabic register pages.

The point of this harness is not to get a transcription — it is to find out
whether a transcription can be trusted. A vision model asked to read damaged
handwriting will happily invent fluent Arabic, so every model is run more than
once at temperature 0 and the runs are diffed against each other. Fields that
change between identical requests are fields the model is guessing at.

Note the asymmetry: disagreement proves the model is guessing, but agreement
does NOT prove correctness - a model can hallucinate the same wrong reading
every time. Only comparison against a human transcription measures accuracy.

Usage (from the project root):

    py tools/gemini-htr.py samples/register.jpg
    py tools/gemini-htr.py samples/register.jpg --crop left --repeat 3
    py tools/gemini-htr.py samples/register.jpg --models gemini-3.1-pro-preview,gemini-2.5-flash
    py tools/gemini-htr.py samples/register.jpg --rows 10 --task lines

Needs Pillow. If the system Python lacks it, use the detector venv:
    vision-service\\.venv\\Scripts\\python.exe tools/gemini-htr.py ...
"""

from __future__ import annotations

import argparse
import base64
import difflib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
ROOT = Path(__file__).resolve().parent.parent

TABLE_PROMPT = """You are transcribing a page from an Egyptian Antiquities Service (مصلحة الآثار) object register.
The page is a printed ruled form filled in by hand in Arabic. Columns, right to left:
رقم الأثر (number), موضع الأثر (position), وصف الأثر (description), تاريخ الأثر (date),
المادة المصنوع منها (material), مقاييس الأثر (dimensions).

Transcribe ONLY what is actually written. This is archival data, so a wrong reading is far
worse than a missing one. Follow these rules exactly:
- Copy the handwriting verbatim, including Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) as written.
- If a word or character cannot be read with certainty, write [؟] in its place. Do not guess.
- If an entire cell is unreadable or empty, use null.
- Never complete a partial word from context. Never normalise spelling.
- Do not describe the pasted photographs on the right side of the page.

Return ONLY valid JSON in this shape:
{"rows": [{"row": 1, "number": "...", "position": "...", "description": "...", "date": "...",
"material": "...", "dimensions": "...", "unreadable_fields": 0, "confidence": 0.0}], "notes": []}

confidence is your honest 0-1 estimate that this row is transcribed correctly.
unreadable_fields counts how many cells in the row you marked [؟] or null."""

LINES_PROMPT = """Transcribe every handwritten Arabic line visible in this image, in reading order.

Rules:
- Copy verbatim. Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) stay as written.
- Where a character cannot be read with certainty, write [؟]. Never guess a word from context.
- Ignore printed form headers and any pasted photographs; transcribe handwriting only.

Return ONLY valid JSON: {"lines": [{"line": 1, "text": "...", "confidence": 0.0}], "notes": []}"""


def load_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    env_file = ROOT / ".env.local"
    if env_file.exists():
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            name, _, value = raw.partition("=")
            if name.strip() == "GEMINI_API_KEY":
                return value.strip()
    sys.exit("No GEMINI_API_KEY found in the environment or .env.local")


def prepare_image(path: Path, crop: str, max_side: int, enhance: bool) -> list[tuple[str, bytes]]:
    """Return [(label, png_bytes)] for the regions we want to send."""
    from PIL import Image, ImageEnhance, ImageOps

    image = Image.open(path)
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size

    if crop == "left":
        image = image.crop((0, 0, width // 2, height))
    elif crop == "right":
        image = image.crop((width // 2, 0, width, height))
    elif crop == "top":
        image = image.crop((0, 0, width, height // 2))

    if enhance:
        image = ImageOps.autocontrast(ImageOps.grayscale(image), cutoff=1).convert("RGB")
        image = ImageEnhance.Sharpness(image).enhance(2.0)

    return [("full", encode(image, max_side))]


def slice_rows(path: Path, rows: int, crop: str, max_side: int, enhance: bool, overlap: float) -> list[tuple[str, bytes]]:
    """Cut the page into horizontal bands so each request carries fewer pixels of handwriting."""
    from PIL import Image, ImageEnhance, ImageOps

    image = Image.open(path)
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    if crop == "left":
        image = image.crop((0, 0, width // 2, height))
    elif crop == "right":
        image = image.crop((width // 2, 0, width, height))
    width, height = image.size

    if enhance:
        image = ImageOps.autocontrast(ImageOps.grayscale(image), cutoff=1).convert("RGB")
        image = ImageEnhance.Sharpness(image).enhance(2.0)

    band = height / rows
    pad = int(band * overlap)
    regions = []
    for index in range(rows):
        top = max(0, int(index * band) - pad)
        bottom = min(height, int((index + 1) * band) + pad)
        regions.append((f"band{index + 1:02d}", encode(image.crop((0, top, width, bottom)), max_side)))
    return regions


def encode(image, max_side: int) -> bytes:
    if max(image.size) > max_side:
        scale = max_side / max(image.size)
        image = image.resize((int(image.width * scale), int(image.height * scale)))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def call_gemini(model: str, key: str, prompt: str, png: bytes, timeout: int) -> tuple[dict, float, dict]:
    payload = {
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(png).decode("ascii")}},
        ]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    request = urllib.request.Request(
        ENDPOINT.format(model=model),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        return {"error": f"HTTP {error.code}: {detail}"}, time.time() - started, {}
    except Exception as error:  # noqa: BLE001 - surface transport failures verbatim
        return {"error": str(error)}, time.time() - started, {}

    elapsed = time.time() - started
    usage = body.get("usageMetadata", {})
    try:
        text = body["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        return {"error": "no candidate returned", "raw": body}, elapsed, usage
    try:
        return json.loads(text), elapsed, usage
    except json.JSONDecodeError:
        return {"error": "model did not return JSON", "raw_text": text[:2000]}, elapsed, usage


def flatten(result: dict) -> list[str]:
    """Reduce a response to comparable strings so repeat runs can be diffed."""
    if "rows" in result:
        fields = ("number", "position", "description", "date", "material", "dimensions")
        return [" | ".join(str(row.get(name) or "") for name in fields) for row in result["rows"]]
    if "lines" in result:
        return [str(line.get("text") or "") for line in result["lines"]]
    return []


def agreement(runs: list[list[str]]) -> float:
    """Mean pairwise similarity across repeat runs; 1.0 means every run agreed."""
    if len(runs) < 2:
        return float("nan")
    scores = []
    for index in range(len(runs) - 1):
        left, right = "\n".join(runs[index]), "\n".join(runs[index + 1])
        scores.append(difflib.SequenceMatcher(None, left, right).ratio())
    return sum(scores) / len(scores)


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark Gemini models on handwritten Arabic registers.")
    parser.add_argument("image", type=Path)
    # Flash models work on the free tier; the Pro models return 429 with
    # "generate_content_free_tier_requests, limit: 0" until billing is enabled.
    parser.add_argument("--models", default="gemini-3.7-flash,gemini-3.5-flash")
    parser.add_argument("--crop", choices=["none", "left", "right", "top"], default="none")
    parser.add_argument("--rows", type=int, default=0, help="split the page into N horizontal bands")
    parser.add_argument("--overlap", type=float, default=0.04, help="band overlap as a fraction of band height")
    parser.add_argument("--task", choices=["table", "lines"], default="table")
    parser.add_argument("--repeat", type=int, default=2, help="runs per model, for the consistency check")
    parser.add_argument("--max-side", type=int, default=3072)
    parser.add_argument("--enhance", action="store_true", help="grayscale + autocontrast + sharpen first")
    parser.add_argument("--timeout", type=int, default=420)
    parser.add_argument("--out", type=Path, default=ROOT / "samples" / "out")
    args = parser.parse_args()

    # Windows consoles default to cp1252 and cannot print Arabic.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass

    if not args.image.exists():
        sys.exit(f"No such image: {args.image}")

    key = load_key()
    prompt = TABLE_PROMPT if args.task == "table" else LINES_PROMPT
    regions = (slice_rows(args.image, args.rows, args.crop, args.max_side, args.enhance, args.overlap)
               if args.rows else prepare_image(args.image, args.crop, args.max_side, args.enhance))
    args.out.mkdir(parents=True, exist_ok=True)

    print(f"image      {args.image}  ({len(regions)} region(s), task={args.task}, repeat={args.repeat})")
    print(f"models     {args.models}\n")

    for model in [name.strip() for name in args.models.split(",") if name.strip()]:
        print(f"=== {model} ===")
        for label, png in regions:
            runs, elapsed_total, tokens = [], 0.0, 0
            for attempt in range(args.repeat):
                result, elapsed, usage = call_gemini(model, key, prompt, png, args.timeout)
                elapsed_total += elapsed
                tokens += usage.get("totalTokenCount", 0)
                (args.out / f"{model}-{label}-{attempt + 1}.json").write_text(
                    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                if "error" in result:
                    print(f"  {label} run{attempt + 1}: ERROR {result['error'][:160]}")
                    continue
                runs.append(flatten(result))

            if not runs:
                continue
            entries = runs[0]
            score = agreement(runs)
            marks = sum(text.count("[؟]") for text in entries)
            print(f"  {label}: {len(entries)} entries · {marks} unreadable marks · "
                  f"{elapsed_total / max(1, args.repeat):.1f}s/run · {tokens} tokens")
            if len(runs) > 1:
                # Agreement measures STABILITY, not accuracy: a model can be
                # deterministically wrong. Low agreement proves guessing; high
                # agreement proves nothing without human ground truth.
                verdict = "stable (still verify)" if score > 0.98 else "shaky" if score > 0.9 else "GUESSING"
                print(f"      run-to-run agreement: {score:.3f}  → {verdict}")
            for text in entries[:4]:
                print(f"      {text[:110]}")
        print()

    print(f"Full JSON written to {args.out}")


if __name__ == "__main__":
    main()
