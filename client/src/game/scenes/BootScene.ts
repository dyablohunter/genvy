import Phaser from 'phaser';
import { UISound } from '../../hud/UISound.js';
import { HudShell } from '../../hud/HudShell.js';
import { collection } from '../../state/collection.js';
import { api } from '../../api/client.js';

const BOOT_LINES = [
  'GENVY OS v0.1',
  'INITIALIZING CREATION MATRIX...',
  'LINKING NEURAL FORGES...',
  'CALIBRATING PIXEL EMITTERS...',
  'SYSTEMS ONLINE',
];

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create() {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    const textStyle = {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '16px',
      color: '#1de9ff',
    };
    const lines: Phaser.GameObjects.Text[] = [];

    // The user must click once so the AudioContext can start.
    const prompt = this.add
      .text(cx, cy, '[ CLICK TO INITIALIZE ]', {
        ...textStyle,
        fontSize: '22px',
        fontFamily: '"Orbitron", sans-serif',
      })
      .setOrigin(0.5);
    this.tweens.add({ targets: prompt, alpha: 0.3, duration: 700, yoyo: true, repeat: -1 });

    this.input.once('pointerdown', async () => {
      prompt.destroy();
      UISound.play('boot');
      // Preload collection while the boot text types out.
      const warmup = Promise.allSettled([collection.refresh(), api.health()]);

      for (let i = 0; i < BOOT_LINES.length; i++) {
        const line = this.add
          .text(cx, cy - 60 + i * 30, '', {
            ...textStyle,
            color: i === BOOT_LINES.length - 1 ? '#3dff8c' : '#1de9ff',
          })
          .setOrigin(0.5);
        lines.push(line);
        await this.typewrite(line, BOOT_LINES[i]!);
      }

      const results = await warmup;
      const health = results[1];
      if (health.status === 'fulfilled' && (!health.value.ai.text || !health.value.ai.image)) {
        HudShell.toast('AI LINK OFFLINE — CHECK API KEYS', 'error');
      } else if (health.status === 'rejected') {
        HudShell.toast('SERVER LINK OFFLINE — START THE GENVY SERVER', 'error');
      }

      this.time.delayedCall(450, () => {
        this.cameras.main.fadeOut(350, 2, 4, 10);
        this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
          this.scene.start('hub');
        });
      });
    });
  }

  private typewrite(target: Phaser.GameObjects.Text, text: string): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const timer = this.time.addEvent({
        delay: 18,
        repeat: text.length - 1,
        callback: () => {
          i++;
          target.setText(text.slice(0, i));
          if (i >= text.length) {
            timer.remove();
            resolve();
          }
        },
      });
    });
  }
}
