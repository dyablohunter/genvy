import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  aiConceptSchemas,
  type AiTextRequest,
  type RepairFramesRequest,
  newAssetId,
  getStylePreset,
  getSubject,
} from '@genvy/shared';
import { generateJson, generateText } from '../services/deepseek.js';
import { providerRegistry } from '../providers/index.js';
import type { BackgroundMode } from '../prompts/index.js';
import {
  TOOL_SYSTEM_PROMPTS,
  PROMPT_SANITIZE_SYSTEM,
  variantsImagePrompt,
  animationStripImagePrompt,
  tilesetImagePrompt,
  sceneImagePrompt,
  sceneCutoutEditPrompt,
  sceneModifyEditPrompt,
  neutralAnchorImagePrompt,
  directionalAnchorEditPrompt,
  refineAnchorEditPrompt,
  neutralResetEditPrompt,
  singleFrameImagePrompt,
} from '../prompts/index.js';
import { Library, LibraryError } from '../services/library.js';
import { usage } from '../services/usage.js';
import { activity } from '../services/activity.js';
import * as pipe from '../services/imagePipeline.js';
import { composeStrip } from '../services/sceneStrip.js';
import { gateAnimationFrames, suggestsAnchorCascade } from '../services/animationGate.js';
import type { AnimationGateReport } from '../services/animationGate.js';
import { classifyMotion } from '../prompts/index.js';

const SAFE_NAME = /^[\w.-]+\.png$/;

/** One panel of a strip, as the editor draws it. */
interface SceneModifyPanel {
  /** Library-relative path of the panel's image. */
  file: string;
  flipX?: boolean;
  flipY?: boolean;
}

interface SceneModifyBody {
  assetId: string;
  panel: SceneModifyPanel;
  /** What to change, in the user's words. */
  instruction?: string;
  provider?: string;
  modelFamily?: string;
  quality?: 'low' | 'medium' | 'high';
  renderSize?: number;
  styleId?: string;
  /** Ask the model for alpha output (a cut-out panel for parallax). */
  transparent?: boolean;
  outName?: string;
}

interface AiImageBody {
  prompt: string;
  orientation: 'portrait' | 'landscape' | 'square';
  assetId?: string;
  kind?:
    | 'variants'
    | 'animation'
    | 'tileset'
    | 'scene'
    | 'sceneCutout'
    | 'raw'
    | 'anchor'
    | 'anchorDirectional'
    | 'neutralReset';
  /** For edit kinds: library file ("<assetId>/variant.png") used as the reference. */
  referenceFile?: string;
  category?: string;
  frames?: number;
  gridCols?: number;
  gridRows?: number;
  outName?: string;
  styleHint?: string;
  pose?: string;
  /** Image provider id; default 'openai' (gpt-image-2) — the proven M1 path. */
  provider?: string;
  /** Model family for multi-model providers (the local service); others ignore it. */
  modelFamily?: string;
  /** kind 'animation': appearance text — identity for models with no reference adapter. */
  identityPrompt?: string;
  /** Grid-incapable providers: candidates to render for 'anchor'/'variants' (1-4, default 4). */
  variantCount?: number;
  /** Square render-canvas side for providers with a choosable one (local): speed<->detail dial. */
  renderSize?: number;
  /** Quality tier for providers that price by it (capabilities.qualityLevels). */
  quality?: 'low' | 'medium' | 'high';
  /** StyleContract preset id (shared/src/schemas/styleContract.ts). */
  styleId?: string;
  /** What is being drawn (spriteSubjects.ts); defaults to 'character'. */
  subject?: string;
  /** kind 'anchor'/'anchorDirectional': character name for the prompt. */
  characterName?: string;
  /** anchorDirectional: which anchor to derive; animation: the clip's facing. */
  direction?: 'west' | 'north' | 'south' | 'east';
  /**
   * anchorDirectional: the reference IS the target view — redraw it in place,
   * applying the prompt as corrections (instead of turning the primary anchor
   * into that view).
   */
  refine?: boolean;
  /** kind 'scene': how the level is framed. */
  view?: 'isometric' | 'side' | 'topdown' | 'threequarter';
  /** kind 'scene': the backdrop loops horizontally. */
  seamless?: boolean;
  loop?: 'none' | 'horizontal' | 'vertical';
  /** kind 'neutralReset': the effect/prop to strip from the anchor. */
  effect?: string;
  /** kind 'animation': gate-and-retry attempts (1-3, default 1). */
  attempts?: number;
}

