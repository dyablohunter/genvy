import type { Scene, SceneView } from '@genvy/shared';
import { HudShell } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { api } from '../../api/client.js';
import { collection } from '../../state/collection.js';
import { ProviderControls } from '../../hud/providerControls.js';
import { field, textArea, autoGrow, GenvyButton } from '../../hud/components.js';

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
  /** Forget the open scene so the next paint starts a new asset. */
  clear: () => void;
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
    ['no', 'SINGLE SCREEN'],
    ['yes', 'LOOPS HORIZONTALLY'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    loopSel.appendChild(opt);
  }

  const controls = new ProviderControls({ workflow: 'anchor-generate', candidates: false });
  const forgeBtn = document.createElement('genvy-button') as GenvyButton;
  forgeBtn.setAttribute('variant', 'accent');
  forgeBtn.setAttribute('label', 'PAINT THE SCENE');

  // Which asset this panel is about to write to. Without this the user cannot
  // tell a re-paint from a new scene until the inventory tells them, too late.
  const status = document.createElement('div');
  status.className = 'g-hint';
  const newBtn = document.createElement('genvy-button') as GenvyButton;
  newBtn.setAttribute('label', 'START A NEW SCENE');
  newBtn.hidden = true;
  newBtn.onClick(() => {
    UISound.play('click');
    hooks.clear();
    refresh();
    HudShell.toast('NEXT PAINT CREATES A NEW SCENE');
  });

  function refresh() {
    const open = hooks.current();
    const cost = controls.costPreview();
    const verb = open ? 'REPAINT THIS SCENE' : 'PAINT THE SCENE';
    forgeBtn.setLabel(`${verb}${cost ? ` · ${cost}` : ''}`);
    status.textContent = open
      ? `EDITING: ${open.name.toUpperCase()} — PAINTING AGAIN REPLACES ITS ARTWORK AND CLEARS ITS MASK.`
      : 'NO SCENE OPEN — PAINTING CREATES A NEW ONE.';
    newBtn.hidden = !open;
    if (open && !prompt.value.trim()) prompt.value = open.prompt;
    for (const opt of Array.from(viewSel.options)) {
      if (open && opt.value === open.view) viewSel.value = open.view;
    }
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

  panel.append(
    field('DESCRIBE THE SCENE', prompt),
    rowLeft,
    ...controls.elements(),
    forgeBtn,
    status,
    newBtn,
    hint,
  );
  refresh();

  forgeBtn.onClick(async () => {
    if (!prompt.value.trim()) return HudShell.toast('DESCRIBE THE SCENE FIRST', 'error');
    const blocked = controls.blockedReason();
    if (blocked) return HudShell.toast(blocked, 'error');
    const view = viewSel.value as SceneView;
    const seamless = loopSel.value === 'yes';
    const open = hooks.current();

    await hooks.busy(
      'PAINTING THE SCENE...',
      async () => {
        UISound.play('generate');
        HudShell.setBusyLabel(`${controls.tag()} · PAINTING THE ${view.toUpperCase()} SCENE...`);
        const img = await api.aiImage({
          prompt: prompt.value.trim(),
          // A level is wider than it is tall, whatever the view.
          orientation: 'landscape',
          kind: 'scene',
          view,
          seamless,
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
