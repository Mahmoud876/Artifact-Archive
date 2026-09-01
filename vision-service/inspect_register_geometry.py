"""Render the exact register geometry used by the OCR service for debugging."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from server import REGISTER_TEXT_COLUMNS, ROW_ANCHOR_COLUMNS, column_ink_bands, detect_row_boundaries, ink_mask


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "samples" / "register.jpg"
OUTPUT = ROOT / "samples" / "out" / "register-geometry.png"


def main() -> None:
    image = ImageOps.exif_transpose(Image.open(SOURCE)).convert("RGB")
    width, height = image.size
    body_top = round(height * 0.13)
    body_bottom = round(height * 0.992)
    geometry = detect_row_boundaries(image, 10, body_top, body_bottom)
    mask = ink_mask(image)
    for index, (left_ratio, right_ratio) in enumerate(ROW_ANCHOR_COLUMNS):
        bands = column_ink_bands(mask, round(width * left_ratio), round(width * right_ratio), body_top, body_bottom)
        print(f"anchor {index + 1}: {bands}")
    if geometry is None:
        step = (body_bottom - body_top) / 10
        bounds = [round(body_top + step * index) for index in range(11)]
    else:
        bounds = geometry["boundaries"]

    rendered = image.copy()
    draw = ImageDraw.Draw(rendered)
    for index, boundary in enumerate(bounds):
        draw.line((0, boundary, round(width * REGISTER_TEXT_COLUMNS[-1][1]), boundary), fill=(220, 40, 40), width=3)
        draw.text((4, max(0, boundary - 16)), str(index), fill=(220, 40, 40))
    for index, (left_ratio, right_ratio) in enumerate(REGISTER_TEXT_COLUMNS):
        left, right = round(width * left_ratio), round(width * right_ratio)
        draw.rectangle((left, bounds[0], right, bounds[-1]), outline=(15, 120, 210), width=2)
        draw.text((left + 3, bounds[0] + 3), f"C{index + 1}", fill=(15, 90, 180))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    rendered.save(OUTPUT)
    print(f"geometry={geometry}")
    print(OUTPUT)


if __name__ == "__main__":
    main()
