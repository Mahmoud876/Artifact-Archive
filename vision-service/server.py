from __future__ import annotations

import base64
import hashlib
import io
import importlib.util
import json
import os
import threading
from collections import OrderedDict
from pathlib import Path
from dataclasses import dataclass

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageEnhance, ImageOps
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor


MODEL_ID = os.getenv("SESHAT_DETECTOR_MODEL", "IDEA-Research/grounding-dino-tiny")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float32
DEFAULT_PROMPT = "photograph . illustration . drawing . carved artifact . carved tablet ."


@dataclass
class Detection:
    box: list[float]
    score: float
    label: str


app = FastAPI(title="Seshat local vision service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_model = None
_processor = None
_load_lock = threading.Lock()
_region_cache: "OrderedDict[str, tuple[tuple[int,int,int,int], Image.Image]]" = OrderedDict()
_REGION_CACHE_LIMIT = 4
_swinir_model = None
_swinir_error: str | None = None
_swinir_lock = threading.Lock()

SWINIR_SCALE = 2
# The restored view exists for a human transcribing by hand, so it is rendered
# larger than the canvas the OCR passes receive.
VIEWING_AID_HEIGHT = 840
SWINIR_ROOT = Path(__file__).resolve().parent / "vendor" / "SwinIR"
SWINIR_NETWORK = SWINIR_ROOT / "models" / "network_swinir.py"
SWINIR_WEIGHTS = Path(os.getenv(
    "SESHAT_SWINIR_WEIGHTS",
    str(Path(__file__).resolve().parent / "models" / "swinir" / "002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth"),
))
SWINIR_ENABLED = os.getenv("SESHAT_SWINIR_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def get_detector():
    global _model, _processor
    if _model is not None and _processor is not None:
        return _processor, _model
    with _load_lock:
        if _model is None:
            _processor = AutoProcessor.from_pretrained(MODEL_ID)
            _model = AutoModelForZeroShotObjectDetection.from_pretrained(
                MODEL_ID,
                torch_dtype=DTYPE,
            ).to(DEVICE)
            _model.eval()
    return _processor, _model


def get_swinir():
    """Load the official lightweight SwinIR x2 network only when HTR needs it."""
    global _swinir_model, _swinir_error
    if _swinir_model is not None:
        return _swinir_model
    if not SWINIR_ENABLED:
        raise RuntimeError("SwinIR enhancement is disabled.")
    if not SWINIR_NETWORK.exists() or not SWINIR_WEIGHTS.exists():
        raise RuntimeError("SwinIR code or lightweight x2 weights are missing.")
    with _swinir_lock:
        if _swinir_model is not None:
            return _swinir_model
        try:
            spec = importlib.util.spec_from_file_location("seshat_swinir_network", SWINIR_NETWORK)
            if spec is None or spec.loader is None:
                raise RuntimeError("Could not load the SwinIR network module.")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            model = module.SwinIR(
                upscale=SWINIR_SCALE,
                in_chans=3,
                img_size=64,
                window_size=8,
                img_range=1.0,
                depths=[6, 6, 6, 6],
                embed_dim=60,
                num_heads=[6, 6, 6, 6],
                mlp_ratio=2,
                upsampler="pixelshuffledirect",
                resi_connection="1conv",
            )
            checkpoint = torch.load(SWINIR_WEIGHTS, map_location="cpu", weights_only=True)
            model.load_state_dict(checkpoint.get("params", checkpoint), strict=True)
            model.eval().to(DEVICE)
            _swinir_model = model
            _swinir_error = None
        except Exception as error:
            _swinir_error = str(error)
            raise RuntimeError(f"SwinIR could not be loaded: {error}") from error
    return _swinir_model


def encode_png(image: Image.Image) -> str:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return base64.b64encode(output.getvalue()).decode("ascii")


def fit_cell_height(image: Image.Image, target_height: int = 420) -> Image.Image:
    target_width = max(240, round(image.width * target_height / max(1, image.height)))
    return image.resize((target_width, target_height), Image.Resampling.LANCZOS)


def enhance_cell_opencv_native(image: Image.Image) -> Image.Image:
    """Evidence-preserving cleanup at the crop's true source dimensions."""
    gray = np.asarray(ImageOps.grayscale(image))
    # Divide out slow paper/scan illumination before local contrast. This makes
    # faint pen strokes more visible without thresholding characters into new
    # shapes or erasing uncertain marks.
    background = cv2.GaussianBlur(gray, (0, 0), sigmaX=9, sigmaY=9)
    normalized = cv2.divide(gray, np.maximum(background, 1), scale=245)
    clahe = cv2.createCLAHE(clipLimit=2.6, tileGridSize=(6, 6)).apply(normalized)
    denoised = cv2.fastNlMeansDenoising(clahe, None, h=4, templateWindowSize=7, searchWindowSize=21)
    blurred = cv2.GaussianBlur(denoised, (0, 0), 1.0)
    sharpened = cv2.addWeighted(denoised, 1.7, blurred, -0.7, 0)
    return Image.fromarray(sharpened).convert("RGB")


def enhance_cell_opencv(image: Image.Image) -> Image.Image:
    """OCR-sized OpenCV view; reference output remains at native dimensions."""
    return fit_cell_height(enhance_cell_opencv_native(image))


def enhance_cell_swinir(image: Image.Image, normalize_for_ocr: bool = True) -> Image.Image:
    """Create a secondary x2 restoration; the original crop remains authoritative."""
    model = get_swinir()
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).to(DEVICE)
    height, width = tensor.shape[-2:]
    pad_height = (8 - height % 8) % 8
    pad_width = (8 - width % 8) % 8
    if pad_height or pad_width:
        tensor = torch.nn.functional.pad(tensor, (0, pad_width, 0, pad_height), mode="reflect")
    with torch.inference_mode():
        restored = model(tensor).clamp_(0, 1)
    restored = restored[..., : height * SWINIR_SCALE, : width * SWINIR_SCALE]
    pixels = (restored.squeeze(0).permute(1, 2, 0).detach().cpu().numpy() * 255.0).round().astype(np.uint8)
    native_restoration = Image.fromarray(pixels, mode="RGB")
    return fit_cell_height(native_restoration) if normalize_for_ocr else native_restoration


def detect_image(image: Image.Image, prompt: str, box_threshold: float, text_threshold: float) -> list[Detection]:
    processor, model = get_detector()
    inputs = processor(images=image, text=prompt, return_tensors="pt").to(DEVICE)
    if DEVICE == "cuda":
        inputs = {key: value.to(dtype=DTYPE) if value.is_floating_point() else value for key, value in inputs.items()}
    with torch.inference_mode():
        outputs = model(**inputs)
    results = processor.post_process_grounded_object_detection(
        outputs,
        inputs["input_ids"],
        threshold=box_threshold,
        text_threshold=text_threshold,
        target_sizes=[(image.height, image.width)],
    )[0]
    detections = []
    for box, score, label in zip(results["boxes"], results["scores"], results["labels"]):
        detections.append(Detection(
            box=[float(value) for value in box.tolist()],
            score=float(score.item()),
            label=str(label),
        ))
    return detections


def tile_windows(width: int, height: int):
    yield 0, 0, width, height
    if width < 900 and height < 900:
        return
    tile_width = min(width, max(640, round(width * 0.58)))
    tile_height = min(height, max(560, round(height * 0.58)))
    x_positions = sorted({0, max(0, width - tile_width)})
    y_positions = sorted({0, max(0, round((height - tile_height) / 2)), max(0, height - tile_height)})
    for y in y_positions:
        for x in x_positions:
            if x == 0 and y == 0 and tile_width == width and tile_height == height:
                continue
            yield x, y, x + tile_width, y + tile_height


def intersection_over_union(left: list[float], right: list[float]) -> float:
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if intersection <= 0:
        return 0.0
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    return intersection / max(1.0, left_area + right_area - intersection)


def non_max_suppression(detections: list[Detection], threshold: float = 0.48) -> list[Detection]:
    kept: list[Detection] = []
    for candidate in sorted(detections, key=lambda item: item.score, reverse=True):
        if any(intersection_over_union(candidate.box, existing.box) >= threshold for existing in kept):
            continue
        kept.append(candidate)
    return sorted(kept, key=lambda item: (round(item.box[1] / 24), item.box[0]))


def dark_content_ratio(gray: np.ndarray, box: list[float]) -> float:
    height, width = gray.shape
    x1 = max(0, min(width - 1, round(box[0])))
    y1 = max(0, min(height - 1, round(box[1])))
    x2 = max(x1 + 1, min(width, round(box[2])))
    y2 = max(y1 + 1, min(height, round(box[3])))
    crop = gray[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    blurred = cv2.GaussianBlur(crop, (5, 5), 0)
    return float(np.count_nonzero(blurred < 165) / blurred.size)


def boxes_are_near(left: list[float], right: list[float], gap: int = 40) -> bool:
    return not (
        left[2] + gap < right[0]
        or right[2] + gap < left[0]
        or left[3] + gap < right[1]
        or right[3] + gap < left[1]
    )


def looks_like_direct_page_stamp(gray: np.ndarray, box: list[float]) -> bool:
    """Reject circular ink stamps printed directly on the register page.

    A photographed coin or seal normally retains a rectangular photographic
    field, including tonal content in its corners. A page stamp is instead a
    near-square circular ink distribution surrounded by pale paper. This is a
    conservative filter: non-circular and corner-supported regions pass.
    """
    image_height, image_width = gray.shape
    x1 = max(0, min(image_width - 1, round(box[0])))
    y1 = max(0, min(image_height - 1, round(box[1])))
    x2 = max(x1 + 1, min(image_width, round(box[2])))
    y2 = max(y1 + 1, min(image_height, round(box[3])))
    crop = gray[y1:y2, x1:x2]
    height, width = crop.shape
    if width < 48 or height < 48:
        return False
    aspect = width / max(1, height)
    if aspect < 0.72 or aspect > 1.38:
        return False

    blurred = cv2.GaussianBlur(crop, (5, 5), 0)
    dark = blurred < 190
    dark_ratio = float(np.count_nonzero(dark) / dark.size)
    if dark_ratio < 0.025 or dark_ratio > 0.48:
        return False

    corner_height = max(4, round(height * 0.18))
    corner_width = max(4, round(width * 0.18))
    corners = np.concatenate((
        dark[:corner_height, :corner_width].ravel(),
        dark[:corner_height, -corner_width:].ravel(),
        dark[-corner_height:, :corner_width].ravel(),
        dark[-corner_height:, -corner_width:].ravel(),
    ))
    # Dark photographic backgrounds and visible rectangular mounts are strong
    # evidence that the circular subject is inside a real image panel.
    if float(np.count_nonzero(corners) / corners.size) >= 0.10:
        return False

    yy, xx = np.ogrid[:height, :width]
    normalized_x = (xx - (width - 1) / 2) / max(1.0, width / 2)
    normalized_y = (yy - (height - 1) / 2) / max(1.0, height / 2)
    radius = np.sqrt(normalized_x * normalized_x + normalized_y * normalized_y)
    annulus = (radius >= 0.58) & (radius <= 1.02)
    if not np.any(annulus):
        return False
    annulus_density = float(np.count_nonzero(dark & annulus) / np.count_nonzero(annulus))

    # Require ink around every quadrant of the circular band. This prevents a
    # small central drawing or an irregular archaeological silhouette from
    # being rejected merely because its crop is square.
    quadrant_densities = []
    for vertical in (yy < height / 2, yy >= height / 2):
        for horizontal in (xx < width / 2, xx >= width / 2):
            quadrant = annulus & vertical & horizontal
            quadrant_densities.append(
                float(np.count_nonzero(dark & quadrant) / max(1, np.count_nonzero(quadrant)))
            )
    return annulus_density >= 0.075 and min(quadrant_densities) >= 0.025


def find_residual_regions(image: Image.Image, detections: list[Detection]) -> list[Detection]:
    """Recover dark neighboring panels that a semantic detector merged into one object."""
    if not detections:
        return []
    gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, dark_mask = cv2.threshold(blurred, 165, 255, cv2.THRESH_BINARY_INV)
    dark_mask = cv2.morphologyEx(
        dark_mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
    )
    residual = dark_mask.copy()
    for detection in detections:
        x1, y1, x2, y2 = [round(value) for value in detection.box]
        cv2.rectangle(
            residual,
            (max(0, x1 - 4), max(0, y1 - 4)),
            (min(image.width - 1, x2 + 4), min(image.height - 1, y2 + 4)),
            0,
            -1,
        )

    contours, _ = cv2.findContours(residual, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    image_area = image.width * image.height
    supplements: list[Detection] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        box = [float(x), float(y), float(x + width), float(y + height)]
        area_ratio = width * height / image_area
        if width < 40 or height < 35 or area_ratio < 0.0007 or area_ratio > 0.025:
            continue
        density = float(np.count_nonzero(dark_mask[y:y + height, x:x + width]) / max(1, width * height))
        if density < 0.30 or not any(boxes_are_near(box, detection.box) for detection in detections):
            continue
        if looks_like_direct_page_stamp(gray, box):
            continue
        if any(intersection_over_union(box, detection.box) > 0.10 for detection in detections):
            continue
        supplements.append(Detection(box, min(0.45, 0.18 + density * 0.25), "embedded image"))
    return supplements


@app.get("/health")
def health():
    return {
        "status": "ready",
        "model": MODEL_ID,
        "device": DEVICE,
        "loaded": _model is not None,
        "cuda": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "swinir": {
            "enabled": SWINIR_ENABLED,
            "available": SWINIR_NETWORK.exists() and SWINIR_WEIGHTS.exists(),
            "loaded": _swinir_model is not None,
            "model": "SwinIR-S x2 lightweight",
            "error": _swinir_error,
        },
    }


@app.post("/prepare-register")
async def prepare_register(file: UploadFile = File(...), rows: int = Form(10)):
    """Create enlarged, enhanced row bands for conservative handwriting OCR.

    The fixed Antiquities Service form contains ten ruled records.  Working on
    one enlarged row at a time preserves far more stroke detail than sending a
    model the whole sheet, while excluding the photograph strip prevents the
    plates from distracting the text recognizer.
    """
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB preparation limit.")
    if rows < 1 or rows > 40:
        raise HTTPException(status_code=400, detail="Row count must be between 1 and 40.")
    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=415, detail=f"Could not decode image: {error}") from error

    width, height = image.size
    body_top = max(0, round(height * 0.13))
    body_bottom = min(height, round(height * 0.992))
    body_height = max(rows, body_bottom - body_top)
    band_height = body_height / rows
    text_width = max(1, round(width * 0.78))
    encoded_rows: list[str] = []

    for index in range(rows):
        overlap = max(3, round(band_height * 0.08))
        top = max(0, int(body_top + band_height * index) - overlap)
        bottom = min(height, int(body_top + band_height * (index + 1) + 0.999) + overlap)
        crop = image.crop((0, top, text_width, max(top + 1, bottom)))
        crop = ImageOps.autocontrast(ImageOps.grayscale(crop), cutoff=1).convert("RGB")
        crop = ImageEnhance.Sharpness(crop).enhance(1.8)
        target_width = max(2200, text_width)
        target_height = max(1, round(crop.height * target_width / crop.width))
        crop = crop.resize((target_width, target_height), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        crop.save(output, format="PNG", optimize=True)
        encoded_rows.append(base64.b64encode(output.getvalue()).decode("ascii"))

    return {
        "image": {"width": width, "height": height},
        "source_hash": hashlib.sha256(content).hexdigest(),
        "rows": encoded_rows,
    }


# Stable normalized boundaries of the six populated text columns on the known
# Egyptian Antiquities Service double-page register form. The remaining right
# page fields are normally blank; photographs are handled by the detector.
REGISTER_COLUMN_LABELS = ("مسلسل", "موضع الأثر", "وصف الأثر", "تاريخ الأثر", "المادة المصنوع منها", "مقاييس الأثر")

REGISTER_TEXT_COLUMNS = (
    (0.035, 0.079),  # serial / number
    (0.079, 0.147),  # location
    (0.147, 0.292),  # description
    (0.292, 0.325),  # period / date
    (0.325, 0.391),  # material
    (0.391, 0.456),  # dimensions
)


# Columns holding exactly one entry per record. The description column cannot be
# used as an anchor: it wraps onto several lines and would split one record into
# several bands.
ROW_ANCHOR_COLUMNS = ((0.035, 0.079), (0.292, 0.325), (0.391, 0.456))


def ink_mask(image: Image.Image) -> np.ndarray:
    """Handwriting with the printed column rules removed."""
    gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 10)
    rules = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 60)), iterations=1
    )
    return cv2.subtract(binary, rules)


