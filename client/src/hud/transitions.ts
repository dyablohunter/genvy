import Phaser from 'phaser';
import { HudShell } from './HudShell.js';
import { UISound } from './UISound.js';
import type { AssetIndexEntry } from '@genvy/shared';
import { assetTypeLabel } from './components.js';

/**
 * ONE routing table for the whole app. Tool scenes used to each carry their
 * own if/else over asset types, and every type either scene forgot — an
 * animation clicked from World Maker, a scene clicked from Sprite Forge —
 * became a click that did nothing at all.
 */
const TYPE_TO_TOOL: Record<string, string> = {
  spritesheet: 'spriteTool',
  character: 'spriteTool',
  animation: 'spriteTool',
  tileset: 'worldTool',
  world: 'worldTool',
  scene: 'worldTool',
  level: 'worldTool',
};

/**
 * Route inventory clicks to the right tool scene. EVERY scene that can be on
 * screen while the inventory is reachable must call this in create() — the
 * handlers are plain nullable fields on HudShell, so a scene that forgets
 * leaves inventory clicks silently dead (the boot screen had this bug).
 */
export function registerAssetOpenHandlers(scene: Phaser.Scene) {
  HudShell.onOpenAsset = (entry: AssetIndexEntry) => {
    const sceneKey = TYPE_TO_TOOL[entry.type];
    if (!sceneKey) {
      // Say so rather than swallowing the click: a dead click reads as a
      // broken app, and this is how unrouted types used to behave.
      HudShell.toast(`NO TOOL OPENS A ${assetTypeLabel(entry.type)} YET`, 'warn');
      return;
    }
    void goToScene(scene, sceneKey, { assetId: entry.id, assetType: entry.type });
  };
  HudShell.onOpenRecovered = (id: string) => {
    void goToScene(scene, 'spriteTool', { recoveredId: id });
  };
}

/**
 * Choreographed tool switch: HUD panels out -> whoosh + camera fade -> scene
 * swap (new scene mounts its own HUD layout in create()).
 *
 * `data` defaults to {} on purpose: Phaser keeps the previous settings.data
 * when a scene starts without data, so a bare hub-station click would replay
 * the last-opened asset instead of starting fresh.
 */
export async function goToScene(current: Phaser.Scene, targetKey: string, data: object = {}) {
  UISound.play('whoosh');
  const cam = current.cameras.main;
  const fade = new Promise<void>((resolve) => {
    cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => resolve());
    cam.fadeOut(220, 2, 4, 10);
  });
  await Promise.all([HudShell.clearLayout(), fade]);
  current.scene.start(targetKey, data);
}

/** Standard scene entrance: fade in from dark. */
export function enterScene(scene: Phaser.Scene) {
  scene.cameras.main.fadeIn(300, 2, 4, 10);
}
