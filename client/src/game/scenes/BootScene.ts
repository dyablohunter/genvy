import Phaser from 'phaser';
import { UISound } from '../../hud/UISound.js';
import { HudShell } from '../../hud/HudShell.js';
import { registerAssetOpenHandlers } from '../../hud/transitions.js';
import { collection } from '../../state/collection.js';
import { api } from '../../api/client.js';

/**
 * `npm run dev` starts Vite faster than the Fastify server, so the first
 * requests can hit a dead proxy (ECONNREFUSED). Retry briefly before
 * declaring the server link offline.
 */
async function withRetry<T>(fn: () => Promise<T>, tries = 5, delayMs = 700): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (--tries <= 0) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

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
    // The header inventory works during boot too: without handlers, a click
    // on an asset here would silently do nothing until the hub loaded.
    registerAssetOpenHandlers(this);

    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    const textStyle = {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '16px',
      color: '#1de9ff',
    };
    const lines: Phaser.GameObjects.Text[] = [];

    // NOT scene.isActive(): that reads false while create() is still running,
    // which silently killed the whole boot sequence. Only a real departure
    // (inventory click into a tool) may stop it.
    let departed = false;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      departed = true;
    });

    // Boot immediately — no click gate. Audio unlocks on the first real
    // interaction (UISound.attachUnlock); until then sounds are silently skipped.
    void (async () => {
      UISound.play('boot');
      // Preload collection while the boot text types out.
      const warmup = Promise.allSettled([
        withRetry(() => collection.refresh()),
        withRetry(() => api.health()),
      ]);

      for (let i = 0; i < BOOT_LINES.length; i++) {
        // An inventory click can leave boot for a tool scene mid-typewriter;
        // stop touching a scene that has been shut down.
        if (departed) return;
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
      if (departed) return;
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
    })();
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
