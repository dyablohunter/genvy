import type { ImageOrientation, Scene, SceneLoop, SceneView } from '@genvy/shared';
import { HudShell } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { api } from '../../api/client.js';
import { collection } from '../../state/collection.js';
import { ProviderControls } from '../../hud/providerControls.js';
import { field, textArea, autoGrow, GenvyButton } from '../../hud/components.js';
import { saveDraft, loadDraft, clearDraft } from '../../state/drafts.js';

/**
 * Scene Forge — one painted level backdrop from one prompt.
 *
 * This is the OTHER way 2D levels get built: not a tilemap, but a single
 * illustration the camera pans across (isometric builders, hand-painted
 * platformers, adventure backgrounds). It shares the Sprite Forge's provider
 * controls, cost preview and progress contract, and saves a first-class
 * `scene` asset with its prompt so it can be re-forged later.
 */

export interface ScenePanelHooks {
  /** Show the finished art on the tool's stage. */
  display: (scene: Scene) => void | Promise<void>;
  /**
   * The scene currently open on the stage, if any. Re-painting while one is
   * open REPLACES its artwork instead of leaving a trail of near-identical
   * assets in the inventory — the session owns one scene at a time.
   */
  current: () => Scene | null;
  /** Run work behind the shared busy indicator. */
  busy: (
    label: string,
    fn: () => Promise<unknown>,
    timing?: { key: string; fallbackMs: number },
  ) => Promise<void>;
}

const VIEWS: { id: SceneView; label: string }[] = [
  { id: 'side', label: 'SIDE VIEW (PLATFORMER)' },
  { id: 'isometric', label: 'ISOMETRIC' },
  { id: 'threequarter', label: '3/4 OVERHEAD (JRPG)' },
  { id: 'topdown', label: 'TOP-DOWN' },
];

/**
 * The canvas a view actually wants. A side-scroller's camera travels along
 * one axis, so a wide canvas is all level; an isometric or overhead map is
 * walked in both axes, and a 3:2 strip of one is half a map.
 */
const VIEW_ORIENTATION: Record<SceneView, 'landscape' | 'square'> = {
  side: 'landscape',
  isometric: 'square',
  threequarter: 'square',
  topdown: 'square',
};

