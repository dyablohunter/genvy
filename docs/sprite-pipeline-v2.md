# Sprite Pipeline v2 — Plan

Complete overhaul of character/sprite generation, based on the September 2026 research pass
(chongdashu/ai-game-spritesheets methodology, pickbitsai/sprite-generator, aldegad/sprite-gen,
sprite-maker, spriteforge, and the local/API model landscape). Supersedes the current
"concept → 2×2 variants → animation strips" flow in Sprite Forge. The original platform plan
(and what M1 actually shipped vs it) is preserved in `docs/original-plan-m1.md` — v2 builds on
its as-built session model (variants as workspaces; `clips.json`/`concept.json`/`source.json`
auto-persistence; raws never overwritten).

## Guiding principles

1. **Style-agnostic.** Pixel art is ONE style preset, not the pipeline's identity. The same
   stages serve painterly, cartoon, hand-drawn, HD, and pixel styles; only the style contract
   (prompt block) and the post-steps that are style-specific (palette quantization, pixel-grid
   snapping) vary per preset.
2. **Dual providers, one contract.** Every generation step runs against a provider interface
   with two families behind it:
   - **API providers** — user-supplied keys in `.env` (BYO-key, free to the platform).
   - **Local providers** — models running on the user's/our GPU via a separate local
     inference service.
   The platform stays fully open source; the **local inference service is architected as a
   separately deployable, metered service** so it can later become the priced offering
   (clean HTTP contract, job queue, usage accounting from day one — no coupling that would
   force closed-sourcing the platform).
3. **Anchor-first, always.** No animation is ever generated without an accepted neutral
   anchor. Anchors are first-class assets on disk.
4. **Consistency is finished in post, not begged from the model.** The model is asked for
   approximate consistency; deterministic ETL + validation gates deliver the exact result.
5. **Don't generate what you can compute.** Mirroring, idle bobs, and simple loops are
   deterministic transforms, not API calls.
6. **Every credit-spending stage persists its artifacts** (existing rule) so later stages
   re-run free.

Target runtime frame: **256×256 logical** (generated at 1024 "delivered" resolution where the
provider allows, then normalized down).

---

## A. Provider abstraction layer

`server/src/providers/` — one interface, N implementations.

```ts
interface ImageProvider {
  id: string;                     // 'openai', 'retrodiffusion', 'pixellab', 'local-comfy', 'local-qwen-edit'
  capabilities: {
    generate: boolean;            // text → image
    edit: boolean;                // reference image(s) + instruction → image
    multiReference: boolean;      // >1 input image with distinct roles
    nativeAlpha: boolean;         // real transparent background; false ⇒ chroma workflow is mandatory
    animation: boolean;           // purpose-built animation endpoint (Retro Diffusion, PixelLab)
    maxSize: number;
    costEstimate(req): number;    // cents, before spending
  };
  generate(req): Promise<Buffer>;
  edit(req): Promise<Buffer>;
  animate?(req): Promise<Buffer>; // anchor frame + action → sheet
}
```

Selection: per-step configurable defaults (concepts→DeepSeek; anchors/sheets→gpt-image-2;
pixel-style animation→Retro Diffusion when key present; everything→local when enabled) with a
per-request override in the UI. A provider registry reports which providers are LIVE based on
`.env` keys / local service health, so the HUD can show LINK ONLINE/OFFLINE per provider.

**API providers (BYO `.env` keys):**
| Provider | Use | Notes |
|---|---|---|
| OpenAI **gpt-image-2** (never gpt-image-1) | anchors, one-shot idle/attack sheets, edits | native alpha; the chongdashu method is proven on this exact model family |
| Retro Diffusion | pixel-style sprites ≤384px; **animation endpoint** (anchor + action → transparent spritesheet, ~$0.07–0.25) | palette locking, free pixel-fixer endpoint |
| PixelLab | skeleton-based animation, 4/8-direction rotation | ≤128×128 animation cap — small-sprite tier only |
| DeepSeek (existing) | concepts, layouts, prompt sanitize, QA feedback hints | |

