# P6 — Local inference service

Status: **built; GPU round-trip not yet validated.** Everything listed under "How to validate
without a GPU" is implemented and covered by vitest (see `docs/sprite-pipeline-v2.md` §D and
`local-inference/README.md` for what shipped and the GPU tiers). What remains is running the
four workflows against a real ComfyUI and tuning them on the output.

## Why this is next, and why nothing before it fixed the real problem

Sprite-sheet generation from a single prompt cannot reliably produce a smooth walk cycle.
The model draws N poses that each look right and together don't read as one motion: legs that
barely alternate, a body that drifts, a lead foot whose shading swaps mid-cycle.

Everything built in P3/P4 **detects** that — the gates score stride alternation, leg-swap
shading, silhouette drift, and mirrored sheets, then retry with correction hints and repair
individual frames. Detection has a ceiling: a model that was never told *where the limbs go*
is being asked to guess, and the gate can only reject guesses. **Pose conditioning replaces
the guess with a constraint**: render an explicit skeleton per frame, condition generation on
it via ControlNet/OpenPose, and the leg phase stops being a lottery.

Cost is the second reason. gpt-image-2 is $0.005/image; a character with four facings and a
handful of clips runs into dollars, and every gate retry spends again. Local inference makes
iteration free, which changes what the tool feels like to use.

## Deliverable

A `local-inference` service (new workspace, HTTP, same shape as the existing providers) that
Genvy registers as another `ImageProvider`. It must be optional: with the service down, the
app behaves exactly as it does today.

### Scope

1. **Service skeleton** — job queue, health endpoint, SSE progress, usage metering. The
   contract stays open even though hosting will eventually be metered.
2. **ComfyUI wrapper** — reference workflow JSONs checked into the repo, parameterized by the
   StyleContract and the request. Workflows needed:
   - *anchor generate* (text → neutral anchor, one figure, transparent or keyable)
   - *directional anchor* (identity-preserving edit — IP-Adapter from the primary anchor)
   - *animation frame* (OpenPose-conditioned, IP-Adapter identity, one frame per pose)
   - *repair* (img2img denoise ~0.75 on a single rejected frame)
3. **Skeleton generator** — procedural 18-keypoint COCO skeletons for the standard clips
   (walk, run, idle, jump, attack…), rendered to PNG, phase-accurate per frame. This is the
   piece that makes the whole phase worth doing; it is deterministic code, testable without a
   GPU, and belongs in `shared/` or the service, not in ComfyUI.
4. **Provider registration** — `capabilities: { generate, edit, multiReference, nativeAlpha,
   animation, maxSize, costEstimate: () => 0 }`, plus health surfaced in the provider picker.
5. **GPU tiers documented** (8GB / 16GB) with the model choices per tier.

### Model stack (from the research pass, `docs/sprite-pipeline-v2.md` §E4)

- SDXL base or Pixel Art Diffusion XL; nerijs Pixel Art XL LoRA (LCM 8 steps, cfg 1.5,
  strength ~1.2; generate at 1024, downscale).
- IP-Adapter `ip-adapter-plus_sdxl_vit-h` + ViT-H clip vision, weight 0.85, style-transfer
  mode — this is the identity lock, the local equivalent of our reference-image edits.
- ControlNet `controlnet-openpose-sdxl-1.0`, strength 1.0, with the procedurally rendered
  skeletons.
- KSampler dpmpp_2m/karras, 25 steps, cfg 6.0–6.5; 768×768 renders fit ~12GB VRAM.
- Anchor editing: Qwen-Image-Edit 2509/2511 GGUF via ComfyUI-GGUF (Q4+ at 16GB,
  Q2/Q3+Lightning at 8GB). FLUX.1 Kontext dev fp8 is the alternative (~12GB) — **never**
  nf4+LoRA, it is pathological.
- Base negative prompt: `multiple characters, duplicate, text, watermark, frame, border,
  blurry, cropped, extra limbs, missing limbs, bad anatomy, deformed, facing left, facing
  backwards`.

## Constraints that must survive this phase

- **The gates stay.** Pose conditioning improves the odds; it does not remove the need to
  score results. `animationGate` should run on local output exactly as it does on API output.
- **Progress feedback is mandatory** (see CLAUDE.md): local steps get the same determinate
  bar and stage text as paid ones, explicitly labelled FREE so the difference is visible.
- **Anchor-first is not negotiable.** Local generation still starts from an accepted neutral
  anchor per facing; the skeleton conditions the motion, the anchor conditions the identity.
- **Capability-driven routing.** Nothing may branch on the provider id; add capabilities if
  the local service can do something the interface cannot yet express.
- The app must run unchanged when the service is absent.

## How to validate without a GPU

The skeleton generator, workflow-JSON parameterization, job queue, SSE contract and provider
registration are all testable with vitest and fixtures. Build and test those first; the
ComfyUI round-trip is the last mile, not the first.
