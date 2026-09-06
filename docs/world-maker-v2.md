# World Maker v2 — plan

Status: **starting.** The sprite pipeline (P1–P6) is shipped and GPU-validated;
this applies its lessons to tilesets and levels instead of rediscovering them.

## What World Maker is today (M1)

One `gpt-image-2` call draws a **4×6 grid of 24 tiles** from a DeepSeek-planned
subject list; the grid is cut into tiles, saved as a `tileset` asset, and
painted onto a Phaser tilemap that saves as a `world`. It works, and it has
exactly the failure modes the sprite pipeline already diagnosed.

## The lessons that transfer, and what they imply here

| Sprite lesson (hard-won) | What it means for tiles |
| --- | --- |
| **Grid asks fail on most models.** "Draw a 2x2 grid" returned noise from SDXL/Z-Image; only instruction-following models lay out grids. | A 4×6 tile grid is the same ask. Grid-incapable providers must render **one tile per call** and let the server compose the sheet — which also makes per-tile re-rolls possible. |
| **Anchor-first.** Identity is locked by an accepted reference, not by re-describing the character. | A tileset needs a **base tile** (the style anchor): one approved terrain tile that every other tile is drawn *against*, so 24 tiles read as one set instead of 24 separate pictures. |
| **Conditioning beats guessing.** Procedural skeletons fixed motion where prompt-and-hope could not. | **Procedural tile masks** (wang/blob edge masks) condition transition tiles, so grass→dirt corners land where the tilemap needs them instead of wherever the model felt like. |
| **Gates detect what prompts cannot guarantee.** | A **tileGate**: wrap-seam continuity, palette cohesion across the set, edge-to-edge fill, grid-line contamination, duplicate tiles — with hints fed back into retries. |
| **Deterministic code owns geometry.** Registration, packing and palettes are not the model's job. | Seam repair, ONE palette across the whole set (`stylePost` already does this), nearest-neighbor downscale to the true tile size. |
| **Free transforms beat paid ones.** West is a mirror of east. | A corner tile rotated 90° gives the other three corners; edges mirror. Deterministic, instant, $0. |
| **Capability routing + honest UI.** Never silently substitute a paid provider; show cost, progress, cancel. | The world panel gets the same provider/model/size/quality/candidates controls and the same guards the sprite forge now has. |

## Delivery phases

**W1 — Tile gate (deterministic, no GPU)** ← *starting here*
`tileGate.ts` scores a cut tileset the way `animationGate` scores a clip:
per-tile wrap-seam continuity, set-wide palette cohesion, fill, grid-line
contamination, duplicates. Provider-agnostic — it runs on gpt-image-2 output
and local output alike, and its hints drive bounded retry.

**W2 — Tile chain (the anchor chain, for terrain)**
Base tile candidates → user picks → every other tile is an edit against it →
per-tile re-roll with history → free rotate/mirror derivations for corners and
edges. Grid-incapable providers get server-side composition (the `gridSheets`
capability already exists).

**W3 — Seamlessness by construction**
Procedural wang/blob masks rendered as conditioning images (the skeleton
generator's sibling), plus the offset-render trick: draw at 3×3 tiled context
and crop the centre so the seams are inside the render, not at its edges.

**W4 — Painting UX**
Autotiling (paint terrain; transitions resolve themselves), collision flags
from the concept, object layers with real asset refs from the collection.

**W5 — Export**
Tiled-compatible `.tmx`/`.tsx` beside the genvy manifest, in the same bundle
discipline as `/api/export/sprite`.

## Constraints carried over

- The app must work with local inference absent, and with no API keys at all.
- Nothing branches on provider id — only on capabilities.
- Every AI call obeys the progress-feedback contract (determinate bar, real
  server-driven stages, FREE labelling, cancel).
- Deterministic post-processing is never the model's job.