export function buildScenePanel(hooks: ScenePanelHooks) {
  const panel = HudShell.makePanel('03 · SCENE', 'left');
  const prompt = autoGrow(
    textArea('', 'e.g. a flooded neon arcade at night, walkways over black water, broken signage'),
  );

  const viewSel = document.createElement('select');
  for (const v of VIEWS) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    viewSel.appendChild(opt);
  }
  // Looping backdrops are the norm for side-scrollers, so the option is
  // offered rather than assumed.
  const loopSel = document.createElement('select');
  for (const [value, label] of [
    ['none', 'SINGLE SCREEN'],
    ['horizontal', 'LOOPS HORIZONTALLY'],
    ['vertical', 'LOOPS VERTICALLY'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    loopSel.appendChild(opt);
  }

  const controls = new ProviderControls({
    workflow: 'anchor-generate',
    candidates: false,
    // A level backdrop needs room. Retro Diffusion tops out at 384px, which
    // is a fine sprite and an unusable scene, so it is not offered here.
    eligible: (p) => p.capabilities.generate && p.capabilities.maxSize >= 512,
  });

  /**
   * Canvas shape, as three rectangles. The view sets a sensible default, but
   * it is only a default: a vertical level (a tower, a descent, a shaft) is a
   * real thing to want, and the model can only give one if it is asked for a
   * tall canvas.
   */
  let orientation: ImageOrientation = 'landscape';
  const orientRow = document.createElement('div');
  orientRow.className = 'g-icon-row';
  const orientButtons = new Map<ImageOrientation, GenvyButton>();
  for (const [id, icon, hint] of [
    ['landscape', '▭', 'LANDSCAPE — the camera travels sideways'],
    ['portrait', '▯', 'PORTRAIT — a tall level: a tower, a shaft, a descent'],
    ['square', '□', 'SQUARE — walked in both axes, as in top-down and isometric maps'],
  ] as const) {
    const btn = document.createElement('genvy-button') as GenvyButton;
    btn.classList.add('g-icon');
    btn.setAttribute('label', icon);
    btn.title = hint;
    btn.onClick(() => {
      UISound.play('click');
      setOrientation(id);
      HudShell.toast(hint.replace(' — ', ' · ').toUpperCase());
    });
    orientButtons.set(id, btn);
    orientRow.appendChild(btn);
  }


  function setOrientation(next: ImageOrientation) {
    orientation = next;
    for (const [id, btn] of orientButtons) {
      btn.setAttribute('variant', id === next ? 'accent' : '');
    }
    // A square costs less than a wide or tall render, so the price the button
    // shows has to follow the canvas the button will actually ask for.
    controls.setCanvas(next);
  }

  /**
   * A looping backdrop is a SIDE-SCROLLER idea: the camera pans along one
   * axis and the art repeats. An isometric or overhead map has no such seam —
   * its grid does not wrap at the image edge — so offering the option there
   * only produces art built around a seam that will never be used.
   */
  function syncFraming(viewChanged = false) {
    const sideOn = viewSel.value === 'side';
    // A view change re-proposes that view's canvas; the buttons then override.
    if (viewChanged) setOrientation(VIEW_ORIENTATION[viewSel.value as SceneView]);
    loopSel.disabled = !sideOn;
    if (!sideOn) loopSel.value = 'none';
    loopField.title = sideOn
      ? 'Looping backdrops are the norm for side-scrollers'
      : 'ONLY SIDE VIEW LOOPS — AN ISOMETRIC OR OVERHEAD MAP HAS NO SEAM TO REPEAT';
    loopField.style.opacity = sideOn ? '1' : '0.5';
  }
  viewSel.addEventListener('change', () => syncFraming(true));
  // A tower loops top-to-bottom, so it wants a tall canvas; a run loops
  // left-to-right and wants a wide one.
  loopSel.addEventListener('change', () => {
    if (loopSel.value === 'vertical') setOrientation('portrait');
    else if (loopSel.value === 'horizontal') setOrientation('landscape');
  });

  const forgeBtn = document.createElement('genvy-button') as GenvyButton;
  forgeBtn.setAttribute('variant', 'accent');
  forgeBtn.setAttribute('label', 'PAINT THE SCENE');


  function refresh() {
    const open = hooks.current();
    const cost = controls.costPreview();
    const verb = open ? 'REPAINT' : 'PAINT THE SCENE';
    forgeBtn.setLabel(`${verb}${cost ? ` ${cost}` : ''}`);
    if (open && !prompt.value.trim()) {
      prompt.value = open.prompt;
      autoGrow.refresh(prompt);
    }
    for (const opt of Array.from(viewSel.options)) {
      if (open && opt.value === open.view) viewSel.value = open.view;
    }
    if (open) loopSel.value = open.loop ?? 'none';
    syncFraming();
  }
  controls.onChange = () => refresh();

  const hint = document.createElement('div');
  hint.className = 'g-hint';
  hint.textContent =
    'A SCENE IS THE LEVEL ARTWORK ITSELF — NO CHARACTERS, FULL BLEED, ONE LIGHT DIRECTION. ' +
    'THE GAME PLACES ACTORS ON TOP.';

  const rowLeft = document.createElement('div');
  rowLeft.style.display = 'flex';
  rowLeft.style.gap = '8px';
  const viewField = field('VIEW', viewSel);
  const loopField = field('FRAMING', loopSel);
  for (const f of [viewField, loopField]) {
    f.style.flex = '1 1 50%';
    f.style.minWidth = '0';
  }
  rowLeft.append(viewField, loopField);
  const orientField = field('CANVAS', orientRow);

  // Pre-forge text has no asset behind it: a refresh used to take the whole
  // description with it. Draft on every keystroke, restore on entry, and
  // clear once a painted scene owns the words on disk.
  const saveSceneDraft = () => {
    saveDraft('world:scene-concept', {
      prompt: prompt.value,
      view: viewSel.value,
      loop: loopSel.value,
      orientation,
    });
  };
  prompt.addEventListener('input', saveSceneDraft);
  for (const sel of [viewSel, loopSel]) sel.addEventListener('change', saveSceneDraft);

  const restoreSceneDraft = () => {
    const draft = loadDraft<{
      prompt: string;
      view: string;
      loop: string;
      orientation: ImageOrientation;
    }>('world:scene-concept');
    if (!draft?.data.prompt) return;
    const d = draft.data;
    prompt.value = d.prompt;
    if (d.view) viewSel.value = d.view;
    if (d.loop) loopSel.value = d.loop;
    if (d.orientation) setOrientation(d.orientation);
    autoGrow.refresh(prompt);
    syncFraming();
  };

  panel.append(
    field('DESCRIBE THE SCENE', prompt),
    rowLeft,
    orientField,
    ...controls.elements(),
    forgeBtn,
    hint,
  );
  setOrientation(VIEW_ORIENTATION[viewSel.value as SceneView]);
  refresh();
  restoreSceneDraft();

  forgeBtn.onClick(async () => {
    if (!prompt.value.trim()) return HudShell.toast('DESCRIBE THE SCENE FIRST', 'error');
    const blocked = controls.blockedReason();
    if (blocked) return HudShell.toast(blocked, 'error');
    const view = viewSel.value as SceneView;
    const loop = loopSel.value as SceneLoop;
    const open = hooks.current();

    await hooks.busy(
      'PAINTING THE SCENE...',
      async () => {
        UISound.play('generate');
        HudShell.setBusyLabel(`${controls.tag()} · PAINTING THE ${view.toUpperCase()} SCENE...`);
        const img = await api.aiImage({
          prompt: prompt.value.trim(),
          orientation,
          kind: 'scene',
          view,
          loop,
          // Re-painting an open scene writes into ITS file directory, so the
          // artwork and the asset never live in two different folders.
          assetId: open?.id,
          provider: controls.providerId(),
          modelFamily: controls.modelFamily(),
          renderSize: controls.renderSize(),
          quality: controls.quality(),
        });
        HudShell.setBusyLabel(
          open
            ? 'UPDATING THE SCENE IN THE COLLECTION (FREE)...'
            : 'WRITING THE SCENE TO THE COLLECTION (FREE)...',
        );
        const body = {
          name: open?.name ?? prompt.value.trim().slice(0, 48),
          description: prompt.value.trim(),
          tags: ['scene', view],
          image: img.fileRef,
          sourceImage: img.fileRef,
          view,
          loop,
          // A re-paint replaces the artwork, so the old strip's panels no
          // longer describe it; the new render becomes panel one.
          segments: [],
          prompt: prompt.value.trim(),
          width: img.fileRef.width ?? 0,
          height: img.fileRef.height ?? 0,
          // A mask painted against the old artwork does not describe the new
          // one, so a re-paint drops it rather than leaving wrong collision.
          layers: open?.layers ?? [],
        };
        const saved = open
          ? await api.updateAsset<Scene>(open.id, { ...open, ...body, mask: undefined })
          : await api.createAsset<Scene>('scene', { id: img.assetId, ...body });
        clearDraft('world:scene-concept');
        await hooks.display(saved);
        await collection.refresh();
        await HudShell.lootDrop();
        UISound.play('complete');
        HudShell.toast(open ? 'SCENE REPAINTED' : 'SCENE PAINTED & SAVED', 'success');
      },
      {
        key: `scene:${controls.providerId() ?? 'openai'}:${controls.renderSize() ?? 'std'}`,
        fallbackMs: 45000,
      },
    );
  });

  return { panel, controls, refresh };
}