def column_ink_bands(ink: np.ndarray, x0: int, x1: int, top: int, bottom: int,
                     min_height: int = 6, merge_gap: int = 26) -> list[tuple[int, int]]:
    """Contiguous runs of ink down one column, as (top, bottom) pairs."""
    if x1 <= x0 or bottom <= top:
        return []
    profile = ink[top:bottom, x0:x1].sum(axis=1) / 255.0
    profile = np.convolve(profile, np.ones(7) / 7, mode="same")
    active = profile > max(1.0, 0.05 * (x1 - x0))
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for index, on in enumerate(active):
        if on and start is None:
            start = index
        elif not on and start is not None:
            if index - start >= min_height:
                if bands and start + top - bands[-1][1] < merge_gap:
                    bands[-1] = (bands[-1][0], index + top)
                else:
                    bands.append((start + top, index + top))
            start = None
    if start is not None and len(active) - start >= min_height:
        bands.append((start + top, len(active) + top))
    return bands


def select_row_boundaries(
    candidates: list[tuple[int, int]], rows: int, body_top: int, body_bottom: int
) -> dict | None:
    """Choose a plausible sequence of record starts, or reject the geometry.

    ``candidates`` are ``(position, supporting_columns)`` pairs. More marks than
    records are common on damaged pages, so blindly taking the first eleven can
    shift every later crop. A valid sequence must begin near the table body,
    cover most of it, and have locally plausible (though not equal) row heights.
    """
    if rows < 1 or body_bottom <= body_top or len(candidates) < rows:
        return None
    ordered = sorted(candidates)
    body_span = body_bottom - body_top
    expected_height = body_span / rows
    best: tuple[float, list[int], list[int]] | None = None

    for offset in range(len(ordered) - rows + 1):
        window = ordered[offset:offset + rows]
        starts = [position for position, _support in window]
        supports = [support for _position, support in window]
        if starts[0] < body_top or starts[0] - body_top > expected_height * 0.8:
            continue
        gaps = np.diff(starts).astype(float)
        if gaps.size:
            median_gap = float(np.median(gaps))
            if median_gap < 8:
                continue
            if float(np.min(gaps)) < max(8.0, median_gap * 0.35):
                continue
            if float(np.max(gaps)) > median_gap * 2.25:
                continue
        else:
            median_gap = expected_height
        if starts[-1] - starts[0] < body_span * 0.55:
            continue

        following = ordered[offset + rows][0] if offset + rows < len(ordered) else None
        if following is not None and median_gap * 0.35 <= following - starts[-1] <= median_gap * 2.25:
            end = min(body_bottom, following)
        else:
            end = min(body_bottom, round(starts[-1] + median_gap))
        boundaries = [*starts, end]
        heights = np.diff(boundaries).astype(float)
        if end <= starts[-1] or end - starts[0] < body_span * 0.65:
            continue
        if float(np.min(heights)) < max(8.0, median_gap * 0.35) or float(np.max(heights)) > median_gap * 2.25:
            continue

        gap_variation = float(np.std(heights) / max(1.0, np.mean(heights)))
        start_penalty = (starts[0] - body_top) / max(1.0, expected_height)
        coverage_penalty = abs((end - starts[0]) / body_span - 0.9)
        scale_penalty = abs(median_gap - expected_height) / max(1.0, expected_height)
        support_penalty = sum(max(0, 3 - support) for support in supports) / max(1, rows * 3)
        score = gap_variation + start_penalty + coverage_penalty + scale_penalty + support_penalty * 0.25
        if score <= 1.25 and (best is None or score < best[0]):
            best = (score, boundaries, supports)

    if best is None:
        return None
    score, boundaries, supports = best
    # The anchors above are the *first ink* in each record, not separator
    # rules. Using them directly as crop edges sliced through ascenders and the
    # first line of every multi-line description. Move the complete sequence
    # into the preceding whitespace while preserving the detected spacing.
    heights = np.diff(boundaries).astype(float)
    median_height = float(np.median(heights)) if heights.size else expected_height
    ink_lead = max(4, round(median_height * 0.28))
    boundaries = [value - ink_lead for value in boundaries]
    return {
        "boundaries": [max(0, min(body_bottom, value)) for value in boundaries],
        "columns_agreeing": min(supports),
        "confidence": round(max(0.0, 1.0 - score / 1.25), 3),
    }


