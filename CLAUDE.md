# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run dev                  # server (:3020) + client (http://localhost:5173) concurrently
npm run dev:local            # P6 local-inference service (:3021) — optional, needs ComfyUI for real renders
npm run fetch-models -w local-inference -- --list   # local model sets + sizes (setup: docs/local-inference-setup.md)
npm run typecheck            # tsc --noEmit across all four workspaces (there is no linter)
npm test                     # unit tests (vitest): server + local-inference (skeletons, queue, workflows)
npm run smoke:ai -w server   # SPENDS API CREDITS: one DeepSeek + one image call through the full pipeline
```

Single test file: `npx vitest run test/imagePipeline.test.ts` from `server/` (or `npm test -w server -- imagePipeline`).

AI needs a `.env` in the repo root (gitignored, already present) with `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` and optionally `RETRODIFFUSION_API_KEY`. Without keys the app still runs — AI buttons report LINK OFFLINE; upload and manual editing keep working.

**The user usually has `npm run dev` running already.** Starting your own is wasteful and confusing (the second server loses :3020 to `EADDRINUSE` and Vite silently moves to :5174, so your browser checks hit *their* instance anyway). Check whether :5173/:3020 are up and use that.

**Ask before any test that spends API credits.** Local/deterministic work — typecheck, vitest, image pipeline ops, headless UI checks against the running dev server — is free and needs no permission.

## Big picture

Genvy is a gamified, AI-first 2D game-content creation suite (Phaser 4). Users forge assets (characters, tilesets, worlds; 18 more tools planned) into a persistent **collection** on disk; a later phase assembles collections into playable games. The UX is deliberately game-like (sci-fi hub, HUD, synthesized sounds) — never a plain web layout.

npm workspaces: `shared/` → `server/` → `client/`, plus `local-inference/` (standalone P6 service).

- **shared/** is consumed as raw TypeScript source (its `main` points at `src/index.ts`; "build" is just `tsc --noEmit`). It is the single source of truth: zod schemas for every asset type (`src/schemas/`, registered in `assetSchemaRegistry` in `schemas/index.ts`), typed API contracts (`src/api.ts`), and the 20-tool roster (`src/tools.ts`, `ready: true` gates what the hub enables).
- **server/** (Fastify, :3020) proxies all AI calls so keys never reach the browser, and owns the library + image pipeline.
- **client/** is Vite + Phaser 4 scenes with an HTML HUD overlay built from custom elements (`src/hud/`) — WebAudio-synthesized sfx, Web Animations API, **no React, no CSS frameworks**. Each tool = a Phaser scene (`src/game/scenes/`) plus HUD panels.

### The collection (server/src/services/library.ts)

Every asset is JSON at `library/assets/<type>/<id>.json` with binaries under `library/files/<id>/`, indexed in `library/index.json` (`library/` is gitignored). Cross-references are **always `{id, type}` pairs**. The server validates schema + referential integrity on every write and refuses to delete a referenced asset (409 with referrer list) unless forced. Keep this shape — later milestones build on it.

### Commit and push often

Commit and push to `origin/main` at every coherent stopping point — a feature landing, a bug fixed and verified, a refactor compiling clean with tests green. Do not let days of work pile up as uncommitted diff: one session here lost methods to a bad edit and had to recover them from the last commit, and the recovery is only as good as the last push. Typecheck + tests green is the bar for committing; a red tree never gets committed. Small, described commits — the message says what changed and why, not "wip".

### One session, one asset (applies to EVERY tool and module)

A tool session edits **one** asset and keeps editing that same asset. This is not a per-tool detail — it holds for sprites, tilesets, worlds, scenes and every tool added later.

- **Progress saves itself.** Every step that produces something worth keeping (a generated image, an accepted anchor, a painted layer, an edited concept) is written to the asset as it happens. The user must never lose work by navigating away, and must never have to hunt for a save button to keep what the AI just cost them.
- **Never duplicate.** Re-running generation, re-forging, or saving again **updates the open asset in place** (`updateAsset`), never `createAsset`. A trail of near-identical entries in the inventory is a bug, every time. Pass the open asset's id to `/api/ai/image` so new files land in that asset's own directory.
- **An unnamed draft is the same asset.** The first generation may create an auto-named draft; when the user then names it and saves, that **overwrites the draft** — it does not mint a second entry. Only an explicit "start a new one" action creates another asset.
- **Show which asset is being written.** The UI states what is open and what saving will replace, and offers an explicit way to start a fresh asset. A user must never learn from the inventory that a second copy appeared.

### AI generation flow

Text is DeepSeek; images go through a **provider registry** (`server/src/providers/`) so the pipeline never talks to a vendor directly:
- **DeepSeek** (`deepseek-chat`, JSON mode) generates concepts/configs/layouts against the system prompts in `server/src/prompts/index.ts`, validated by zod schemas from `shared/src/schemas/aiConcepts.ts` (`POST /api/ai/text`).
- **OpenAI gpt-image-2** (never gpt-image-1) — the default: native alpha, multi-reference edits, good instruction-following. Priced per canvas AND quality (`OPENAI_IMAGE_PRICE` in `server/src/providers/openai.ts`, mirrored in `client/src/hud/providerControls.ts`): low/medium/high are $0.005/$0.041/$0.165 at 1024x1536 and 1536x1024, and $0.006/$0.053/$0.211 at 1024x1024 — a square costs MORE, not less. Keep the two tables in step or the header spend contradicts the button that spent it.
- **Retro Diffusion** (optional key) — true pixel grids and a purpose-built animation endpoint; auto-preferred for animations in `pixel-*` styles. Uses the **v2 async API** (submit → poll `task_id`) and reports exact cost/balance, so its spend is booked from the provider, not estimated.
- **Local ComfyUI** (`local-inference/` workspace, service on :3021) — free (`costEstimate: () => 0`), pose-conditioned: procedural COCO-18 skeletons (phase-accurate walk/run/idle/jump/attack, vitest-enforced) drive OpenPose ControlNet while the anchor drives IP-Adapter identity. Registered as `local-comfy`; `live` is a health poll of the service (which requires ComfyUI up). SDXL can't emit alpha: the service prefers rembg segmentation cutouts (`REMBG_PYTHON`), falling back to the provider's deterministic chroma keying — that's why it may claim `nativeAlpha`. GPU-validated end to end (see the tuning-history table in `local-inference/README.md` — the workflow weights are evidence-pinned by tests; don't retune them without new renders). Production quality needs the 16GB tier (768px + style LoRA).
- Gemini was evaluated and **removed** (magenta/blank frames). Don't re-add it without new evidence.

A provider exposes capabilities (`generate/edit/multiReference/nativeAlpha/animation/maxSize/costEstimate`); routes branch on capability, never on provider id. Moderation rejections (422) trigger one automatic sanitize-and-retry through DeepSeek, and are **not billed** — nothing is rendered or charged when a prompt is refused.

**Sprite Pipeline v2 is implemented (P1–P5) — read `docs/sprite-pipeline-v2.md` §D for what shipped, what was deliberately dropped and why, before changing generation, prompts, or the image pipeline.** In short: anchor-first chain (no animation without an accepted neutral anchor for that facing), per-subject views (`shared/src/spriteSubjects.ts`) where a facing is *a turn plus a handedness* (`deriveOp`), validation gates with bounded retry and per-frame repair, foot-baseline/foot-centroid registration, and StyleContract post-steps.

Image post-processing (`server/src/services/imagePipeline.ts`, exposed via `routes/imageOps.ts`) is deterministic sharp/Buffer code: background removal, sprite-cell detection by alpha projection, registration, nearest-neighbor downscale, grid packing, mirror/rotate about a pivot. **Pipeline stages are kept on disk** (`raw.png` → `sheet.png` → `thumb.png`) so later stages can be re-run without re-spending image credits — preserve that property. Two rules learned the hard way: never re-center frames by bounding box after registration (a reaching limb drags the body sideways), and never key colours by hue heuristics (a green-borders detector mangled green sprites — it's gone).

**Export** (`server/src/routes/export.ts`): `/api/export/sprite` writes a bundle under `library/exports/` — PNG, a genvy manifest with **absolute frame rects + pivots**, a Phaser/TexturePacker atlas, the anchors, and a `.zip` of everything (dependency-free writer in `services/zip.ts`).

The original platform plan (and what M1 shipped vs it) is preserved in `docs/original-plan-m1.md`. The next phase — pose-conditioned local generation — is specified in `docs/p6-local-inference.md`.

### Progress feedback (required for every AI request)

AI work takes 10–90s, so **no AI request may run behind an indeterminate spinner** — image, video or text, API provider or local inference service. Every one must:

1. run behind the scene's `busy(label, fn, timing)` with a `timing` bucket, so the bar fills over that bucket's learned average (`client/src/hud/progress.ts`: `expectedDuration` / `recordDuration`, rolling per-operation averages in localStorage);
2. update its stage text at each step via `HudShell.setBusyLabel('<i>/<n> <MODEL OR SERVICE> · <WHAT IT IS DOING>...')`, distinguishing free local steps from paid calls;
3. key its bucket by operation + shape (`anim:8`, `anchor:directional`, `tileset:image`) — never by asset id, or the average never converges.

Keeping this accurate and informative is an ongoing job, not a finished feature: the **`progress-feedback` skill** (`.claude/skills/progress-feedback/`) carries the contract, a checklist, and a ranked list of improvement ideas (server-driven SSE stages, per-provider buckets, retry-aware estimates, variance-based pacing, stall detection, cost preview). Load it whenever you touch an AI call or the busy indicator, and propose one concrete improvement.

### HUD conventions (client/src/hud/)

- **Sprite Forge is a wizard**: `setStage('concept' | 'blueprint' | 'variants' | 'editing')` owns which panels are visible. All the wizard's panels are handed to `HudShell.setLayout` at once, so they are **hidden before mounting** — otherwise every step flashes for a frame while the async layout mounts.
- Panels enter with a fade-up (`hud/anim.ts`). A CSS `translate` extends its scrolling ancestor's *scrollable overflow*, so docks are clipped (`.g-clip`) while children animate, or a scrollbar flashes.
- The stage image renders at a **virtual-square fit capped at 100%** — never upscaled (upscaling is what looks blurry), pixel-aligned, with 10%-step wheel zoom and a live `NAME · SUBJECT · STYLE · ZOOM%` caption.
- Backdrops must redraw on `Phaser.Scale.Events.RESIZE` (`game/backdrop.ts`) — a grid painted once keeps the window size it was born with.
- Textareas holding AI prose use `autoGrow` rather than fixed heights; a hidden textarea measures 0, so fill it *after* showing its panel.

### Adding a tool

Register asset schemas in `assetSchemaRegistry` (`shared/src/schemas/index.ts`), add system prompts in `server/src/prompts/`, flip `ready: true` in `shared/src/tools.ts`, and follow the existing scene + HUD-panel pattern (SpriteToolScene / WorldToolScene are the references). Wire every AI call per **Progress feedback** above, and every save per **One session, one asset** above.
