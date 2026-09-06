import Phaser from 'phaser';
import { TOOLS } from '@genvy/shared';
import { HudShell } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { goToScene, enterScene, registerAssetOpenHandlers } from '../../hud/transitions.js';
import { collection } from '../../state/collection.js';

const TOOL_SCENES: Record<string, string> = {
  sprite: 'spriteTool',
  world: 'worldTool',
};

export class HubScene extends Phaser.Scene {
  constructor() {
    super('hub');
  }

  create() {
    enterScene(this);
    this.drawBackdrop();
    this.drawStations();

    HudShell.setBackVisible(false);
    HudShell.setStatus('COMMAND CENTER');
    // The inventory is on-demand everywhere: the ▦ button in the header toggles it.
    // Always reflect work done in the tools (saved assets + in-progress sessions).
    void collection.refresh();
    void HudShell.setLayout([]);

    HudShell.onBackToHub = null;
    registerAssetOpenHandlers(this);
  }

  private drawBackdrop() {
    const { width, height } = this.scale;
    // Redrawn on every scale change: a grid painted once keeps the window size
    // it was born with and stops partway across after a resize.
    let grid: Phaser.GameObjects.Graphics | null = null;
    const drawGrid = () => {
      grid?.destroy();
      grid = this.add.graphics().setDepth(-100);
      grid.lineStyle(1, 0x0e2a3a, 1);
      const spacing = 48;
      for (let x = 0; x < this.scale.width; x += spacing) {
        grid.lineBetween(x, 0, x, this.scale.height);
      }
      for (let y = 0; y < this.scale.height; y += spacing) {
        grid.lineBetween(0, y, this.scale.width, y);
      }
      grid.setAlpha(0.5);
    };
    drawGrid();
    this.scale.on(Phaser.Scale.Events.RESIZE, drawGrid);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, drawGrid);
    });

    // Slow-drifting particle motes.
    for (let i = 0; i < 40; i++) {
      const mote = this.add.circle(
        Phaser.Math.Between(0, width),
        Phaser.Math.Between(0, height),
        Phaser.Math.Between(1, 2),
        0x1de9ff,
        Phaser.Math.FloatBetween(0.1, 0.4),
      );
      this.tweens.add({
        targets: mote,
        y: mote.y - Phaser.Math.Between(40, 140),
        alpha: 0,
        duration: Phaser.Math.Between(4000, 9000),
        repeat: -1,
        onRepeat: () => {
          mote.y = height + 10;
          mote.x = Phaser.Math.Between(0, width);
          mote.alpha = Phaser.Math.FloatBetween(0.1, 0.4);
        },
      });
    }
  }

  private drawStations() {
    const { width, height } = this.scale;
    // The inventory is an on-demand overlay now: fill most of the viewport and
    // scale every station element with the cell size.
    const cols = 5;
    const rows = Math.ceil(TOOLS.length / cols);
    const cellW = (width - 80) / cols;
    const cellH = (height - 160) / rows;
    const k = Math.max(1, Math.min(cellW / 190, cellH / 150, 1.9));
    const originX = width / 2 - ((cols - 1) * cellW) / 2;
    const originY = height / 2 - ((rows - 1) * cellH) / 2 + 20;

    TOOLS.forEach((tool, i) => {
      const x = originX + (i % cols) * cellW;
      const y = originY + Math.floor(i / cols) * cellH;
      const container = this.add.container(x, y);

      const ring = this.add.graphics();
      const color = tool.ready ? 0x1de9ff : 0x24404f;
      ring.lineStyle(2, color, tool.ready ? 0.9 : 0.45);
      ring.strokeCircle(0, 0, 34 * k);
      ring.lineStyle(1, color, tool.ready ? 0.5 : 0.25);
      ring.beginPath();
      ring.arc(0, 0, 42 * k, 0, Math.PI * 0.6);
      ring.strokePath();
      ring.beginPath();
      ring.arc(0, 0, 42 * k, Math.PI, Math.PI * 1.6);
      ring.strokePath();

      const icon = this.add
        .text(0, 0, tool.icon, {
          fontSize: `${Math.round(30 * k)}px`,
          // Emoji glyphs overshoot the reported line box at large sizes and
          // get clipped at the top without explicit padding.
          padding: { x: Math.ceil(6 * k), y: Math.ceil(8 * k) },
        })
        .setOrigin(0.5)
        .setAlpha(tool.ready ? 1 : 0.35);

      const label = this.add
        .text(0, 52 * k, tool.name.toUpperCase(), {
          fontFamily: '"Orbitron", sans-serif',
          fontSize: `${Math.round(11 * k)}px`,
          color: tool.ready ? '#cfeeff' : '#4a6472',
          align: 'center',
        })
        .setOrigin(0.5);

      const sub = this.add
        .text(0, 52 * k + Math.round(16 * k), tool.ready ? tool.blurb.toUpperCase() : 'COMING ONLINE', {
          fontFamily: '"Share Tech Mono", monospace',
          fontSize: `${Math.round(9 * k)}px`,
          color: tool.ready ? '#6f9ab0' : '#3a4f5c',
          align: 'center',
        })
        .setOrigin(0.5);

      container.add([ring, icon, label, sub]);
      container.setSize(110 * k, 110 * k);
      container.setAlpha(0);
      this.tweens.add({
        targets: container,
        alpha: 1,
        y: y - 6,
        delay: i * 45,
        duration: 350,
        ease: 'Cubic.easeOut',
      });

      if (tool.ready) {
        this.tweens.add({
          targets: ring,
          angle: 360,
          duration: 14000,
          repeat: -1,
        });
        container.setInteractive({ useHandCursor: true });
        container.on('pointerover', () => {
          UISound.play('hover');
          this.tweens.add({ targets: container, scale: 1.12, duration: 140, ease: 'Back.easeOut' });
          this.tweens.add({ targets: ring, angle: ring.angle + 360, duration: 1400, repeat: -1 });
        });
        container.on('pointerout', () => {
          this.tweens.add({ targets: container, scale: 1, duration: 140 });
          this.tweens.killTweensOf(ring);
          this.tweens.add({ targets: ring, angle: 360, duration: 14000, repeat: -1 });
        });
        container.on('pointerdown', () => {
          UISound.play('confirm');
          // No camera pan/zoom: zooming toward an off-center station reads as
          // the whole menu sliding diagonally. The chosen station acknowledges
          // the click in place; goToScene's fade does the rest.
          this.tweens.add({ targets: container, scale: 1.25, duration: 180, ease: 'Cubic.easeOut' });
          void goToScene(this, TOOL_SCENES[tool.id]!);
        });
      }
    });
  }
}
