import Phaser from 'phaser';
import { TOOLS, type AssetIndexEntry } from '@genvy/shared';
import { HudShell } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { goToScene, enterScene } from '../../hud/transitions.js';
import { collection } from '../../state/collection.js';

const TOOL_SCENES: Record<string, string> = {
  sprite: 'spriteTool',
  world: 'worldTool',
};

const TYPE_TO_TOOL: Record<string, string> = {
  spritesheet: 'spriteTool',
  character: 'spriteTool',
  animation: 'spriteTool',
  tileset: 'worldTool',
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
    HudShell.showDrawer();
    // Always reflect work done in the tools (saved assets + in-progress sessions).
    void collection.refresh();
    void HudShell.setLayout([]);

    HudShell.onBackToHub = null;
    HudShell.onOpenAsset = (entry: AssetIndexEntry) => {
      const sceneKey = TYPE_TO_TOOL[entry.type];
      if (sceneKey) void goToScene(this, sceneKey, { assetId: entry.id, assetType: entry.type });
    };
    HudShell.onOpenRecovered = (id: string) => {
      void goToScene(this, 'spriteTool', { recoveredId: id });
    };
  }

  private drawBackdrop() {
    const { width, height } = this.scale;
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x0e2a3a, 1);
    const spacing = 48;
    for (let x = 0; x < width; x += spacing) grid.lineBetween(x, 0, x, height);
    for (let y = 0; y < height; y += spacing) grid.lineBetween(0, y, width, y);
    grid.setAlpha(0.5);

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
    const cols = 5;
    const rows = Math.ceil(TOOLS.length / cols);
    const cellW = Math.min(190, (width - 300) / cols);
    const cellH = Math.min(150, (height - 140) / rows);
    const originX = (width - 300) / 2 - ((cols - 1) * cellW) / 2;
    const originY = height / 2 - ((rows - 1) * cellH) / 2 + 20;

    TOOLS.forEach((tool, i) => {
      const x = originX + (i % cols) * cellW;
      const y = originY + Math.floor(i / cols) * cellH;
      const container = this.add.container(x, y);

      const ring = this.add.graphics();
      const color = tool.ready ? 0x1de9ff : 0x24404f;
      ring.lineStyle(2, color, tool.ready ? 0.9 : 0.45);
      ring.strokeCircle(0, 0, 34);
      ring.lineStyle(1, color, tool.ready ? 0.5 : 0.25);
      ring.beginPath();
      ring.arc(0, 0, 42, 0, Math.PI * 0.6);
      ring.strokePath();
      ring.beginPath();
      ring.arc(0, 0, 42, Math.PI, Math.PI * 1.6);
      ring.strokePath();

      const icon = this.add
        .text(0, 0, tool.icon, { fontSize: '30px' })
        .setOrigin(0.5)
        .setAlpha(tool.ready ? 1 : 0.35);

      const label = this.add
        .text(0, 52, tool.name.toUpperCase(), {
          fontFamily: '"Orbitron", sans-serif',
          fontSize: '11px',
          color: tool.ready ? '#cfeeff' : '#4a6472',
          align: 'center',
        })
        .setOrigin(0.5);

      const sub = this.add
        .text(0, 68, tool.ready ? tool.blurb.toUpperCase() : 'COMING ONLINE', {
          fontFamily: '"Share Tech Mono", monospace',
          fontSize: '9px',
          color: tool.ready ? '#6f9ab0' : '#3a4f5c',
          align: 'center',
        })
        .setOrigin(0.5);

      container.add([ring, icon, label, sub]);
      container.setSize(110, 110);
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
          this.cameras.main.pan(x, y, 260, 'Cubic.easeIn');
          this.cameras.main.zoomTo(1.6, 260, 'Cubic.easeIn');
          this.time.delayedCall(230, () => void goToScene(this, TOOL_SCENES[tool.id]!));
        });
      }
    });
  }
}
