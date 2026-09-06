# Setting up local inference on a new machine

Everything needed to go from `git clone` to free, local sprite generation.
The app itself runs **without any of this** — local providers simply show
OFFLINE and the API providers work as usual — so treat this as opt-in.

Roughly 30 minutes of work, most of it waiting on downloads.

## 0. What you need

| | Minimum | Comfortable |
| --- | --- | --- |
| GPU | NVIDIA, 4GB VRAM (quantized models only, slow) | NVIDIA, 12–16GB VRAM |
| System RAM | 16GB (tight — close other apps) | 32GB |
| Disk | ~15GB (Z-Image only) | ~60GB (all families) |
| Python | 3.10–3.13, an **official python.org / Microsoft Store build** | same |
| Node | 20+ (the repo's own requirement) | same |

**Windows caveat that costs an hour if missed:** if `python` resolves to an
MSYS2/Git-Bash build (`C:\msys64\...`), PyTorch's CUDA wheels will not install
properly. Check with `py -0p` and use an official interpreter, e.g.
`py -3.13 -m venv .venv`.

AMD/Apple GPUs: ComfyUI runs, but the pose-ControlNet path here is untested on
them. Assume CUDA.

## 1. The Genvy app

```bash
git clone <this repo> genvy && cd genvy
npm install
cp .env.example .env      # AI keys are optional; local inference needs none
npm run dev               # server :3020 + client :5173
```

## 2. ComfyUI

Clone it **next to** the genvy folder (the model fetcher defaults to
`../ComfyUI`):

```bash
cd ..
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI

py -3.13 -m venv .venv                     # Windows; use python3 -m venv on Linux/macOS
.venv/Scripts/python.exe -m pip install --upgrade pip

# PyTorch FIRST, from the CUDA index — installing requirements.txt first
# pulls a CPU-only torch that silently never uses the GPU.
.venv/Scripts/python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
.venv/Scripts/python.exe -m pip install -r requirements.txt

# Quantized (.gguf) model support — required for the fast/low-VRAM paths.
git clone https://github.com/city96/ComfyUI-GGUF.git custom_nodes/ComfyUI-GGUF
.venv/Scripts/python.exe -m pip install -r custom_nodes/ComfyUI-GGUF/requirements.txt

# Background removal used by the service (optional but strongly recommended:
# without it, cutouts fall back to colour keying, which is far worse).
.venv/Scripts/python.exe -m pip install "rembg[cpu]"
```

Verify CUDA actually works before going further:

```bash
.venv/Scripts/python.exe -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

## 3. Models

Driven by `local-inference/src/modelManifest.ts` — one command per family, no
URLs to copy:

```bash
cd ../genvy
npm run fetch-models -w local-inference -- --list          # sizes and destinations
npm run fetch-models -w local-inference -- z-image-turbo   # ~28GB, start here
npm run fetch-models -w local-inference -- hidream-o1      # ~8GB, optional
npm run fetch-models -w local-inference -- --all           # everything
```

Add `--comfy /path/to/ComfyUI` (or set `COMFYUI_DIR`) if ComfyUI is not at
`../ComfyUI`. Files already present are skipped, and partial downloads land on
`.part` files, so an interrupted run is safe to repeat.

**Which family to install:** Z-Image Turbo is the default and the only one
that animates. Add HiDream-O1 only if you want a second look for anchors.

## 4. Run it

Two processes. ComfyUI first:

```bash
cd ../ComfyUI
.venv/Scripts/python.exe main.py --lowvram --port 8188     # drop --lowvram on 12GB+
```

Then the service (from the genvy folder), matching your GPU:

```bash
# 4GB card — quantized model, small canvas
COMFY_RENDER_SIZE=640 COMFY_CHECKPOINT=z_image_turbo_q4.gguf \
  REMBG_PYTHON=../ComfyUI/.venv/Scripts/python.exe \
  npm run dev:local

# 12GB+ card — full precision, bigger canvas
COMFY_RENDER_SIZE=1024 REMBG_PYTHON=../ComfyUI/.venv/Scripts/python.exe npm run dev:local
```

On Windows PowerShell, set the variables with `$env:NAME = 'value'` first, or
put them in the root `.env` (see `.env.example` for the full list).

## 5. Check it worked

```bash
curl http://127.0.0.1:3021/health
```

You want `comfy.up: true`, `rembg: true`, and your family listed with
`verified: true, available: true`. `available: false` means ComfyUI cannot see
the model file — check the filename matches the manifest exactly and restart
ComfyUI so it re-scans.

In the app, Sprite Forge's PROVIDER dropdown should now offer **LOCAL COMFYUI ·
FREE**, with a LOCAL MODEL dropdown beside it.

## 6. What each family can do

| family | anchors | turns (W/E/N) | animation | repair | measured on a 4GB card |
| --- | --- | --- | --- | --- | --- |
| `z-image-turbo` | ✓ | — | ✓ pose-conditioned | ✓ | 67s @640 (Q4) — the daily driver |
| `hidream-o1` | ✓ | — (disabled: see README) | — | — | 134s @640 |
| `flux2` | ✓ | untested | — | — | **~32 min @640** — best quality, needs 24GB+ to be practical |

Render times scale with VRAM: everything above assumes weights streaming
through a 4GB card. A 12–16GB card is several times faster, and FLUX.2 only
becomes reasonable at 24GB+.

Jobs route by capability, so a family that lacks a job hands it to one that
has it; if none can, the UI says so rather than silently billing a paid
provider. West/east anchors can always be mirrored from each other for free.

## Troubleshooting

**`torch.cuda.is_available()` is False** — CPU-only torch got installed. Wipe
the venv and install torch from the cu126 index *before* `requirements.txt`.

**Renders fail with "Value not in list"** — ComfyUI has not indexed a model
file. Confirm the path under `ComfyUI/models/` and restart ComfyUI.

**Out of memory** — lower `COMFY_RENDER_SIZE` (640, then 512), use the `.gguf`
checkpoint, keep `--lowvram`, and close other GPU applications.

**Everything is very slow** — expected below 8GB VRAM: the model streams from
system RAM every step. On a 4GB card, ~67s per 640px image with the Q4 model
is normal; a 12GB card is several times faster.

**Edited a workflow JSON and nothing changed** — the service caches templates
in memory; restart it.

**Changing `MODEL_FAMILY`/`COMFY_CHECKPOINT`** — `COMFY_CHECKPOINT` applies
only to the family it was configured for. Per-job family switching from the UI
uses each family's own default checkpoint.

## Where things live

- `local-inference/src/modelManifest.ts` — model URLs, sizes, destinations
- `local-inference/src/models.ts` — family capabilities and verification status
- `local-inference/workflows/<family>/*.json` — the ComfyUI graphs
- `local-inference/README.md` — architecture, HTTP contract, tuning history
