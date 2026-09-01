import Phaser from 'phaser';
import { HudShell } from './HudShell.js';
import { UISound } from './UISound.js';

/**
 * Choreographed tool switch: HUD panels out -> whoosh + camera fade -> scene
 * swap (new scene mounts its own HUD layout in create()).
 */
export async function goToScene(current: Phaser.Scene, targetKey: string, data?: object) {
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
