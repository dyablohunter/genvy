# @genvy/local-inference

Free, pose-conditioned sprite generation (Sprite Pipeline v2, phase P6 —
`docs/p6-local-inference.md`). A small HTTP service that wraps a local ComfyUI
behind a job queue and registers with the Genvy server as the **Local ComfyUI**
image provider (`costEstimate: () => 0`). Optional by design: when this service
(or its ComfyUI) is down, the provider shows OFFLINE and the app behaves
exactly as it does without it.

What it adds over the API providers: **motion is constrained, not guessed**.
Every animation frame is conditioned on a procedurally generated, phase-accurate
18-keypoint COCO skeleton (OpenPose ControlNet), while the accepted directional
anchor conditions identity (IP-Adapter). Anchor-first stays — no animation
without an anchor; the skeleton conditions the motion, the anchor the identity.

## Running

**Setting this up on a fresh machine? Follow
[`docs/local-inference-setup.md`](../docs/local-inference-setup.md)** — it
covers ComfyUI, CUDA torch, the custom nodes, and the model downloads
(`npm run fetch-models -w local-inference -- --list`).

```
npm run dev:local          # from the repo root (service on :3021)
```

Env (all optional): `LOCAL_INFERENCE_PORT` (3021), `COMFYUI_URL`
(http://127.0.0.1:8188), `COMFY_CHECKPOINT`, `COMFY_RENDER_SIZE` (768). The
Genvy server finds the service via `LOCAL_INFERENCE_URL` in the root `.env`.

## HTTP contract

- `GET  /health` — `{ ok, comfy: { up, device }, queueDepth }`; the provider is
  LIVE only when ComfyUI itself answers.
- `POST /jobs` — `{ type: 'generate'|'edit'|'animate'|'skeleton', payload }` →
  `202 { jobId }`. Payloads are zod-validated at submit (400 with a reason).
- `GET  /jobs/:id` — state + progress (stage text, step i/n, `free` flag).
- `GET  /jobs/:id/events` — SSE: `progress` events, then `done`/`failed`.
- `GET  /jobs/:id/result` — the PNG (or strip). Results kept 10 minutes.
- `GET  /usage` — jobs / failures / GPU wall-time / images per job type.
- `POST /skeletons` — synchronous skeleton-strip preview (no GPU needed).

Jobs run strictly one at a time (one GPU). Everything is metered even though
it is free — hosted deployments will meter the same figures into billing.

## ComfyUI workflows (`workflows/*.json`)

Checked-in templates in ComfyUI API format: `{ meta, bindings, nodes }`.
`bindings` names every input this service is allowed to write (prompt, seed,
sizes, uploaded image slots, the LoRA splice points), so moving a node breaks a
unit test instead of a GPU run. StyleContracts flow in as prompt blocks plus a
`loraStack` spliced between the checkpoint and its consumers.

| workflow | purpose |
| --- | --- |
| `anchor-generate` | text → neutral anchor (SDXL txt2img) |
| `anchor-directional` | identity-preserving facing edit (IP-Adapter 0.85, style transfer) |
| `animation-frame` | one frame: OpenPose ControlNet (strength 1.0) + IP-Adapter identity (0.7 linear — GPU-tuned) |
| `repair` | img2img re-denoise ~0.75 of a rejected frame |

SDXL has no alpha channel, so workflows render onto flat chroma **magenta**
(`#FF00FF` — green clashed with green outfits on the first GPU run); the
Genvy-side provider keys it into real alpha with the existing deterministic
pipeline, which is why it can honestly declare `nativeAlpha`.

## Model families (`MODEL_FAMILY`, default `sdxl`)

One family is active per service instance; each owns a template set under
`workflows/<family>/` and only claims the job shapes its ecosystem supports
(`/health` reports the active family and its `verified` flag). All non-SDXL
templates were transcribed from the official Comfy-Org reference workflows
(2026-09-05) but have **not** run on a GPU here yet — expect first-contact
touch-ups (exact input names are the usual suspects).

| family | generate | directional | animation | repair | VRAM | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `z-image-turbo` (default, verified) | ✓ | — | ✓ pose only | ✓ | 6–8GB GGUF / 12GB bf16 | 8-step turbo; cfg 1 ⇒ negatives are IGNORED; no identity adapter yet — identity rides on the prompt (`identityPrompt`). Measured on a 4GB card: bf16@768 ≈ 150s warm/render; **Q4 GGUF@640 ≈ 67s** (set `COMFY_CHECKPOINT=z_image_turbo_q4.gguf`; the loader swap is automatic) |
| `hidream-o1` (verified) | ✓ | ✓ native reference edit | — | — | 8.1GB fp8 (encoder bundled) | MIT. Measured on 4GB: generate 134s@640; reference edit 212s@**1408 minimum** (edits below ~2MP return BLANK — the runner clamps up via `minEditSize`). The reference is the dotted autogrow input `images.image_1`. Quirks: edits pale the palette; a WEST ask can come back EAST-facing (mirror downstream) |
| `flux2` (verified · **heavy**) | ✓ | ✓ reference latent (untested) | — | — | 24GB+ to be practical | 32B, non-commercial dev license. Best anchor quality measured here — and **1910s (~32 min) for one 640px image** on a 4GB card with Q4+fp4, nearly all of it streaming 20GB of weights. Flagged `heavy` so pickers say VERY SLOW |

**SDXL was removed** (2026-09-05) after live testing: pose conditioning worked,
but identity, prompt adherence and rendering quality never reached usable at
once on attainable VRAM — directional anchors and walk cycles both came out
unusable in end-user testing. Its tuning history below is kept because every
lesson transfers; its model files (SDXL base, openpose ControlNet, IP-Adapter,
CLIP-ViT-H, ~13GB) are still in `ComfyUI/models/` and can be deleted.

Evaluated, not templated: **HunyuanImage 3.0** (80B MoE, ~45GB at INT4 —
datacenter-class only) and **SD 3.5** (no openpose ControlNet ecosystem;
superseded by Z-Image Turbo at lower VRAM).

## Required ComfyUI setup

Custom nodes: **ComfyUI_IPAdapter_plus** (IPAdapterAdvanced). Models in the
usual ComfyUI folders:

- checkpoint: `sd_xl_base_1.0.safetensors` (or Pixel Art Diffusion XL)
- controlnet: `controlnet-openpose-sdxl-1.0.safetensors`
- ipadapter: `ip-adapter-plus_sdxl_vit-h.safetensors`
- clip_vision: `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`

## GPU tiers (from the P6 research pass)

**16GB** — SDXL base or Pixel Art Diffusion XL at 768–1024; nerijs Pixel Art
XL LoRA (LCM 8 steps, cfg 1.5, strength ~1.2; generate at 1024, downscale);
anchor editing via Qwen-Image-Edit 2509/2511 GGUF **Q4+** (ComfyUI-GGUF).

**12GB** — the shipped defaults: 768×768 renders, KSampler dpmpp_2m/karras,
25 steps, cfg 6.0–6.5. FLUX.1 Kontext dev **fp8** fits here as the anchor
editor (never nf4+LoRA — pathological).

**8GB** — set `COMFY_RENDER_SIZE=640`; Qwen-Image-Edit **Q2/Q3 + Lightning**
for anchor edits; prefer the Pixel Art XL LoRA's LCM path (8 steps) to keep
render times sane.

## GPU tuning history (SDXL era — family since removed; the LESSONS remain binding)

Tuned on an RTX 3050 Ti 4GB at 512px, 2026-09-05:

The full round-trip is **validated on real hardware**: skeletons condition the
pose (profile walkers with correct leg splits from round 1), jobs flow
service→ComfyUI→strip→keying→animation gate, and six tuning rounds fixed one
failure class each. Every value below is pinned by a unit test with the
evidence noted beside it:

| round | failure observed | fix now in the repo |
| --- | --- | --- |
| 1 | identity lost entirely (generic pedestrians) | IP-Adapter `style transfer` → `linear`; subject text added to the frame prompt |
| 2 | torso close-ups; ragged green keying | full-body framing prompt; and green clashes with green outfits |
| 3 | background painted as scenery, not a screen | segmentation cutouts (rembg) instead of trusting the background |
| 4 | magenta bled into the palette; literal border props | background described as plain WHITE, no color names; never say "frame"/"animation" in prompts — SDXL draws them |
| 5 | narrow passing poses lost composition to IP-Adapter | ControlNet 1.15 > IP 0.6 so pose outranks identity |
| 6 | at IP 0.6 identity goes abstract at 512px on SDXL base | the 4GB floor: needs 768px + a style LoRA / better checkpoint (16GB tier) |
| 7 | variants: a "2x2 grid" ask produced strips of noise; the prose prompt's "Negative constraints" list produced sheets of themed panels | `gridSheets` capability — the route renders 4 singles and composes; and **CLIP does not understand negation**: prompts written for instruction-following models (gpt-image-2) embed "no grid lines / no comic panels" as positive content, so grid-incapable providers get MINIMAL single-figure prompts (`single: true`) and prohibitions live only on the real negative channel |

Open tuning items for a real GPU: per-style checkpoints/LoRAs (Pixel Art XL),
768–1024 renders, possibly a two-pass flow (pose-locked render, then img2img
identity pass at low denoise), and feeding the gate's retry hints into the
frame prompts.

**rembg**: `pip install "rembg[cpu]"` into any Python (the ComfyUI venv is
convenient) and set `REMBG_PYTHON` to that interpreter. Optional and
fail-open — without it the provider's chroma keying is the fallback.

## The skeleton generator (`src/skeleton/`)

Deterministic TypeScript, fully unit-tested without a GPU — this is the piece
that actually fixes motion. Walk/run/idle/jump/attack (plus aliases like
`dash`→run, `slash`→attack), four facings where **west is the mirror of east
with left/right relabelled**, and the walk cycle's contract is enforced by
tests: legs exactly half a cycle apart, lead-foot swap exactly twice per
cycle, arm counter-swing, double body bob, seamless loop.
