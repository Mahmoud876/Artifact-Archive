# Seshat

Seshat is a local archival-image extraction workbench. Grounding DINO locates embedded photographs, drawings, seals, maps, and illustrations; OpenCV rejects sparse page marks and recovers touching panels. Original-pixel crops receive permanent inventory serials, are stored locally, and export with a JSON manifest.

This branch intentionally disables handwriting transcription and register-table analysis. One run accepts an ordered batch of up to 12 images. Source order, source filenames, crop coordinates, and permanent serials are preserved in the archive.

## Start locally

Requirements:

- Node.js 22.13 or newer
- Python 3.12 and [uv](https://docs.astral.sh/uv/)
- An NVIDIA GPU is recommended for the local detector

Clone and install the application:

```powershell
git clone https://github.com/Mahmoud876/Artifact-Archive.git
cd Artifact-Archive
npm.cmd ci
cd vision-service
uv sync
cd ..
```

Copy `.env.example` to `.env.local`, then add any provider keys locally. Never commit `.env.local` or `data/accounts.json`.

Create or reset the administrator account with a private password:

```powershell
$env:SESHAT_ADMIN_PASSWORD = "replace-with-a-strong-private-password"
node tools/manage-admin.mjs
Remove-Item Env:\SESHAT_ADMIN_PASSWORD
```

From the project folder, one command starts the detector, Ollama when available, and the web app:

```powershell
npm.cmd run start:local
```

Keep that terminal open while using Seshat. Press `Ctrl+C` once to stop the detector and web app. No Ollama model or cloud API key is required for this extraction-only branch.

First-time detector setup, only if the launcher reports that its environment is missing:

```powershell
cd vision-service
uv sync
```

Open [http://localhost:3000](http://localhost:3000). Everything remains on this computer except requests explicitly sent through the Gemini provider.

The first start after the inventory upgrade automatically adds permanent inventory IDs to existing saved runs. Serial counters are stored with those inventory records and advanced in the same IndexedDB transaction that seals a run, so concurrent browser tabs cannot issue the same number. New crop filenames begin with that permanent serial.

Configuration is documented in `.env.example`; defaults target local Ollama and the local detector.

## Google Cloud deployment

The production VM, HTTPS, DNS, account bootstrap, update, and rollback procedure is documented in [`deploy/README.md`](deploy/README.md). Runtime keys remain on the VM and are never committed.

Runtime credentials, account records, generated crops, caches, local model weights, and archival fixtures are intentionally excluded from this public repository.

## Verification

```powershell
npm run build
curl http://127.0.0.1:8788/health
```