def detect_row_boundaries(image: Image.Image, rows: int, body_top: int, body_bottom: int):
    """Read record boundaries off the page instead of assuming even bands.

    This form carries no horizontal rules and its records vary in height — one
    entry may be a single line, the next four.  Slicing the body into equal
    bands therefore drifts, and on the reference scan it is nearly a full row
    out by the foot of the page, so the lower rows are cropped from the wrong
    record entirely.

    Three single-entry columns are read independently and their record starts
    are clustered.  A boundary is trusted only where at least two columns agree,
    which drops the stray marks and stamps below the table that show up in one
    column alone.  When no trustworthy reading emerges this returns None and the
    caller keeps the even bands.
    """
    ink = ink_mask(image)
    width = image.width
    marks: list[tuple[int, int]] = []
    for column, (left_ratio, right_ratio) in enumerate(ROW_ANCHOR_COLUMNS):
        for top, _bottom in column_ink_bands(
            ink, round(width * left_ratio), round(width * right_ratio), body_top, body_bottom
        ):
            marks.append((top, column))
    if not marks:
        return None

    marks.sort()
    clusters: list[list[tuple[int, int]]] = []
    for position, column in marks:
        if clusters and position - clusters[-1][-1][0] <= 25:
            clusters[-1].append((position, column))
        else:
            clusters.append([(position, column)])

    agreed = [
        (int(round(float(np.median([position for position, _ in cluster])))), len({column for _, column in cluster}))
        for cluster in clusters
    ]
    supported = [(position, support) for position, support in agreed if support >= 2]
    return select_row_boundaries(supported, rows, body_top, min(image.height, body_bottom))


