# Genvy — Original Milestone 1 Plan (2026-08-29)

> **Historical document.** This is the plan the project was started from, preserved
> as written. Several decisions here have since been superseded by what was actually
> built — see "What changed since" at the bottom, and `docs/sprite-pipeline-v2.md`
> for the current direction.

## Context

The repo is greenfield (LICENSE + untracked `.env` with a DeepSeek key for text gen and an OpenAI key for GPT Image, low quality, 1024x1536 / 1536x1024 only). Goal: a suite of AI-first creation tools that let users build a **collection** of typed 2D game assets (worlds, characters, NPCs, sounds, animations, FX, …) which a later phase (out of scope now) assembles into playable Phaser 4 games. The creation experience itself must feel like a game: futuristic HUD, sounds, tweens — not a web layout.

Decisions confirmed with the user:
- **Platform**: Web app + local Node server (server proxies AI calls so keys never reach the browser; persists collection to disk).
- **UI**: Live Phaser 4 scene as the workspace (WYSIWYG previews) + futuristic HTML HUD overlay panels.
- **AI-first**: every tool has a generate path (DeepSeek → JSON configs/text; GPT Image → sprites/tilesets/backgrounds, post-processed into game-ready assets).
- **Milestone 1**: HUD shell/hub + Sprite/Character Creator + World/Tilemap Maker.

## Tech Stack

- TypeScript 5 (strict) everywhere; npm workspaces: `client`, `server`, `shared`.
- Client: Vite, `phaser@4` (pin exact version). No React — HUD is custom elements (`<genvy-panel>`, `<genvy-button>`, …) in plain TS + CSS (backdrop-filter, glow keyframes, clipped sci-fi corners). HUD animations via Web Animations API (`hud/anim.ts`); UI sounds via Howler singleton (`UISound.ts`).
- HUD layering: `#game-canvas-host` + sibling `#hud-root` (`position:absolute; inset:0; pointer-events:none`, panels re-enable). No Phaser DOM plugin.
- Server: Node 22 + Fastify 5 (`@fastify/static`, `@fastify/multipart`, `@fastify/cors`), `sharp` for image ops, `zod` schemas in `shared/` as the single contract (server validation + client forms + DeepSeek JSON-mode validation).
- AI: DeepSeek `chat/completions` (OpenAI-compatible, JSON output mode, validate-with-zod + one retry on failure); OpenAI `gpt-image-1` quality `low`, sizes 1024x1536 / 1536x1024 only.
- Dev: `concurrently` — Vite (5173, proxies `/api`) + `tsx watch` server (3020). `.gitignore` must cover `.env`, `node_modules`, `dist`, `library/`.

## Folder Structure

```
genvy/
  package.json                # workspaces + dev/build scripts
  shared/src/
    ids.ts                    # branded AssetId, newAssetId(), AssetRef<T>
    schemas/                  # base.ts + one file per asset type + index.ts (AssetType union + zod registry)
    api.ts                    # typed request/response for every endpoint
  server/src/
    index.ts  config.ts
    routes/   assets.ts files.ts aiText.ts aiImage.ts imageOps.ts
    services/ library.ts deepseek.ts openaiImage.ts imagePipeline.ts
    prompts/  spritePrompt.ts worldPrompt.ts ...
  client/src/
    main.ts
    game/GameConfig.ts
    game/scenes/  BootScene.ts HubScene.ts SpriteToolScene.ts WorldToolScene.ts
    game/fx/      # scanline shader, glow pipeline, grid renderer
    hud/          HudShell.ts components/ theme.css UISound.ts anim.ts transitions.ts
    api/          client.ts assets.ts ai.ts imageOps.ts
    tools/        spriteTool/{controller,panels,slicePreview}.ts  worldTool/{controller,panels,paintController}.ts
    state/collection.ts
  library/                    # USER DATA (gitignored)
```

## Data Model — the Collection

Every creation is an **asset**: `library/assets/<type>/<id>.json` + binaries under `library/files/<id>/`, indexed in `library/index.json`. `AssetBase = {id, type, name, description, tags, createdAt, updatedAt, thumbnail?}`. Cross-references are always `AssetRef = {id, type}` (never inlined) so the server validates referential integrity and Phase 2 can walk the graph.

Key schemas (all zod in `shared/schemas/`): **spritesheet** (image + frame grid + frames), **animation** (sheet ref + frame indices + frameRate/repeat/yoyo), **character** (sheet + named animations + stats + physicsPreset ref + control style), **tileset** (image + tile size + per-tile collides/tags), **world** (tileset ref + layers of tile data/object placements + spawn points + ambience/physics/camera refs), **npc/enemy** (character-like + behavior config / dialogue ref), **item**, **sound/music**, **particle** (Phaser emitter config), **dialogue** (node graph), **quest**, **physicsPreset**, **camera**, **uiTheme/gameUi**, **cutscene**, **projectMeta** (Phase-2 game bundle).