**Local providers (the future priced service):**
- `local-inference/` — new workspace or sibling repo: a thin HTTP service (health, job submit,
  progress SSE, result fetch, usage metering) wrapping:
  - **ComfyUI backend** (programmatic workflow submission): SDXL + style LoRAs (nerijs Pixel
    Art XL for pixel preset; other LoRAs per style preset) + **ControlNet OpenPose** (Civitai
    8-direction walk/run pose packs; procedurally rendered skeletons like pickbits'
    `gen-pose-skeletons.js`) + **IP-Adapter** (~0.85 weight) anchored on the neutral anchor +
    low-denoise img2img (0.3–0.5) repair pass. Fits 8GB VRAM; 16GB removes constraints.
  - **Qwen-Image-Edit 2509/2511 GGUF** — local "anchor + instruction → new pose" editor
    (Q4+ at 16GB, Q2/Q3+Lightning at 8GB). Alternative: FLUX.1 Kontext dev fp8 (~12GB;
    avoid nf4+LoRA — pathological perf).
  - **rembg** (isnet-anime / BiRefNet) as ML background-removal fallback for non-chroma styles.
- Server treats it as just another provider; when absent, local options render dimmed.

## B. Style system

`shared/src/schemas/` gains a **StyleContract**: `{ id, name, promptBlock, negativeBlock,
deliveredScale (1|2|4), postSteps: ('quantize'|'pixelSnap'|'despill'|'outlineClean')[],
loraStack? }`. Ship presets: `pixel-16bit`, `pixel-hd`, `painterly`, `cartoon`, `hand-drawn`,
`flat-vector` + user-custom. The concept step writes the chosen style into the character asset;
every downstream prompt interpolates the same contract (lesson from sprite-gen: style text
must defer to the attached reference, never re-describe proportions — one "compact chibi"
default kept bulking a slim base).

## C. The pipeline stages