def register_cell_box(
    width: int, height: int, column: int, row: int, row_bounds: list[int]
) -> tuple[int, int, int, int]:
    """Return a cell crop with a small outward evidence margin.

    Writers routinely cross the faint printed rules on these registers. The old
    inward inset removed exactly those pen strokes. A restrained outward margin
    preserves them without pulling a useful amount of the neighbouring cell
    into the OCR image.
    """
    left_ratio, right_ratio = REGISTER_TEXT_COLUMNS[column]
    left, right = round(width * left_ratio), round(width * right_ratio)
    top, bottom = row_bounds[row], row_bounds[row + 1]
    pad_x = max(3, round(width * 0.003))
    pad_y = max(3, round((bottom - top) * 0.045))
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(width, right + pad_x),
        min(height, bottom + pad_y),
    )


def register_row_box(
    width: int, height: int, row: int, row_bounds: list[int]
) -> tuple[int, int, int, int]:
    """Return one complete handwritten record across the six populated fields.

    Manual review needs context. A location or date cell on its own is often too
    narrow to identify the writer's letter shapes, so this crop deliberately
    preserves the complete row and a restrained margin around its printed rules.
    """
    left = round(width * REGISTER_TEXT_COLUMNS[0][0])
    right = round(width * REGISTER_TEXT_COLUMNS[-1][1])
    top, bottom = row_bounds[row], row_bounds[row + 1]
    pad_x = max(6, round(width * 0.006))
    pad_y = max(4, round((bottom - top) * 0.08))
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(width, right + pad_x),
        min(height, bottom + pad_y),
    )


