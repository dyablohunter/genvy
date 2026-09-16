# GENVY

A gamified, HUD-based suite of AI-first creation tools for building 2D game content with **Phaser 4**. You forge assets — characters, tilesets, worlds, and eventually sounds, FX, dialogue, quests — into a persistent **collection** on disk, which a later phase assembles into playable games.

The creation process is designed to feel like a game: a sci-fi command center, holographic tool stations, synthesized UI sounds, and loot-drop moments when an asset is forged.

## Stack

- **client/** — Vite + TypeScript + Phaser 4. The workspace is a live Phaser scene; the UI is a futuristic HTML HUD overlay (custom elements, WebAudio-synthesized sfx, Web Animations API).
- **server/** — Node + Fastify. Proxies AI calls (keys never reach the browser), persists the collection to `library/`, and runs the image pipeline (sharp).
- **shared/** — zod schemas for every asset type + typed API contracts, imported by both sides.

AI: **DeepSeek** (`deepseek-chat`, JSON mode) for concepts/configs/layouts. Images go through a provider registry:

- **OpenAI gpt-image** (the default) — pick the model for each operation in its panel's MODEL select: **`gpt-image-2.5-flare`** (fast), **`gpt-image-2.5-sunburst`** (holds the subject tightest on edits) or **`gpt-image-2`**, all at the same token rates. Without a pick, flare draws new images (anchor candidates, tile grids, scenes) and sunburst does reference edits (anchor turns, animation sheets, frame repair, panel edits). QUALITY sits beside PROVIDER and lists the picked model's own tiers — gpt-image-2.5: **low · medium · high · xhigh · max**; gpt-image-2: **low · medium · high** — each priced for that model (low by default). The tiers are named differently across generations: gpt-image-2 `medium` costs what 2.5 `high` does, and gpt-image-2 `high` what 2.5 `max` does. Canvases are 1024x1536 / 1536x1024 / 1024x1024.
- **Retro Diffusion** (optional key) — true pixel art and a dedicated animation endpoint.
- **Local ComfyUI** (optional, free) — pose-conditioned renders via the `local-inference/` service; see `docs/local-inference-setup.md`.

Outputs are post-processed into game-ready assets.

**Spend and prices.** OpenAI spend is booked from the token usage each response reports ($5 text in, $8 image in, $30 image out per 1M tokens), so the header shows what was billed, not a guess. Price labels come from `/api/health`: until a tier has been billed once they show `~# GENVY

A gamified, HUD-based suite of AI-first creation tools for building 2D game content with **Phaser 4**. You forge assets — characters, tilesets, worlds, and eventually sounds, FX, dialogue, quests — into a persistent **collection** on disk, which a later phase assembles into playable games.

The creation process is designed to feel like a game: a sci-fi command center, holographic tool stations, synthesized UI sounds, and loot-drop moments when an asset is forged.

## Stack

- **client/** — Vite + TypeScript + Phaser 4. The workspace is a live Phaser scene; the UI is a futuristic HTML HUD overlay (custom elements, WebAudio-synthesized sfx, Web Animations API).
- **server/** — Node + Fastify. Proxies AI calls (keys never reach the browser), persists the collection to `library/`, and runs the image pipeline (sharp).
- **shared/** — zod schemas for every asset type + typed API contracts, imported by both sides.

, seeded with the exact output cost from OpenAI's calculator formula (1536x1024 low/medium/high/xhigh/max = $0.00474/$0.01029/$0.04116/$0.07377/$0.16464) plus prompt text; after that, the average of real bills.

## Setup

1. `.env` in the repo root (already present, gitignored — `.env.example` lists every option):
   ```
   DEEPSEEK_API_KEY="..."
   OPENAI_API_KEY="..."
   # optional
   RETRODIFFUSION_API_KEY="..."
   OPENAI_IMAGE_MODEL="gpt-image-2.5-flare"     # default model for new images
   OPENAI_EDIT_MODEL="gpt-image-2.5-sunburst"   # default model for reference edits
   ```
   These only set the defaults — every panel's MODEL select overrides them per operation, no restart needed. There is no bare `gpt-image-2.5` model id — always name a variant. Prices and progress timings are tracked per model.
2. `npm install`
3. `npm run dev` — server on :3020, client on http://localhost:5173

Without keys the tools degrade gracefully: AI buttons report LINK OFFLINE, image upload and manual editing still work.

## Tools (Milestone 1 of 6)

| Ready | Tool | What it does |
|---|---|---|
| ✅ | Command Center | Hub, collection drawer, navigation |
| ✅ | Sprite Forge | Prompt → AI concept → AI pose sheet → background removal → slicing → animated character with stats & clips |
| ✅ | World Maker | Theme → AI tileset → tile extraction → paint layers on a live tilemap (brush/erase/fill, collision tags) → AI layout drafts |
| 🔒 | 18 more | NPC Designer, Enemy Forge, Item Smith, Animation Studio, FX Lab, Sound Designer, Music Composer, Dialogue Writer, Quest Architect, UI Kit Builder, Physics Tuner, Camera Director, Cutscene Composer, Parallax Painter, Portrait Studio, Weapon Workshop, Pickup Designer, Game Assembler |

## The collection

Everything you forge is an asset: `library/assets/<type>/<id>.json` + binaries under `library/files/<id>/`, indexed in `library/index.json`. Cross-references are always `{id, type}` pairs — the server validates schema + referential integrity on write and refuses to delete a referenced asset (409) unless forced.

Image pipeline stages are kept on disk (`raw.png` → `keyed.png` → `sheet.png`/`tileset.png` → `thumb.png`) so you can re-run later stages without re-spending image credits.

## Commands

```
npm run dev          # both servers
npm run typecheck    # tsc across all workspaces
npm test             # unit tests: server (library, image pipeline, providers, pricing) + local-inference
npm run smoke:ai -w server   # SPENDS CREDITS: one DeepSeek + one image call through the full pipeline
```

## Manual E2E checklist

1. Boot: open http://localhost:5173, click to initialize → boot sequence types out, hub fades in with 20 stations (18 dimmed "COMING ONLINE").
2. Hover a ready station → ring spins + hover sound; click → camera dolly + transition.
3. Sprite Forge: describe a character → GENERATE CONCEPT fills name/lore/prompt → FORGE POSE SHEET (~1 min) → REMOVE BACKGROUND (tune tolerance) → SLICE INTO FRAMES → live animated preview → SAVE TO COLLECTION → loot-drop chime, card appears in drawer.
4. Reload the page → asset persists in the drawer; clicking it reopens the Sprite Forge with the animated preview.
5. World Maker: describe a theme → GENERATE CONCEPT → FORGE TILESET (saves automatically) → palette appears → NEW BLANK WORLD → paint with brush/fill/erase, right-drag pans, wheel zooms → AI LAYOUT DRAFT → SAVE WORLD.
6. Reload → world reopens with painting intact.
7. Try deleting a tileset referenced by a world via `DELETE /api/assets/:id` → 409 with referrer list.