Server rules: zod validation on write, referenced IDs must exist, DELETE returns 409 with referrer list unless `?force=true`, atomic writes (temp + rename).

## Server API

- Assets: `GET /api/assets?type=&tag=&q=`, `GET/POST/PUT/DELETE /api/assets/:id`, `GET /api/assets/:id/refs`.
- Files: `POST /api/files/:assetId` (multipart), `DELETE /api/files/:assetId/:filename`; static `GET /library/files/*`.
- AI: `POST /api/ai/text {tool, prompt, schemaName?, context?}` (system prompt from `prompts/`, JSON mode + zod validate + 1 retry; SSE variant `/api/ai/text/stream` for prose); `POST /api/ai/image {prompt, orientation, assetId?}` → saves `raw.png`, returns FileRef.
- Image ops: `POST /api/image/remove-bg | slice-sheet | extract-tiles | downscale | crop` — each writes stage outputs to the asset's files dir; `GET /api/health`.

## Image Pipeline (GPT image → game asset)

Stages kept on disk (`raw.png` → `keyed.png` → `sheet.png` → thumb) so later stages re-run without re-spending credits:
1. **Sliceable prompts**: server templates force strict grids on flat key-color backgrounds. Clean divisors of 1024x1536: 2x3 (512px), 4x6 (256px), 8x12 (128px) cells; landscape mirrored.
2. **remove-bg**: corner-sample key color → edge flood fill with tolerance + tighter global chroma pass → alpha. Client Canvas-2D preview lets the user tune tolerance live before committing.
3. **slice-sheet**: cols×rows cut, optional per-frame trim-to-content re-centered on a uniform canvas so animation frames align; repacked `sheet.png` + frame metadata. Client `slicePreview.ts` shows a draggable marching-ants grid overlay (AI grids are never pixel-perfect).
4. **extract-tiles**: grid cut + perceptual-hash dedupe → packed power-of-two `tileset.png` + index remap; user tags collidable tiles.
5. **downscale**: sharp nearest-neighbor to game res (e.g. 256→32/48px) after slicing; optional median-cut color quantization; lanczos for painterly styles.
6. **thumbnail**: 128px `thumb.png` per asset.

## HUD Shell — "Command Center"

- One persistent Phaser `Game`; each tool is a scene. `HudShell` (DOM) is permanent, swaps per-tool panel layouts (`setLayout(toolId, PanelSpec[])`) with staggered slide/flicker mounts; persistent top bar (logo, "Assets forged" counter, back-to-hub).
- **BootScene**: loads sfx/fonts/shaders → typewriter "GENVY OS — SYSTEMS ONLINE" boot animation.
- **HubScene**: dark parallax grid + particle motes; tools are holographic floating "stations" (hover = ring spin + sfx, click = camera dolly + transition). Unbuilt tools shown dimmed with "COMING ONLINE". Right-side Collection drawer of `genvy-asset-card`s (click → open owning tool with asset loaded).
- **transitions.ts**: `goToTool()` = choreographed promise chain (panels out → whoosh → camera flash + `scene.start` → intro tween → panels in).
- Every successful generation plays a "loot drop": asset card flies into the drawer with chime + glow.

## Exhaustive Tool List (21 tools; M1 builds 1–3, rest appear locked in hub)