@app.post("/prepare-register-cells")
async def prepare_register_cells(file: UploadFile = File(...), rows: int = Form(10)):
    """Cut the known register form into isolated, enhanced cell images.

    Each output contains one row/column intersection only. This removes the
    cross-column inference that caused a vision model to turn a blurred whole
    row into a plausible but unsupported catalogue description.
    """
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB preparation limit.")
    if rows < 1 or rows > 40:
        raise HTTPException(status_code=400, detail="Row count must be between 1 and 40.")
    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=415, detail=f"Could not decode image: {error}") from error

    width, height = image.size
    body_top = max(0, round(height * 0.13))
    body_bottom = min(height, round(height * 0.992))
    band_height = max(rows, body_bottom - body_top) / rows
    geometry = detect_row_boundaries(image, rows, body_top, body_bottom)
    row_bounds = geometry["boundaries"] if geometry else [
        round(body_top + band_height * index) for index in range(rows + 1)
    ]
    cells = []
    best_reference_score = -1.0
    best_reference_index: int | None = None
    # Neural restoration is intentionally absent here. This endpoint feeds OCR,
    # which trusts only source pixels and evidence-preserving OpenCV cleanup.
    # SwinIR is generated lazily by /register-cell-view when an operator asks
    # to inspect one cell, avoiding a large unused payload on every analysis.
    swinir_available = SWINIR_ENABLED and SWINIR_NETWORK.exists() and SWINIR_WEIGHTS.exists()

    for column_index, (left_ratio, right_ratio) in enumerate(REGISTER_TEXT_COLUMNS):
        for row_index in range(rows):
            box = register_cell_box(width, height, column_index, row_index, row_bounds)
            source_crop = image.crop(box)
            source_gray = np.asarray(ImageOps.grayscale(source_crop))
            ink_pixels = int(np.count_nonzero(source_gray < 185))
            ink_ratio = float(ink_pixels / max(1, source_gray.size))
            original_view = fit_cell_height(
                ImageOps.autocontrast(ImageOps.grayscale(source_crop), cutoff=1).convert("RGB"),
            )
            opencv_native = enhance_cell_opencv_native(source_crop)
            opencv_view = fit_cell_height(opencv_native)
            variants = [
                {"kind": "original", "image": encode_png(original_view)},
                {"kind": "opencv", "image": encode_png(opencv_view)},
            ]
            cell = {
                "row": row_index,
                "column": column_index,
                "bbox": list(box),
                "ink_ratio": round(ink_ratio, 5),
                "image": variants[1]["image"],
                "variants": variants,
            }
            # Total supported ink favours a useful text-bearing description
            # over a tiny numeral cell whose density happens to be high.
            reference_score = float(ink_pixels) if source_crop.width >= 80 else -1.0
            if reference_score > best_reference_score:
                if best_reference_index is not None:
                    cells[best_reference_index].pop("reference_variants", None)
                reference_variants = [
                    {
                        "kind": "original",
                        "image": encode_png(source_crop),
                        "width": source_crop.width,
                        "height": source_crop.height,
                        "scale": 1,
                    },
                    {
                        "kind": "opencv",
                        "image": encode_png(opencv_native),
                        "width": opencv_native.width,
                        "height": opencv_native.height,
                        "scale": 1,
                    },
                ]
                cell["reference_variants"] = reference_variants
                best_reference_score = reference_score
                best_reference_index = len(cells)
            cells.append(cell)

    return {
        "image": {"width": width, "height": height},
        "source_hash": hashlib.sha256(content).hexdigest(),
        "cells": cells,
        "columns": len(REGISTER_TEXT_COLUMNS),
        "rows": rows,
        "geometry": {
            "source": "detected" if geometry else "assumed-even-bands",
            "columns_agreeing": geometry["columns_agreeing"] if geometry else 0,
            "confidence": geometry["confidence"] if geometry else 0.0,
            "row_bounds": row_bounds,
            "warning": None if geometry else (
                "Record boundaries could not be read from the page, so the sheet was cut into "
                f"{rows} even bands. On a form whose records vary in height this misaligns the "
                "lower rows, and any transcription from it should be treated as unverified."
            ),
        },
        "enhancement": {
            "pipeline": "source evidence + OpenCV illumination cleanup; SwinIR-S x2 is on-demand only",
            "swinir": swinir_available,
            "variants": ["original", "opencv"],
            "warning": None if swinir_available else "SwinIR viewing aid is unavailable; OCR evidence is unaffected.",
        },
    }


