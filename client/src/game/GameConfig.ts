import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { HubScene } from './scenes/HubScene.js';
import { SpriteToolScene } from './scenes/SpriteToolScene.js';
import { WorldToolScene } from './scenes/WorldToolScene.js';

export function createGame(): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-canvas-host',
    backgroundColor: '#02040a',
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    pixelArt: true,
    scene: [BootScene, HubScene, SpriteToolScene, WorldToolScene],
  });
}