### C1. Concept (DeepSeek — upgrade existing)
Extend `SPRITE_CONCEPT_SYSTEM` output with: style contract selection, palette roles
(outline/shadow/base/secondary/accent/highlight — sprite-maker's harness), signature-prop list
(so the anchor stage knows what to STRIP), and the animation plan (existing).

### C2. Anchor chain (NEW — the core fix)
1. **Neutral south anchor**: one gpt-image-2 (or local) call producing **4 candidate variants**
   of the canonical neutral idle — facing camera, no weapons/props/effects, flat chroma
   background, "one logical 256×256 frame delivered at 1024". User picks one (existing
   variant-picker UX is reused). Prompt uses:
   - role-annotated inputs ("Image 1 role: … Do not copy its content");
   - "Anchors are boring on purpose" constraints — no glow/particles/aura/action pose;
   - background per provider strategy (see "Background strategy" below).
2. **Anchor lock gate (BLOCKING)**: the pick must pass programmatic checks (full body
   uncropped, single connected component, centered, chroma-clean edges) before anything else
   unlocks. "A weak idle anchor poisons every state."
3. **Neutral reset (conditional)**: if the anchor came back holding an effect/prop, run the
   preserve/change edit ("Change: remove {EFFECT}. Preserve: everything else") instead of
   re-rolling from text.
4. **Directional anchors**: west + north derived from the accepted south anchor via edit
   calls (identity ref = south anchor ONLY — earlier concept images are dropped from inputs).
   **East = horizontal flip of west, computed, never generated.** Left-facing at runtime =
   Phaser `flipX`.
5. Anchors persist as `library/files/<id>/anchor-{south,west,north}.png` + entries in the
   asset JSON; every animation records which anchor it derives from (`{id,type}` refs).
   They slot into the existing session model (variant workspaces, `source.json` linkage,
   raws never overwritten) — the anchor chain extends `concept.json`/`clips.json`, it does
   not replace them.

### C3. Animation generation (per clip, from its directional anchor)
- **Prompt scaffold rewrite** (replaces `animationStripImagePrompt`), combining:
  - role-annotated references (identity anchor + optional layout guide image);
  - **per-frame choreography**: each frame described individually (ready → anticipation →
    action → release → recoil → settle), closing with "Frame N must match frame 1 closely for
    a clean loop" on loops;
  - anchor-lock block: "This sheet owns motion only… prefer a subtler animation over any
    change that mutates identity";
  - NEAR/FAR limb contract for side-view locomotion (FAR limbs 20–30% darker — also
    machine-checkable), "exactly two split stances per cycle, half a cycle apart";
  - named negative failure modes: no merged cells/comic panels, no per-frame recentering, no
    motion arcs/speed lines/afterimages/shadows/detached effects, no background scenery;
  - background per the provider strategy below (chroma prompts add "no chroma-adjacent
    colors in the character").

**Background strategy (per provider — reconciles research vs as-built experience):**
M1 experience showed gpt-image-2's native `background: transparent` beats magenta keying for
our flow (see `docs/original-plan-m1.md`, "What changed since"), while the research repos
found other models ignore "transparent" or fake it. So:
- **Native alpha** is the default for providers with `nativeAlpha: true` (gpt-image-2,
  Retro Diffusion). Validate with the existing `hasTransparency()` check.
- **Chroma workflow** (flat `#FF00FF` or auto-selected key + keying + despill) is MANDATORY
  for providers without real alpha (they draw literal checkerboards) and the automatic
  FALLBACK retry when a native-alpha result comes back with a dirty/absent alpha channel.
- `remove-bg` (flood-fill/chroma) stays for uploads and chroma-route outputs only.
- **Layout guide images** (optional, per provider): pre-rendered slot canvases (and later
  stick-figure motion-phase hints) passed as a layout-role reference.
- **Computed clips first**: idle = 1 generated frame + vertical bob offsets `[0,-2,0,1]`
  (later: anatomy-aware squash/stretch); side-view walk optionally 2-frame lift/plant looped
  1-2-1-2; mirror for the opposite direction. These cost $0.
- **Provider routing**: pixel styles may route walk/idle/attack to Retro Diffusion's
  animation endpoint (anchor in → transparent sheet out); local route uses per-frame OpenPose
  + IP-Adapter batch; default route is gpt-image-2 sheet generation.
- **(Experiment, later)** image-to-video walk cycles: i2v on the directional anchor →
  auto-detect one cycle → pick 8–12 evenly spaced frames ("you will never get walk cycles
  right with image generation alone").

### C4. Validation gates + bounded retry (NEW)
Cheap CPU checks after every generation; regenerate only failures, max ~3 passes, keep the
best candidate ("one repair attempt then publish best" policy):
- **Frame validity**: corners transparent, ≥2% content pixels, largest connected blob ≥70% of
  content (catches two figures per cell), centroid in middle 60%, frame count == requested.
- **Identity drift vs anchor**: RGB histogram chi-squared (threshold ~1.20), NCC ≥0.70 on
  32×32 greys, dHash silhouette similarity.
- **Motion presence**: adjacent-frame silhouette IoU ≤0.92 for locomotion ("else it reads as
  a static pose"); flag near-duplicate frames.
- **Retry with feedback**: failures produce natural-language correction hints injected into
  the regen prompt (sprite-gen's pattern); escalation tiers free → guided → constrained
  (spriteforge). **Anchor cascade recovery**: if most frames of a clip fail identity, assume
  anchor drift — regenerate the anchor, then re-run the clip.
- **(Optional, later)** LLM judge gates (DeepSeek-VL or similar, temp 0, JSON verdicts) for
  identity/temporal/row-coherence when deterministic metrics disagree.

### C5. Normalization ETL (upgrade `imagePipeline.ts`)
Keep: alpha-projection slicing, flood-fill+chroma keying, green-border mode, packing. Add:
- **Auto chroma-key selection** (chroma route only): score magenta/green/cyan/blue against
  the character's own palette; pick the key the subject never approaches (never eats
  eyes/gems).
- **Despill pass** (chroma route only): after keying, neutralize chroma cast on the 1–2px
  edge ring (`excess = min(R,B) − G` style), preserving alpha — kills the fringe flood-fill
  keying leaves.
- **Cross-animation height matching**: measure every clip's frames against the APPROVED
  anchor sheet; rescale so visible body height matches ("attack frames came back smaller —
  common!"). Currently each clip only normalizes against itself.
- **Shared registration**: consistent foot-baseline (bottom-Y of alpha; foot-centroid for
  align-x) and center-x across ALL animations of a character, re-padded onto fixed 256×256
  canvases.
- **Style-conditional post**: pixel presets get palette quantization + pixel-grid snap
  ("pixel unfake": pitch detection → grid-phase snap → block color voting → shared palette);
  non-pixel presets skip these, use lanczos, and may use rembg instead of chroma.
- **Manifest with absolute frame rects** (`frame_layout`) alongside the packed sheet — the
  engine samples rectangles, never guesses a grid. Aligns with Phaser atlas JSON.
- **Verification gate UI**: auto-generated contact sheet + real-size GIF preview per clip;
  the user confirms before SAVE TO COLLECTION promotes the asset.

### C6. Export (later)
Engine exporters beyond Phaser atlas: Aseprite JSON, TexturePacker, Godot SpriteFrames —
spritebrew's `exportEngine` is the reference. Low priority until the Game Assembler milestone.

---

## D. Delivery phases

Status as of 2026-09-05. P1–P5 shipped; several items were deliberately dropped or replaced
once contact with the real providers proved them wrong — those are recorded here rather than
silently deleted, because the reasoning is the useful part.

**P1 — Provider layer + prompt rewrite** ✅ DONE
`ImageProvider` interface + registry (`server/src/providers/`), gpt-image-2 wrapped as the
reference provider, Retro Diffusion added (v2 **async** API: submit → poll `task_id`; it
reports `balance_cost`/`remaining_balance`, so its billing is exact rather than estimated).
StyleContract schema + presets in `shared/`, all image prompts rewritten per E1.
*Dropped:* **Gemini** — it produced magenta/blank frames in testing and was removed entirely.
*Dropped:* chroma-in-prompt as the default — both live providers have native alpha, so the
transparent path is the norm and chroma is a fallback only.

**P2 — Anchor chain** ✅ DONE, and generalized well past the original plan
Variants → pick → blocking lock gate → directional anchors, with per-clip facing. Beyond plan:
a **subject system** (`shared/src/spriteSubjects.ts`, 12 kinds) decides which views exist and
whether they are generated or derived — a gun has no meaningful south view, a coin has one
canonical view. Free views come from `deriveOp(from,to) → {mirror, degrees}`: **a facing is a
turn plus a handedness**, so west is the MIRROR of east, never a 180° rotation (that bug hung
a gun upside down). Pivot placement UI drives rotation about the right point.

**P3 — Validation gates + retry loop** ✅ DONE
`animationGate.ts` (RGB histogram χ², NCC, silhouette dHash + IoU, stride alternation,
leg-swap shading, mirror detection, 100-point score) and `anchorGate.ts`, plus bounded retry
that feeds the gate's hints into the regen prompt, and **targeted per-frame repair**
(`/api/ai/repair-frames`) that redraws only rejected frames into the raw sheet.

**P4 — Normalization v2** ✅ DONE (two items dropped)
Shared foot-baseline + foot-centroid-X registration, cross-clip height matching **referenced
to the anchor** (not the median, so adding a clip never rescales the others), and
style-conditional post-steps (`server/src/services/stylePost.ts`: median-cut quantize with
ONE palette shared across a whole clip/sheet, hard alpha snap, despeckle). The composed master
sheet uses `registerCells`, not `trimAndCenter` — bbox centering silently re-introduced the
jitter registration had removed, in the sheet that actually gets saved and exported.
*Dropped:* auto chroma selection + despill (no chroma provider remains).
*Dropped:* GIF verification gate — the editor's live preview panel already plays every clip at
real size before SAVE, so a GIF would be a worse copy of what the user is already looking at.

**P5 — Computed animation** ✅ DONE (partly reverted)
Free clip derivation (`⇄ MIRROR CLIP` for characters' opposite profile, `⇄ DERIVE TO ALL
VIEWS` for orientation-only subjects) transforms **every rect of every frame**, not the union
box. *Reverted:* computed idle bob — it produced identical frames and was removed on request.

**P6 — Local inference service** 🔨 BUILT, awaiting GPU validation — see `docs/p6-local-inference.md`
Everything testable without a GPU is implemented and green: the `local-inference` workspace
(job queue, /health, SSE progress, usage metering), the **procedural skeleton generator**
(phase-accurate 18-keypoint COCO clips — walk/run/idle/jump/attack × 4 facings — with the
walk cycle's leg-phase contract enforced by vitest), the four parameterized ComfyUI workflow
JSONs (`local-inference/workflows/`, bindings unit-tested), and the `local-comfy` provider
(`costEstimate: () => 0`, health-backed `live`, chroma-keyed to real alpha server-side so
`nativeAlpha` holds). Routing stayed capability-only; the animation gate runs on local output
through the same route; the picker labels the provider FREE. *GPU-validated 2026-09-05* on an
RTX 3050 Ti 4GB at 512px: the round-trip works end to end and pose conditioning demonstrably
drives the output; six tuning rounds (history + pinned values in `local-inference/README.md`)
fixed identity (IP-Adapter linear + subject text), backgrounds (rembg segmentation — prompting
a flat chroma background is inherently unreliable and color names bleed into the palette), and
composition (ControlNet must outrank IP-Adapter). Production quality needs the 16GB tier:
768px + a style LoRA — at 512 on SDXL base, identity and composition cannot both be held.

**P7 — Experiments** (parallel, unscheduled)
i2v walk cycles; LLM judge gates; Scenario custom-style training; PixelLab skeleton animation.
*Done early:* **engine export** — `/api/export/sprite` writes a timestamped bundle under
`library/exports/` (PNG + genvy manifest with absolute frame rects and pivots + a
Phaser/TexturePacker atlas + the neutral anchors + a `.zip` of all of it).
*Tried and removed:* **pixel-grid reconstruction** — detecting a diffusion model's fake
"pixel" cell and rebuilding at native resolution. It has no useful case: gpt-image-2 paints
anti-aliased blobs with no recoverable grid (1% confidence on real art), and Retro Diffusion
is already at native resolution, so reconstruction is a no-op. True pixel art comes from a
provider that draws real pixels, not from post-hoc analysis.

## E. Appendix — implementation reference (session handoff)

Everything below was extracted verbatim or near-verbatim from the research pass so a fresh
session can implement without re-research. Adapt wording to Genvy's voice, keep the mechanics.

### E1. Prompt scaffolds

**Role annotation (prefix every reference image, the load-bearing trick for gpt-image-2-class
models):**
```
Image 1 role: identity anchor. Preserve this exact character identity, detail level, face,
outfit, palette, prop, proportions, silhouette, and sprite scale.
Image 2 role: layout guide. Use it only for frame count, slot spacing, centering, and safe
padding. Do not copy or reproduce its content — no visible boxes, guide lines, or labels
may appear in the output.
```

**Neutral anchor generation** (per style; pixel preset shown — swap the style block per
StyleContract; generate N=4 variants, user picks):
```
Intended use: a single south-facing neutral idle sprite frame for a 2D game. Final artwork
should behave like one logical 256x256 in-game frame, delivered at {OUTPUT_SIZE} so detail
reads cleanly at game scale.

Subject: {NAME}, {ARCHETYPE}, facing SOUTH directly toward the camera. This is the canonical
CANONICAL REFERENCE pose — standing upright at rest, neutral confident stance, arms relaxed,
hands empty. Every identifying feature visible, no motion blur, no dramatic angle.
Proportions, palette, outfit, and silhouette MUST be reproducible — every later animation
frame will be matched against this image.

Frame rules: one character only, centered, full body visible, foot plant at bottom-center,
ample padding on all sides.

Critical constraints: NO weapons, NO held objects, NO glow, particles, smoke, aura,
projectile, or charged action pose. Anchors are neutral on purpose — effects belong in
attack animations only. No scenery, props, borders, UI, text, logo, or watermark.
{BACKGROUND_BLOCK per provider strategy}
```

**Neutral reset (when the anchor came back with an effect/prop) — Preserve/Change
contrastive edit against the flawed anchor:**
```
Primary request: create {N} candidate variants of the same SOUTH-facing neutral idle anchor.
The only intended correction from Image 1 is removing {DYNAMIC_EFFECT}.

Preserve from Image 1: same face readability, same silhouette and proportions, same costume
colors, same prop size/detail, same centered composition, same rendering treatment.
Change from Image 1: remove {DYNAMIC_EFFECT}; remove glow, particles, smoke, aura,
projectile, and charged action pose; make {HAND_OR_BODY_PART} neutral and empty/resting.
Avoid: redesigning the character, simplifying identity details, changing scale or silhouette.
```

**Directional anchor** (identity ref = approved south anchor ONLY; run for west + north;
east = flip of west in code):
```
Image 1 is the approved south-facing identity anchor for {NAME}. Preserve the same character
identity, outfit, palette, proportions, silhouette, accessories, and rendering style.
Create a new {DIRECTION}-facing full-body anchor frame of the same character in a neutral
idle stance. WEST: facing left in profile, both feet visible, body in 3/4 left turn.
NORTH: facing away from the camera (back view), both feet visible.
Accessory placement: keep accessories attached naturally; if a prop is awkward in this view,
reduce its visibility rather than relocating it incorrectly.
Critical: no dynamic effects; this is a neutral anchor for later walk, idle, and attack
generation. {known pitfall: back view tends to center/float props — call out
{DIRECTIONAL_SILHOUETTE_DETAILS} explicitly}
```

**Animation sheet** (from the directional anchor; core blocks to compose):
```
Redraw the EXACT character from the reference image as an animation sheet of exactly
{FRAMES} frames of a "{CATEGORY}" animation, in chronological order.

Anchor lock: the reference image owns character identity, outfit details, colors, face
design, and side-specific accessories. This sheet owns MOTION ONLY. Spend the variation
budget on limb contacts, arm counter-swing, body height, torso lean, head bob, hair bounce,
and loop continuity. Do not redesign or reinterpret identity details while animating.
Prefer a subtler animation over any change that mutates the character identity.

Frame choreography ({example: 8-frame attack}):
Frame 1: neutral ready stance, feet planted, no active effect.
Frame 2: anticipation — attack hand rises, body coils.
Frame 3: small {EFFECT_COLOR} charge appears.
Frame 4: compact {EFFECT} forms, bright but not obscuring body or feet.
Frame 5: release — attack launches toward {DIRECTION}.
Frame 6: follow-through with short trail; character recoils slightly.
Frame 7: recoil peak, residue fades.
Frame 8: return to calm ready stance, no active effect.
{loops end with: "Frame N: match frame 1 closely for a clean loop."}

Layout: exactly {FRAMES} characters total; {COLS}x{ROWS} grid reading left-to-right,
top-to-bottom; every pose entirely inside its own slot with wide gaps; all poses at the
exact same scale as the reference with full body visible; consistent foot baseline.

Negative constraints (named failure modes — keep all):
- never draw two characters side by side within one frame position
- do not merge cells or create comic panels; no visible grid lines, borders, or separators
- do not recenter the character differently per frame
- no motion arcs, speed lines, action streaks, afterimages, blur, or smears
- no cast/contact/drop shadows, floor patches, or landing marks
- no detached effects: floating stars, loose sparkles, disconnected outline bits
- no text, labels, frame numbers, guide marks, UI, or scenery
- do not turn the background into a floor, room, horizon, or environment
```

**Side-view locomotion contract (append for walk/run):**
```
Name limbs by camera depth, never by screen side: the NEAR limb is closer to the camera,
the FAR limb is behind it. The FAR leg and FAR arm render in a visibly darker shade of the
same hue — roughly 20-30% darker — in every frame. Exactly two wide split stances per
cycle, half a cycle apart; a cycle with only one split stance is a hop. Foot separation at
contact extremes is at least 20% of character height. For runs, include two true flight
frames. Do not let a single pose determine every frame's leg phase.
```

**Idle choreography (10-frame reference)**: neutral → slight inhale (shoulders rise a few
px) → hair/cloth settles → tiny facial/cloth movement → slight exhale → hand/accessory sway
→ return toward neutral → opposite cloth sway → settle → match frame 1.

**Style contract lesson**: style text must defer to the attached reference — never
re-describe body type/proportions in the style block (a "compact chibi" style default kept
bulking a slim base in testing). Pixel style block: "match the attached anchor EXACTLY: same
pixel density, body proportions, outline weight, palette, shading style, level of detail.
Do not restyle. Avoid painterly rendering, 3D render, glossy lighting, soft gradients,
anti-aliased high-detail edges."

**i2v walk prompt (P7 experiment)**: animate the directional anchor into "a simple
{DIRECTION}-facing in-place walk cycle… character must face {DIRECTION} the entire clip; no
pivot/quarter-turn; camera fixed and centered; background stays flat (do not turn it into a
floor, room, horizon, or shadow plane); small looping in-place walk, subtle vertical
bobbing, alternating leg steps, minimal arm swing; character does not translate across the
frame." Then: find first neutral-stance frame, scrub to its recurrence (= one cycle), pick
8–12 evenly spaced frames. Pass ONE image only — a guide canvas as second input blends into
i2v output.

### E2. Validation thresholds & retry design

| Check | Method | Threshold |
|---|---|---|
| Frame validity | 4 corners alpha < 30; content pixels ≥ 2%; largest connected blob ≥ 70% of content; centroid inside middle 60% | hard fail |
| Frame count | detected boxes == requested | hard fail |
| Identity: palette | RGB histogram (16 bins/channel = 4096, opaque pixels, 64×64 downsample), chi-squared vs anchor | fail > 1.20 |
| Identity: structure | NCC on 32×32 greyscale thumbs vs anchor | fail < 0.70 |
| Identity: silhouette | dHash similarity vs anchor | fail < 0.55 |
| Motion presence | adjacent-frame silhouette IoU (64×64 binary) for locomotion | fail > 0.92 (reads static) |
| Near-duplicate | adjacent dHash distance | flag < 0.01 |
| Centroid drift | center-of-mass shift between frames | flag > 8 px (at 256) |
| Row score | 100-pt: −(35+10·|Δframes|) wrong count, −13/error, −3/warning, −12 no motion, −10 dhash, −10 histogram | pass ≥ 90 |

Retry loop: max 3 passes per clip, always keep the best-scoring candidate ("one repair
attempt, then publish best"). Escalation tiers: (1) free retry, temp 1.0; (2) guided — inject
gate feedback as correction hints, temp 0.7; (3) constrained — hard positional constraints,
temp 0.3. Correction hints are natural-language and prompt-ready, e.g.: "Frame-to-frame color
identity drift was detected (histogram similarity {x}). Copy the accepted anchor palette,
outfit colors, hair color, face markings, and outline weight in every pose." Anchor cascade:
if ≥ ~50% of a clip's frames fail identity, regenerate the anchor (not the frames), then
re-run the clip against the new anchor.

### E3. ETL algorithms

- **Despill (chroma route)**: after keying, dilate transparency twice (8-connected) to find
  the ≤2px opaque edge ring; for magenta key, `excess = min(R,B) − G`; subtract excess from
  R and B (green key: symmetric with G), alpha untouched. Apply only where luminance ≤ ~90
  to spare bright highlights.
- **Auto chroma-key selection**: sample subject pixels of the anchor (exclude its background
  via border-ring flood fill + edge dilation); for each candidate key (magenta, green, cyan,
  blue) compute the 1st-percentile color distance from subject pixels; pick the max; reject
  keys whose nearest subject pixel falls inside the erase radius.
- **Foot baseline / registration**: baseline = bottom-Y of alpha; align-x = centroid of the
  bottom 20% of alpha (foot-centroid) — more stable than bbox center for kicks/lunges.
  Shared per character across ALL clips: rescale each clip so visible body height matches
  the approved anchor sheet, then paste onto fixed 256×256 with common center-x + foot-y.
- **Frame-box detection cascade** (upgrade of current `detectSpriteCells`): (1) strict
  fully-transparent column gaps ≥5px; (2) smoothed per-column alpha-mass minima near ideal
  split positions (touching frames); (3) even-grid fallback; median-width sanity check
  rejects bad gap splits.
- **Computed clips**: idle bob = base frame + vertical offsets `[0, −2, 0, 1]` (scale to
  frame size); 2-frame side walk (lift/plant) looped 1-2-1-2; left = `flipX` at runtime.
- **Pixel presets only**: pixel-pitch detection (edge-to-gridline scoring + run-length
  crosscheck) → grid-phase snap → dominant-color block voting → shared palette (~48 colors)
  → integer NEAREST upscale. Non-pixel presets: lanczos, optional rembg (isnet-anime /
  BiRefNet) instead of chroma.

### E4. Provider cheat sheet

- **gpt-image-2** (current, `/v1/images/generations` + `/edits`): native alpha via
  `background: 'transparent', output_format: 'png'`; multi-reference edits work with role
  annotations; moderation 422 → sanitize-and-retry (existing).
- **Retro Diffusion** (`POST https://api.retrodiffusion.ai/v1/inferences`, header
  `X-RD-Token`): text→sprite via `prompt` + `prompt_style` (e.g. `rd_pro__default`, 96–256px)
  + `width/height` + `remove_bg` + `reference_images` (rd_pro only); animation via
  `input_image` (base64 anchor, 32–256px) + `prompt_style:
  rd_advanced_animation__<walking|idle|attack|jump|crouch|destroy|custom_action|subtle_motion>`
  + `frames_duration` ∈ {4,6,8,10,12,16}; fallback style `animation__any_animation`. Prices
  ~$0.03–0.18/img, $0.07–0.25/animation; `input_palette` for palette lock; free cost
  estimation + pixel-fixer. Credits don't expire.
- **PixelLab** (pixellab.ai): skeleton-based animation (joint positions → frames), 4/8-dir
  rotation, inpainting; animation capped 128×128 → small-sprite tier only; ~$0.014–0.016/frame.
- **Local ComfyUI stack** (P6): SDXL base or Pixel Art Diffusion XL; nerijs Pixel Art XL
  LoRA (LCM 8 steps, cfg 1.5, strength ~1.2; generate 1024, downscale); IP-Adapter
  (`ip-adapter-plus_sdxl_vit-h` + ViT-H clip vision) weight 0.85, style-transfer mode;
  ControlNet `controlnet-openpose-sdxl-1.0` strength 1.0 with procedurally rendered
  18-keypoint COCO skeletons (SVG→PNG); repair pass = img2img denoise 0.75; KSampler
  dpmpp_2m/karras, 25 steps, cfg 6.0–6.5; render 768×768 for ~12GB VRAM. Negative prompt
  base: "multiple characters, duplicate, text, watermark, frame, border, blurry, cropped,
  extra limbs, missing limbs, bad anatomy, deformed, facing left, facing backwards".
  Anchor editor: Qwen-Image-Edit 2509/2511 GGUF (Q4+ at 16GB, Q2/Q3+Lightning at 8GB) via
  ComfyUI-GGUF; alternative FLUX.1 Kontext dev fp8 (~12GB; never nf4+LoRA — pathological).

### E5. Kickoff prompt for the implementation session

> Read `docs/sprite-pipeline-v2.md` fully (including the appendix) and
> `docs/original-plan-m1.md` ("What changed since" section especially). Then implement
> Phase P1: extract the `ImageProvider` interface, wrap the existing gpt-image-2 code as the
> first provider, add Retro Diffusion as a second provider gated by `.env` keys (see
> `.env.example`), add the `StyleContract` schema + presets to `shared/`, and rewrite the
> image prompts in `server/src/prompts/` using the scaffolds in appendix E1. Keep every
> existing behavior working (variants flow, sessions, moderation retry). gpt-image-2, never
> gpt-image-1. Ask before any credit-spending test; use `npm test` + fixtures otherwise.

## F. Research source map

Cloned references live in the session scratchpad (`ai-game-spritesheets`, `sprite-generator-pickbits`,
`sprite-gen`, `sprite-maker`, `spriteforge`, `spritebrew`, `pixelforge`,
`sprite-generator-dreamhungry`, `manaforge`) — re-clone from GitHub if needed. Key files:
chongdashu `prompts/02-south-anchor.md`, `03-neutral-anchor.md`, `06-attack-spritesheet.md`,
`08-normalization.md`; pickbits `street-fury/references.js`, `verify-consistency.js`,
`verify-walk-cycle.js`, `lib/idle-variants.js`; aldegad `sprite_gen/gen/prepare.py`
(`row_prompt`), `qa/score.py`; sprite-maker `references/biped-locomotion-identity.md`;
spriteforge `prompts/gates.py`, `prompts/retry.py`.