@app.post("/detect")
async def detect(
    file: UploadFile = File(...),
    prompt: str = Form(DEFAULT_PROMPT),
    box_threshold: float = Form(0.22),
    text_threshold: float = Form(0.18),
):
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB detector limit.")
    try:
        image = Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=415, detail=f"Could not decode image: {error}") from error

    try:
        all_detections: list[Detection] = []
        image_area = image.width * image.height
        gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
        for left, top, right, bottom in tile_windows(image.width, image.height):
            tile = image.crop((left, top, right, bottom))
            for detection in detect_image(tile, prompt, box_threshold, text_threshold):
                x1, y1, x2, y2 = detection.box
                mapped = [x1 + left, y1 + top, x2 + left, y2 + top]
                width, height = mapped[2] - mapped[0], mapped[3] - mapped[1]
                area = width * height
                if width < 28 or height < 24 or area < image_area * 0.00035 or area > image_area * 0.035:
                    continue
                # Sparse handwriting and table rules can look semantic to an open-vocabulary
                # detector. Embedded photos and illustrations have sustained tonal coverage.
                if dark_content_ratio(gray, mapped) < 0.15:
                    continue
                if looks_like_direct_page_stamp(gray, mapped):
                    continue
                all_detections.append(Detection(mapped, detection.score, detection.label))
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}") from error

    detections = non_max_suppression(all_detections)
    detections = non_max_suppression(detections + find_residual_regions(image, detections))
    return {
        "model": MODEL_ID,
        "device": DEVICE,
        "image": {"width": image.width, "height": image.height},
        "items": [
            {
                "bbox": [round(value) for value in detection.box],
                "score": round(detection.score, 4),
                "label": detection.label,
            }
            for detection in detections
        ],
    }


