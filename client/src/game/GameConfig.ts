import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { HubScene } from './scenes/HubScene.js';
import { SpriteToolScene } from './scenes/SpriteToolScene.js';
import { WorldToolScene } from './scenes/WorldToolScene.js';

/**
 * The canvas backing store runs at PHYSICAL pixels (CSS size × devicePixelRatio),
 * while theme.css stretches the element to 100% of the viewport. With RESIZE
 * mode the backing store was only CSS-sized, so any display scaling or browser
 * zoom made the browser stretch the bitmap — blurring everything Phaser drew
 * (sprites at "1:1" included) while the DOM HUD stayed crisp. One game pixel
 * now equals one device pixel, so scale 1 is true 1:1 on screen.
 */
export function createGame(): Phaser.Game {
  const dpr = () => Math.max(1, window.devicePixelRatio || 1);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-canvas-host',
    backgroundColor: '#02040a',
    scale: {
      mode: Phaser.Scale.NONE,
      width: Math.round(window.innerWidth * dpr()),
      height: Math.round(window.innerHeight * dpr()),
    },
    pixelArt: true,
    scene: [BootScene, HubScene, SpriteToolScene, WorldToolScene],
  });
  // Scale.NONE means we own resizing: track the viewport (and zoom changes,
  // which alter devicePixelRatio) ourselves.
  window.addEventListener('resize', () => {
    game.scale.resize(Math.round(window.innerWidth * dpr()), Math.round(window.innerHeight * dpr()));
  });
  return game;
}
