# Seshat local vision service

This process performs open-vocabulary image-region detection before Qwen categorizes the results.

Handwriting cells are prepared as three local evidence views: an enlarged
original crop, an OpenCV CLAHE/denoise crop, and an optional SwinIR-S x2
restoration. The SwinIR view is secondary evidence only and is never accepted
without support from the original or OpenCV view.

The official SwinIR code lives in `vendor/SwinIR`; place the lightweight x2
checkpoint at `models/swinir/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth`.
Set `SESHAT_SWINIR_ENABLED=0` to disable it without changing the OCR pipeline.

Run locally:

```powershell
uv sync
uv run uvicorn server:app --host 127.0.0.1 --port 8788
```

The service downloads model weights into the normal Hugging Face cache on first use. It listens on localhost only.