@app.post("/register-cell-view")
async def register_cell_view(
    file: UploadFile = File(...),
    rows: int = Form(10),
    row: int = Form(...),
    column: int = Form(...),
    height: int = Form(VIEWING_AID_HEIGHT),
):
    """One register cell, rendered as large and as clean as this scan allows.

    Serving these one at a time keeps the whole restored sheet out of the
    response: an archivist reads one cell at a time, and shipping all sixty at
    viewing size ran to tens of megabytes. The restored region is cached by
    source hash so stepping through a page pays for the restoration once.

    This is a viewing aid for a person. It is never OCR evidence — measured on
    the reference scan, two readings of the restored image agreed on none of ten
    cells while looking more confident than the unrestored ones.
    """
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB preparation limit.")
    if not 0 <= column < len(REGISTER_TEXT_COLUMNS):
        raise HTTPException(status_code=400, detail="That column is not one of the printed text columns.")
    if not 0 <= row < rows:
        raise HTTPException(status_code=400, detail="That row is outside the sheet.")
    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=415, detail=f"Could not decode image: {error}") from error

    width, image_height = image.size
    body_top = max(0, round(image_height * 0.13))
    body_bottom = min(image_height, round(image_height * 0.992))
    band_height = max(rows, body_bottom - body_top) / rows
    geometry = detect_row_boundaries(image, rows, body_top, body_bottom)
    row_bounds = geometry["boundaries"] if geometry else [
        round(body_top + band_height * index) for index in range(rows + 1)
    ]

    box = register_cell_box(width, image_height, column, row, row_bounds)

    source_crop = image.crop(box)
    opencv_native = enhance_cell_opencv_native(source_crop)
    target = max(240, min(1400, height))
    views = [
        {"kind": "original", "image": encode_png(fit_cell_height(
            ImageOps.autocontrast(ImageOps.grayscale(source_crop), cutoff=1).convert("RGB"), target))},
        {"kind": "opencv", "image": encode_png(fit_cell_height(opencv_native, target))},
    ]

    restored_warning = None
    if SWINIR_ENABLED and SWINIR_NETWORK.exists() and SWINIR_WEIGHTS.exists():
        try:
            key = hashlib.sha256(content).hexdigest() + f":{rows}"
            cached = _region_cache.get(key)
            if cached is None:
                region_box = (
                    max(0, round(width * REGISTER_TEXT_COLUMNS[0][0]) - 8),
                    max(0, row_bounds[0] - 8),
                    min(width, round(width * REGISTER_TEXT_COLUMNS[-1][1]) + 8),
                    min(image_height, row_bounds[-1] + 8),
                )
                restored = enhance_cell_swinir(
                    enhance_cell_opencv_native(image.crop(region_box)), normalize_for_ocr=False)
                _region_cache[key] = (region_box, restored)
                while len(_region_cache) > _REGION_CACHE_LIMIT:
                    _region_cache.popitem(last=False)
                cached = _region_cache[key]
            region_box, restored = cached
            _region_cache.move_to_end(key)
            scaled = tuple(round((value - region_box[index % 2]) * SWINIR_SCALE) for index, value in enumerate(box))
            piece = restored.crop((
                max(0, scaled[0]), max(0, scaled[1]),
                min(restored.width, scaled[2]), min(restored.height, scaled[3]),
            ))
            if piece.width > 4 and piece.height > 4:
                views.append({"kind": "swinir", "image": encode_png(fit_cell_height(piece, target))})
        except Exception as error:
            restored_warning = str(error)

    return {
        "row": row,
        "column": column,
        "column_label": REGISTER_COLUMN_LABELS[column],
        "bbox": list(box),
        "geometry": "detected" if geometry else "assumed-even-bands",
        "views": views,
        "warning": restored_warning,
    }


def find_plate_label_box(image: Image.Image, raw_box: list[float]) -> tuple[int, int, int, int] | None:
    """Locate the small bright paper tag attached to a dark pasted photograph."""
    image_width, image_height = image.size
    x1, y1, x2, y2 = [int(round(float(value))) for value in raw_box]
    x1, x2 = sorted((max(0, x1), min(image_width, x2)))
    y1, y2 = sorted((max(0, y1), min(image_height, y2)))
    photo_width, photo_height = x2 - x1, y2 - y1
    if photo_width < 8 or photo_height < 8:
        return None

    search_box = (
        max(0, x1 - round(photo_width * 0.06)),
        max(0, round(y1 + photo_height * 0.42)),
        min(image_width, x2 + round(photo_width * 0.06)),
        min(image_height, y2 + max(5, round(photo_height * 0.16))),
    )
    search = np.asarray(image.crop(search_box).convert('RGB'))
    gray = cv2.cvtColor(search, cv2.COLOR_RGB2GRAY)
    best: tuple[float, tuple[int, int, int, int]] | None = None
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))

    for threshold in (170, 195, 220):
        mask = np.where(gray >= threshold, 255, 0).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            cx, cy, width, height = cv2.boundingRect(contour)
            if width < max(5, round(photo_width * 0.035)) or width > photo_width * 0.58:
                continue
            if height < max(3, round(photo_height * 0.018)) or height > photo_height * 0.28:
                continue
            aspect = width / max(1, height)
            if not 0.65 <= aspect <= 8.0:
                continue

            candidate_gray = gray[cy:cy + height, cx:cx + width]
            bright_ratio = float(np.mean(candidate_gray >= threshold))
            ink_ratio = float(np.mean(candidate_gray < 145))
            if bright_ratio < 0.48 or not 0.003 <= ink_ratio <= 0.60:
                continue

            ring = max(2, round(min(width, height) * 0.18))
            rx1, ry1 = max(0, cx - ring), max(0, cy - ring)
            rx2, ry2 = min(gray.shape[1], cx + width + ring), min(gray.shape[0], cy + height + ring)
            surround = gray[ry1:ry2, rx1:rx2].copy()
            sx1, sy1 = cx - rx1, cy - ry1
            surround[sy1:sy1 + height, sx1:sx1 + width] = 255
            ring_pixels = surround[surround < 255]
            dark_ring_ratio = float(np.mean(ring_pixels < 165)) if ring_pixels.size else 0.0
            if dark_ring_ratio < 0.07:
                continue

            global_centre_x = search_box[0] + cx + width / 2
            global_centre_y = search_box[1] + cy + height / 2
            horizontal = 1.0 - min(1.0, abs(global_centre_x - (x1 + x2) / 2) / max(1, photo_width / 2))
            vertical = 1.0 - min(1.0, abs(global_centre_y - (y1 + photo_height * 0.82)) / max(1, photo_height * 0.55))
            score = dark_ring_ratio * 3.0 + bright_ratio + horizontal * 0.35 + vertical * 0.8
            local_box = (cx, cy, cx + width, cy + height)
            if best is None or score > best[0]:
                best = (score, local_box)

    if best is None:
        return None
    cx1, cy1, cx2, cy2 = best[1]
    padding = max(2, round(min(cx2 - cx1, cy2 - cy1) * 0.12))
    return (
        max(0, search_box[0] + cx1 - padding),
        max(0, search_box[1] + cy1 - padding),
        min(image_width, search_box[0] + cx2 + padding),
        min(image_height, search_box[1] + cy2 + padding),
    )