1. **Hub / Command Center** — navigation, collection browser/search, duplicate/delete, reference-graph inspector.
2. **Sprite / Character Creator** — prompt → DeepSeek concept (name/stats/image-prompt) → GPT Image pose sheet → slice/key/downscale → character + spritesheet + default animations.
3. **World / Tilemap Maker** — theme prompt → tileset generation + extraction → live Phaser tilemap painting (brush/fill/rect, layers, collision flags, spawn points); DeepSeek can draft full layouts.
4. **NPC Designer** — character pipeline + AI personality, dialogue ref, schedule/wander behavior.
5. **Enemy Forge** — behavior configs (patrol/chase/ranged/boss phases), stats, drop tables; sandbox arena preview.
6. **Item Smith** — icon grids in one GPT image → sliced; kind/effects/rarity via DeepSeek.
7. **Animation Studio** — timeline over any spritesheet: reorder, frameRate/yoyo/repeat, onion-skin, named clips.
8. **Particle FX Lab** — live emitter + sliders; "describe an effect" → emitter config JSON; preset shelf.
9. **Sound Designer** — jsfxr-style Web Audio synthesis; DeepSeek maps descriptions → synth params; upload path.
10. **Music Composer** — chiptune sequencer (Tone.js); DeepSeek generates pattern JSON; export loops.
11. **Dialogue Writer** — node-graph editor; DeepSeek writes branching dialogue from character sheets; playtest mode.
12. **Quest Architect** — objectives referencing NPCs/enemies/items/worlds; AI drafts chains using the collection index as context.
13. **Game UI Kit Builder** — generated-game HUD (healthbars, inventory, minimap, menus); GPT Image 9-slice frames/icons.
14. **Physics Tuner** — sandbox with live gravity/drag/bounce sliders → named presets.
15. **Camera Director** — follow/lerp/deadzone/zoom/shake presets vs dummy target.
16. **Cutscene Composer** — timeline of camera/dialogue/animation/FX steps with playback.
17. **Background / Parallax Painter** — landscape image → split parallax layers → scrolling preview.
18. **Portrait / Iconography Studio** — expression sheets and emotes linked to characters.
19. **Projectile / Weapon Workshop** — projectile sprites + motion configs + FX refs + damage.
20. **Pickup & Hazard Designer** — animated pickups/hazards with trigger behaviors.
21. **Game Bundle Assembler** — Phase-2 gateway: projectMeta grouping + reference-graph completeness validation (stub in M1).

## Milestone 1 — Implementation Order

1. Scaffolding: workspaces, Vite client, Fastify server, shared pkg, dev scripts, `.gitignore` (`library/`, `.env`).
2. `shared/`: base + spritesheet/animation/character/tileset/world schemas, `api.ts`, zod registry.
3. Server: `library.ts` (CRUD/files/index/ref-integrity), asset+file routes, static serving.
4. Server: `deepseek.ts`, `openaiImage.ts`, AI routes, sprite/world prompts.
5. Server: `imagePipeline.ts` + image-op routes.
6. Client: Phaser boot, BootScene, HubScene (21 stations), HudShell + components + theme + UISound (~8 CC0 sfx) + transitions.
7. Sprite tool end-to-end (concept → forge → slice → key → downscale → save → animated preview → loot drop).
8. World tool end-to-end (tileset gen → tag collisions → paint layers → AI layout draft → save/load).
9. Collection drawer + load-existing flows.

Later: **M2** visual family (Animation, FX, Parallax, Portraits) → **M3** actors (NPC, Enemy, Item, Projectile, Pickup) → **M4** audio → **M5** narrative & systems → **M6** bundle assembler.

## Verification (M1)

- Vitest server tests: library CRUD round-trip in temp dir, zod rejections, 409 on referenced delete, imagePipeline against synthetic fixture grids (frame counts, alpha, exact nearest-neighbor dims).
- `tsc --noEmit` across all workspaces.
- Manual AI smoke script (`server/scripts/smoke-ai.ts`) run sparingly to limit spend: one DeepSeek JSON call + one image through the full pipeline.
- Manual E2E checklist (README): boot → hub sfx/stations → sprite flow → persist across reload → world paint/save/reload → referenced-delete 409.
- Offline mode: with keys absent, AI buttons show "LINK OFFLINE"; upload + manual editing still work.

---

## What changed since (as built)

- **Image model**: `gpt-image-1` → **`gpt-image-2`** (project rule: always image-2), configurable via `OPENAI_IMAGE_MODEL`.
- **Sprite flow**: the single 4×6 pose sheet was replaced by a three-stage flow — one image of **4 design variants** → lock one as a reference → forge **one animation at a time** via the images/**edits** endpoint using that reference (far better character consistency). Each variant is its own workspace with its own clips and saves.
- **Backgrounds**: transparent output requested directly instead of magenta chroma-keying; `remove-bg` is now only for uploads with solid backdrops. Optional green cell borders (stripped by the pipeline) are an experimental separation aid.
- **Slicing**: fixed grid slicing replaced by **alpha-projection detection** with axis-aware splitting of merged poses, plus a manual mode (draw rectangles, shift-lasso, edge drag, frame delete/restore ghosts, Ctrl+Z) that union-masks the pixels of each frame.
- **Persistence**: everything auto-saves — `clips.json` (clips, frame order, selections, prompts), `concept.json` (prompts, sliders, AI concept), `source.json` (session/variant linkage); AI raws are never overwritten by processing, so any resolution or slicing change is a free local re-derive.
- **Collection UI**: character icon grid with a slide-out detail panel (V1–V4 squares), sessions as the grouping unit, recovery for interrupted work.
