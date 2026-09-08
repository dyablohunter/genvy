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
  const host = document.getElementById('game-canvas-host')!;
  // The canvas fills its HOST, not the window: the host is a cell of the app
  // layout, and the strip timeline takes a row (or a column) out of it. Sizing
  // to the window instead would leave Phaser drawing at the wrong aspect and
  // the browser stretching the result.
  const size = () => ({
    width: Math.max(1, Math.round((host.clientWidth || window.innerWidth) * dpr())),
    height: Math.max(1, Math.round((host.clientHeight || window.innerHeight) * dpr())),
  });
  const start = size();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-canvas-host',
    backgroundColor: '#02040a',
    scale: {
      mode: Phaser.Scale.NONE,
      width: start.width,
      height: start.height,
    },
    pixelArt: true,
    // Pads are for the playtest dummy; the browser only exposes one after a
    // button is pressed on it, so enabling this costs nothing until then.
    input: { gamepad: true },
    scene: [BootScene, HubScene, SpriteToolScene, WorldToolScene],
  });
  // Scale.NONE means we own resizing: follow the HOST (which changes when a
  // timeline band opens or closes) as well as the viewport and zoom changes,
  // which alter devicePixelRatio.
  const apply = () => {
    const { width, height } = size();
    if (game.scale.width !== width || game.scale.height !== height) game.scale.resize(width, height);
  };
  window.addEventListener('resize', apply);
  new ResizeObserver(apply).observe(host);
  return game;
}