@app.post("/prepare-plate-labels")
async def prepare_plate_labels(file: UploadFile = File(...), boxes: str = Form("[]")):
    """Enlarge the bottom label band of each detected pasted photograph.

    The full register makes these labels only a few pixels high. This endpoint
    keeps source and evidence-preserving OpenCV views separate so OCR can read
    the physical label without seeing (and borrowing from) the register row.
    """
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB preparation limit.")
    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
        raw_boxes = json.loads(boxes)
    except Exception as error:
        raise HTTPException(status_code=415, detail=f"Could not decode the image or boxes: {error}") from error
    if not isinstance(raw_boxes, list) or len(raw_boxes) > 60:
        raise HTTPException(status_code=400, detail="boxes must be an array of at most 60 detections.")

    labels = []
    for index, raw_box in enumerate(raw_boxes):
        if not isinstance(raw_box, list) or len(raw_box) != 4:
            continue
        try:
            x1, y1, x2, y2 = [int(round(float(value))) for value in raw_box]
        except (TypeError, ValueError):
            continue
        x1, x2 = sorted((max(0, x1), min(image.width, x2)))
        y1, y2 = sorted((max(0, y1), min(image.height, y2)))
        width, height = x2 - x1, y2 - y1
        if width < 8 or height < 8:
            continue
        located_tag = find_plate_label_box(image, [x1, y1, x2, y2])
        method = 'tag' if located_tag else 'band'
        # Retain a conservative lower-edge fallback for damaged labels. Its
        # method is returned so callers never mistake it for localized geometry.
        box = located_tag or (
            max(0, x1 + round(width * 0.08)),
            max(0, round(y1 + height * 0.62)),
            min(image.width, x2 - round(width * 0.08)),
            min(image.height, y2 + max(6, round(height * 0.10))),
        )
        source_crop = image.crop(box)
        original = fit_cell_height(source_crop, 420)
        cleaned = fit_cell_height(enhance_cell_opencv_native(source_crop), 420)
        labels.append({
            "index": index,
            "bbox": list(box),
            "method": method,
            "views": [
                {"kind": "original", "image": encode_png(original), "width": original.width, "height": original.height},
                {"kind": "opencv", "image": encode_png(cleaned), "width": cleaned.width, "height": cleaned.height},
            ],
        })
    return {"image": {"width": image.width, "height": image.height}, "labels": labels}


@app.post("/register-row-view")
async def register_row_view(
    file: UploadFile = File(...),
    rows: int = Form(10),
    row: int = Form(...),
    width: int = Form(1800),
):
    """A complete register record for human review, never OCR evidence."""
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB preparation limit.")
    if rows < 1 or rows > 40 or not 0 <= row < rows:
        raise HTTPException(status_code=400, detail="That row is outside the sheet.")
    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=415, detail=f"Could not decode image: {error}") from error

    image_width, image_height = image.size
    body_top = max(0, round(image_height * 0.13))
    body_bottom = min(image_height, round(image_height * 0.992))
    band_height = max(rows, body_bottom - body_top) / rows
    geometry = detect_row_boundaries(image, rows, body_top, body_bottom)
    row_bounds = geometry["boundaries"] if geometry else [
        round(body_top + band_height * index) for index in range(rows + 1)
    ]
    box = register_row_box(image_width, image_height, row, row_bounds)
    source_crop = image.crop(box)
    target_width = max(900, min(2400, width))

    def enlarge(view: Image.Image) -> Image.Image:
        if view.width >= target_width:
            return view
        target_height = max(1, round(view.height * target_width / view.width))
        return view.resize((target_width, target_height), Image.Resampling.LANCZOS)

    original = enlarge(source_crop)
    cleaned = enlarge(enhance_cell_opencv_native(source_crop))
    return {
        "row": row,
        "bbox": list(box),
        "source_dimensions": [source_crop.width, source_crop.height],
        "geometry": "detected" if geometry else "assumed-even-bands",
        "views": [
            {"kind": "original", "image": encode_png(original), "width": original.width, "height": original.height},
            {"kind": "opencv", "image": encode_png(cleaned), "width": cleaned.width, "height": cleaned.height},
        ],
    }