const EDIT_KINDS = new Set(['animation', 'anchorDirectional', 'neutralReset', 'sceneCutout']);

export function registerAiRoutes(app: FastifyInstance, library: Library) {
  app.post<{ Body: AiTextRequest }>('/api/ai/text', async (req) => {
    const { tool, prompt, schemaName, context, temperature } = req.body ?? {};
    if (!tool || !prompt) throw new LibraryError(400, 'Body must include tool and prompt');
    const system = TOOL_SYSTEM_PROMPTS[tool];
    if (!system) throw new LibraryError(400, `Unknown tool: ${tool}`);
    const userPrompt = context
      ? `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`
      : prompt;
    if (schemaName) {
      const schema = aiConceptSchemas[schemaName];
      if (!schema) throw new LibraryError(400, `Unknown schema: ${schemaName}`);
      const result = await generateJson(
        system, userPrompt, schema as import('zod').ZodType<unknown>, temperature,
      );
      return { result };
    }
    const text = await generateText(system, userPrompt, temperature);
    return { result: { text } };
  });

  /**
   * §C4 targeted repair: redraw only the frames the gate rejected and patch
   * them into the clip's raw sheet. Cheaper than a full re-roll and it can't
   * lose poses that were already good.
   */
  app.post<{ Body: RepairFramesRequest }>('/api/ai/repair-frames', async (req) => {
    const b = req.body ?? ({} as RepairFramesRequest);
    if (!b.assetId || !b.rawFile || !b.referenceFile || !b.boxes?.length) {
      throw new LibraryError(400, 'assetId, rawFile, referenceFile and boxes are required');
    }
    const wanted = [...new Set(b.frameIndexes ?? [])].filter((i) => i >= 0 && i < b.boxes.length);
    if (wanted.length === 0) throw new LibraryError(400, 'No valid frameIndexes to repair');

    const provider = providerRegistry.resolve(b.provider);
    if (!provider.capabilities.edit) {
      throw new LibraryError(400, `Provider "${provider.id}" cannot redraw single frames`);
    }
    const style = getStylePreset(b.styleId);
    const background: BackgroundMode = provider.capabilities.nativeAlpha ? 'transparent' : 'chroma';

    const dir = await library.fileDir(b.assetId);
    const rawPath = path.join(dir, path.basename(b.rawFile));
    let sheet = await pipe.loadRaw(await fs.readFile(rawPath).catch(() => {
      throw new LibraryError(404, `Raw sheet not found: ${b.rawFile}`);
    }));
    const reference = await fs.readFile(library.resolveFile(b.referenceFile)).catch(() => {
      throw new LibraryError(404, `Reference file not found: ${b.referenceFile}`);
    });

    const repaired: number[] = [];
    const failed: { index: number; reason: string }[] = [];
    for (const index of wanted) {
      const box = b.boxes[index]!;
      const frameReq = {
        prompt: singleFrameImagePrompt(b.category ?? 'idle', b.boxes.length, index, b.prompt ?? '', {
          styleHint: b.styleHint,
          style,
          background,
          facing: b.direction,
          subject: getSubject(b.subject),
        }),
        orientation: 'portrait' as const,
        transparent: provider.capabilities.nativeAlpha,
        style,
        purpose: 'repair' as const, // local providers route this to img2img, not a re-imagining
        modelFamily: b.modelFamily,
        references: [{ image: reference, role: 'identity' as const }],
        // Reported cost/balance beats our estimate when the provider gives it.
        onBilled: (info: { cents?: number; balanceCents?: number }) => {
          exact = info.cents !== undefined;
          usage.addExact(provider.id, info);
        },
      };
      let exact = false;
      try {
        const png = await provider.edit(frameReq);
        if (!exact) usage.add(provider.id, provider.capabilities.costEstimate(frameReq));

        // Trim to the drawn pose, then scale it to sit inside the frame's slot.
        let pose = await pipe.loadRaw(png);
        if (!pipe.hasTransparency(pose)) pose = pipe.removeBackground(pose, 24, 'both');
        const content = pipe.contentBox(pose);
        if (!content) throw new Error('the redrawn frame came back empty');
        const cut = pipe.extractBoxes(pose, [content])[0]!;
        const scale = Math.min(box.w / cut.width, box.h / cut.height, 4);
        const fitted =
          Math.abs(scale - 1) < 0.01
            ? cut
            : await pipe.resizeCell(
                cut,
                Math.max(1, Math.round(cut.width * scale)),
                Math.max(1, Math.round(cut.height * scale)),
                'nearest',
              );
        sheet = pipe.replaceRegion(sheet, box, fitted);
        repaired.push(index);
      } catch (err) {
        failed.push({ index, reason: (err as Error)?.message ?? 'unknown error' });
        req.log.warn({ index, err }, 'frame repair failed');
      }
    }

    if (repaired.length > 0) await fs.writeFile(rawPath, await pipe.toPng(sheet));
    return {
      repaired,
      failed,
      fileRef: { path: `${b.assetId}/${path.basename(b.rawFile)}`, width: sheet.width, height: sheet.height },
    };
  });

  /** Abort abortable in-flight work (the busy card's red CANCEL). Capability-driven: every provider that CAN cancel is asked to. */
  app.post('/api/ai/cancel', async () => {
    let canceled = false;
    for (const p of providerRegistry.all()) {
      if (p.cancelCurrent && (await p.cancelCurrent())) canceled = true;
    }
    return { canceled };
  });

  app.post<{ Body: AiImageBody }>('/api/ai/image', async (req) => {
    const { orientation, assetId, kind, referenceFile, category, frames, styleHint } =
      req.body ?? {};
    const prompt = req.body?.prompt ?? '';
    // Edit kinds build their whole prompt server-side (choreography, anchor
    // lock, layout); the user text is only supplementary detail there.
    const promptOptional = kind === 'animation' || kind === 'anchorDirectional' || kind === 'neutralReset';
    if (!orientation) throw new LibraryError(400, 'Body must include orientation');
    if (!prompt && !promptOptional) {
      throw new LibraryError(400, `kind "${kind ?? 'raw'}" requires a prompt`);
    }
    const outName = req.body.outName && SAFE_NAME.test(req.body.outName) ? req.body.outName : 'raw.png';

    const provider = providerRegistry.resolve(req.body.provider);
    const style = getStylePreset(req.body.styleId);
    // Background strategy per provider (docs/sprite-pipeline-v2.md §C3): native
    // alpha when the provider truly has it, chroma workflow otherwise — the
    // existing remove-bg pipeline keys chroma-route outputs.
    const rawKinds = new Set(['tileset', 'scene', 'raw', undefined]);
    const wantsAlpha = !rawKinds.has(kind);
    const background: BackgroundMode = provider.capabilities.nativeAlpha ? 'transparent' : 'chroma';
    const transparent = wantsAlpha && provider.capabilities.nativeAlpha;
    const subject = getSubject(req.body.subject);
    const styleOpts = { styleHint, style, background, subject };
    const characterName = req.body.characterName?.trim() || 'the character';

    const isModerated = (err: unknown) => (err as { statusCode?: number }).statusCode === 422;

    // Server-truth progress: the HUD polls /api/ai/activity and follows this
    // record instead of guessing — retries, candidates and the local
    // service's per-frame stages all land here.
    // Name the WORK, not just "drawing" — this label overwrites the client's
    // own text, so a vague one hides which operation is spending.
    const WORK: Record<string, string> = {
      animation: `GENERATING ${(category ?? 'idle').toUpperCase()} (${frames ?? 4} FRAMES)`,
      anchor: 'DRAWING ANCHOR CANDIDATES',
      variants: 'DRAWING VARIANTS',
      anchorDirectional: `TURNING THE ANCHOR${req.body.direction ? ` INTO ${req.body.direction.toUpperCase()}` : ''}`,
      neutralReset: 'STRIPPING PROPS & EFFECTS',
      tileset: 'DRAWING THE TILE GRID',
      scene: 'PAINTING THE SCENE',
    };
    activity.begin(`${provider.name.toUpperCase()} · ${WORK[kind ?? 'raw'] ?? 'DRAWING'}...`);
    try {
    let png: Buffer;
    let attemptsUsed = 0;
    let gateReport: AnimationGateReport | undefined;
    /**
     * Bill per attempted call, priced from the REQUEST that was actually made
     * (an animation endpoint costs far more than a sheet edit). Failures count
     * too: providers charge for jobs they start, so a timed-out render is real
     * money — reporting less would understate the spend.
     */
    let reportedExact = false;
    /** Providers that report real figures win; otherwise we book the estimate. */
    const onBilled = (info: { cents?: number; balanceCents?: number }) => {
      if (info.cents !== undefined) reportedExact = true;
      usage.addExact(provider.id, info);
    };
    const bill = (r: Parameters<typeof provider.capabilities.costEstimate>[0]) => {
      if (reportedExact) {
        reportedExact = false; // consumed: the next call books itself again
        return;
      }
      usage.add(provider.id, provider.capabilities.costEstimate(r));
    };
    /**
     * Bill unless the provider refused on content policy: a moderation
     * rejection happens BEFORE any image is rendered, so nothing is charged —
     * booking it would overstate the spend readout.
     */
    const billUnlessModerated = (
      r: Parameters<typeof provider.capabilities.costEstimate>[0],
      err: unknown,
    ) => {
      if (!isModerated(err)) bill(r);
    };
    if (kind && EDIT_KINDS.has(kind)) {
      if (!referenceFile) throw new LibraryError(400, `kind "${kind}" requires referenceFile`);
      const refAbs = library.resolveFile(referenceFile);
      let ref: Buffer;
      try {
        ref = await fs.readFile(refAbs);
      } catch {
        throw new LibraryError(404, `Reference file not found: ${referenceFile}`);
      }
      const buildEdit = (notes: string) => {
        if (kind === 'anchorDirectional') {
          const { direction } = req.body;
          if (!direction) {
            throw new LibraryError(400, 'kind "anchorDirectional" requires a direction');
          }
          return req.body.refine
            ? refineAnchorEditPrompt(characterName, direction, notes.trim() || undefined, styleOpts)
            : directionalAnchorEditPrompt(characterName, direction, notes.trim() || undefined, styleOpts);
        }
        if (kind === 'sceneCutout') {
          // A cutout keeps the art it is given; the notes say what counts as
          // foreground when the default guess is wrong.
          return sceneCutoutEditPrompt(notes);
        }
        if (kind === 'neutralReset') {
          return neutralResetEditPrompt(
            req.body.effect?.trim() || 'any held props, weapons, glows, particles, or effects',
            undefined,
            undefined,
            subject,
          );
        }
        return animationStripImagePrompt(category ?? 'idle', frames ?? 4, notes, {
          ...styleOpts,
          gridCols: req.body.gridCols,
          gridRows: req.body.gridRows,
          facing: req.body.direction,
        });
      };
      const runEdit = async (notes: string, hints: string[] = []) => {
        const hintBlock =
          hints.length > 0
            ? `\n\nCorrections from the previous attempt (these MUST be fixed):\n- ${hints.join('\n- ')}`
            : '';
        const editReq = {
          prompt: buildEdit(notes) + hintBlock,
          orientation,
          transparent: provider.capabilities.nativeAlpha,
          style,
          modelFamily: req.body.modelFamily,
          quality: req.body.quality,
          renderSize: req.body.renderSize,
          references: [{ image: ref, role: 'identity' as const }],
          onBilled,
        };
        try {
          const out = await provider.edit(editReq);
          bill(editReq);
          return out;
        } catch (err) {
          billUnlessModerated(editReq, err);
          throw err;
        }
      };
      /**
       * Providers with a purpose-built animation endpoint (Retro Diffusion)
       * take the anchor + an action instead of a drawn-sheet instruction —
       * their edit() has no meaning here (docs §C3 provider routing).
       */
      const useAnimate = kind === 'animation' && provider.capabilities.animation && !!provider.animate;
      /**
       * Independent-frame strips (local): every frame rendered its figure at
       * its own scale on a full canvas. Equalize heights to the median, run
       * the approved foot-baseline registration, and repack tight — so the
       * gate, the review boxes and the saved raw all see coherent geometry.
       */
      const normalizeIndependentStrip = async (sheetPng: Buffer): Promise<Buffer> => {
        try {
          let raw = await pipe.loadRaw(sheetPng);
          if (!pipe.hasTransparency(raw)) raw = pipe.removeBackground(raw, 24, 'both');
          const cells = pipe.extractBoxes(
            raw,
            pipe.detectSpriteCells(raw, { expected: frames ?? 4 }),
          );
          if (cells.length === 0) return sheetPng;
          const packed = pipe.packCells(
            pipe.registerCells(await pipe.equalizeCellHeights(cells)),
            cells.length,
          );
          return await pipe.toPng(packed);
        } catch (err) {
          req.log.warn({ err }, 'strip normalization failed — keeping the raw strip');
          return sheetPng;
        }
      };
      const runOnce = async (notes: string, hints: string[] = []) => {
        if (!useAnimate) return runEdit(notes, hints);
        const animateReq = {
          anchor: ref,
          action: category ?? 'idle',
          frames: frames ?? 4,
          facing: req.body.direction,
          prompt: [notes.trim(), ...hints].filter(Boolean).join(' '),
          identityPrompt: req.body.identityPrompt,
          style,
          modelFamily: req.body.modelFamily,
          quality: req.body.quality,
          renderSize: req.body.renderSize,
          onBilled,
        };
        try {
          let out = await provider.animate!(animateReq);
          bill(animateReq);
          if (provider.capabilities.independentFrames) out = await normalizeIndependentStrip(out);
          return out;
        } catch (err) {
          billUnlessModerated(animateReq, err);
          throw err;
        }
      };
      const runAttempt = async (hints: string[]) => {
        try {
          return await runOnce(prompt, hints);
        } catch (err) {
          if (!isModerated(err) || kind !== 'animation' || prompt.trim().length === 0) throw err;
          req.log.warn({ prompt }, 'image moderation rejection — sanitizing motion notes and retrying');
          const cleaned = await generateText(PROMPT_SANITIZE_SYSTEM, prompt);
          return runOnce(cleaned, hints);
        }
      };

      if (kind === 'animation') {
        // §C4 bounded retry: score each sheet against the anchor, feed the
        // gate's hints into the regen prompt, keep the best candidate.
        const maxAttempts = Math.min(Math.max(req.body.attempts ?? 1, 1), 3);
        const expectedFrames = frames ?? 4;
        const locomotion = classifyMotion(category ?? 'idle').kind === 'locomotion';
        const anchorRaw = await pipe.loadRaw(ref).catch(() => null);
        const gateSheet = async (sheetPng: Buffer): Promise<AnimationGateReport | undefined> => {
          if (!anchorRaw) return undefined;
          try {
            let raw = await pipe.loadRaw(sheetPng);
            if (!pipe.hasTransparency(raw)) raw = pipe.removeBackground(raw, 24, 'both');
            const cells = pipe.extractBoxes(
              raw,
              pipe.detectSpriteCells(raw, { expected: expectedFrames }),
            );
            return gateAnimationFrames(cells, anchorRaw, { expectedFrames, locomotion });
          } catch (err) {
            req.log.warn({ err }, 'animation gate failed — accepting the sheet ungated');
            return undefined;
          }
        };
        let best: { png: Buffer; gate?: AnimationGateReport; score: number } | null = null;
        let hints: string[] = [];
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          // The retry is named in the label the moment it starts — no more
          // guessing why the bar is still going.
          if (attempt > 0) {
            activity.update({
              label: `GATE FLAGGED THE SHEET — RETRYING (ATTEMPT ${attempt + 1}/${maxAttempts})...`,
            });
          }
          const candidate = await runAttempt(hints);
          attemptsUsed++;
          activity.update({ label: 'SCORING AGAINST THE ANCHOR — ANIMATION GATE (FREE)...' });
          const gate = await gateSheet(candidate);
          if (gate) {
            req.log.info(
              {
                attempt: attempt + 1,
                score: gate.score,
                pass: gate.pass,
                frames: `${gate.frameCount}/${gate.expectedFrames}`,
                perFrame: gate.frames.map((f) => ({
                  i: f.index,
                  errors: f.errors,
                  warnings: f.warnings,
                })),
                staticPairs: gate.staticPairs,
                hints: gate.hints,
              },
              'animation gate report',
            );
          }
          const score = gate?.score ?? 101; // ungateable -> accept as-is
          if (!best || score > best.score) best = { png: candidate, gate, score };
          if (!gate || gate.pass) break;
          hints = gate.hints;
        }
        png = best!.png;
        gateReport = best!.gate;
      } else {
        png = await runAttempt([]);
      }
    } else {
      // Grid-incapable providers (capability, not id): variants/anchor
      // candidates are rendered ONE figure at a time and composed into the
      // 2x2 the client expects — SDXL draws "2x2 grid" instructions as
      // noise, and a 512px grid gives each candidate a sub-viable 256px.
      const composeGrid =
        (kind === 'variants' || kind === 'anchor') && !provider.capabilities.gridSheets;
      const build = (p: string) =>
        kind === 'variants'
          ? variantsImagePrompt(p, { ...styleOpts, pose: req.body.pose, single: composeGrid })
          : kind === 'anchor'
            ? neutralAnchorImagePrompt(characterName, p, { ...styleOpts, single: composeGrid })
            : kind === 'tileset'
              ? tilesetImagePrompt(p)
              : kind === 'scene'
                ? sceneImagePrompt(p, {
                    ...styleOpts,
                    view: req.body.view,
                    loop: req.body.loop ?? (req.body.seamless ? 'horizontal' : 'none'),
                  })
                : p;
      const runGenerate = async (p: string) => {
        const genReq = {
          prompt: build(p),
          orientation,
          transparent,
          style,
          modelFamily: req.body.modelFamily,
          quality: req.body.quality,
          renderSize: req.body.renderSize,
          onBilled,
        };
        try {
          const out = await provider.generate(genReq);
          bill(genReq);
          return out;
        } catch (err) {
          billUnlessModerated(genReq, err);
          throw err;
        }
      };
      // Sanitize once on the first moderation rejection; later candidate
      // renders reuse the cleaned prompt instead of re-tripping moderation.
      let effective = prompt;
      const generateOnce = async (): Promise<Buffer> => {
        try {
          return await runGenerate(effective);
        } catch (err) {
          if (!isModerated(err)) throw err;
          req.log.warn({ prompt: effective }, 'image moderation rejection — sanitizing prompt and retrying');
          effective = await generateText(PROMPT_SANITIZE_SYSTEM, effective);
          return runGenerate(effective);
        }
      };
      if (composeGrid) {
        // The user picks how many candidates a grid-incapable provider
        // renders (each is a full generation, so fewer = proportionally
        // faster). The picker downstream handles any count.
        const count = Math.min(Math.max(Math.round(req.body.variantCount ?? 4), 1), 4);
        const cells: pipe.RawImage[] = [];
        for (let i = 0; i < count; i++) {
          activity.update({
            label: `${provider.name.toUpperCase()} · CANDIDATE ${i + 1} OF ${count}...`,
            step: i + 1,
            steps: count,
          });
          cells.push(await pipe.loadRaw(await generateOnce()));
        }
        if (count === 1) {
          png = await pipe.toPng(cells[0]!);
        } else {
          activity.update({ label: 'COMPOSING THE CANDIDATE GRID (FREE)...', step: count, steps: count });
          png = await pipe.toPng(pipe.packCells(cells, count <= 2 ? count : 2));
        }
      } else {
        png = await generateOnce();
      }
    }

    const id = assetId && assetId.length > 0 ? assetId : newAssetId('spritesheet');
    const dir = await library.fileDir(id);
    await fs.writeFile(path.join(dir, outName), png);
    const meta = await sharp(png).metadata();
    return {
      fileRef: { path: `${id}/${outName}`, width: meta.width, height: meta.height },
      assetId: id,
      ...(gateReport
        ? {
            attemptsUsed,
            gate: {
              score: gateReport.score,
              pass: gateReport.pass,
              frameCount: gateReport.frameCount,
              expectedFrames: gateReport.expectedFrames,
              failedFrames: gateReport.failedFrames,
              hints: gateReport.hints,
              anchorCascade: suggestsAnchorCascade(gateReport),
            },
          }
        : {}),
    };
    } finally {
      activity.end();
    }
  });

  /**
   * Modify ONE scene panel: the panel as drawn (mirroring applied) goes to
   * the model with the instruction, and the result comes back resampled to
   * the panel's own size. Multi-panel merges and directional extensions used
   * to live here — dropped: the model renders a fixed canvas whatever it is
   * shown, so stitching sections bought seams without buying resolution.
   */
  app.post<{ Body: SceneModifyBody }>('/api/ai/scene-modify', async (req) => {
    const b = req.body ?? ({} as SceneModifyBody);
    if (!b.assetId || !b.panel?.file) {
      throw new LibraryError(400, 'assetId and panel are required');
    }
    const provider = providerRegistry.resolve(b.provider);
    if (!provider.capabilities.edit) {
      throw new LibraryError(400, `${provider.name} cannot edit images — pick another provider`);
    }
    const style = getStylePreset(b.styleId);

    // What the user is looking at, in bytes: the panel mirrored as drawn.
    const raw = await pipe.loadRaw(await fs.readFile(library.resolveFile(b.panel.file)));
    const source = composeStrip(
      [{ ...raw, flipX: b.panel.flipX === true, flipY: b.panel.flipY === true }],
      'horizontal',
    );

    activity.begin(`${provider.name.toUpperCase()} · MODIFYING THE PANEL...`);
    let reportedExact = false;
    const onBilled = (info: { cents?: number; balanceCents?: number }) => {
      if (info.cents !== undefined) reportedExact = true;
      usage.addExact(provider.id, info);
    };
    try {
      const editReq = {
        prompt: sceneModifyEditPrompt(b.instruction ?? ''),
        orientation:
          source.width > source.height
            ? ('landscape' as const)
            : source.height > source.width
              ? ('portrait' as const)
              : ('square' as const),
        // Only when ASKED. A scene is full-bleed artwork; forcing alpha here
        // once overrode "make the background red" with a cut-out.
        transparent: b.transparent === true && provider.capabilities.nativeAlpha,
        style,
        modelFamily: b.modelFamily,
        quality: b.quality,
        renderSize: b.renderSize,
        references: [{ image: await pipe.toPng(source), role: 'identity' as const }],
        onBilled,
      };
      const out = await provider.edit(editReq);
      if (!reportedExact) usage.add(provider.id, provider.capabilities.costEstimate(editReq));

      // Back to the panel's own size: the model renders its own canvas
      // whatever it was shown, and a panel that came back bigger than its
      // neighbours visibly stepped the strip.
      let result = await pipe.loadRaw(out);
      if (result.width !== source.width || result.height !== source.height) {
        result = await pipe.loadRaw(
          await sharp(result.data, {
            raw: { width: result.width, height: result.height, channels: 4 },
          })
            .resize(source.width, source.height, { fit: 'fill' })
            .png()
            .toBuffer(),
        );
      }
      const png = await pipe.toPng(result);
      const dir = await library.fileDir(b.assetId);
      const outName =
        b.outName && SAFE_NAME.test(b.outName) ? b.outName : `mod_${Date.now().toString(36)}.png`;
      await fs.writeFile(path.join(dir, outName), png);
      return {
        fileRef: { path: `${b.assetId}/${outName}`, width: result.width, height: result.height },
      };
    } finally {
      activity.end();
    }
  });
}
