import Phaser from 'phaser';
import type { Scene, SceneShape, Character, Spritesheet, AnimationAsset } from '@genvy/shared';
import { SCENE_MASK_KINDS, pointInShape } from '@genvy/shared';
import { api, fileUrl } from '../api/client.js';
import { HudShell } from '../hud/HudShell.js';

/**
 * The playtest dummy: a controllable figure dropped onto a painted scene so
 * the collision that was just painted can be FELT, not inferred. A mask is
 * only right when something walks on it.
 *
 * Side-view scenes get platformer physics — gravity, one-way platforms,
 * ladders, water drag, a jump (with a jump pose). Overhead views get 8-way
 * movement with no gravity and no jump: jumping is a platformer idea, and a
 * top-down dummy that hopped would be testing physics the game will not have.
 *
 * The figure is either the built-in stick figure (procedurally animated:
 * walk, run, jump) or one of the user's characters, playing its own walk/run/
 * jump clips when it has them.
 */

export interface DummyOptions {
  /** Height on screen, in scene pixels. */
  height: number;
  /** Jump apex height, in scene pixels (side view only). */
  jumpHeight: number;
  /** A character asset to wear, or null for the stick figure. */
  characterId: string | null;
}

/** Mask ids the dummy treats as ground/wall. */
const KIND = Object.fromEntries(SCENE_MASK_KINDS.map((k) => [k.key, k.id])) as Record<
  (typeof SCENE_MASK_KINDS)[number]['key'],
  number
>;

const GRAVITY = 1800; // px/s^2 — snappy, game-like, not floaty

export class SceneDummy {
  private sprite: Phaser.GameObjects.Sprite | null = null;
  private stick: Phaser.GameObjects.Graphics | null = null;
  private pos = { x: 0, y: 0 };
  private vel = { x: 0, y: 0 };
  private grounded = false;
  private onLadder = false;
  private facing = 1;
  /** Walk-cycle phase, advanced by distance so the gait matches the speed. */
  private phase = 0;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private width: number;
  private height: number;
  private destroyed = false;
  private padJump = false;
  /** Time spent continuously airborne — the jump pose waits for it. */
  private airMs = 0;

  constructor(
    private scene: Phaser.Scene,
    private opts: DummyOptions,
    /** Where the mask lives: the world tool passes its own live state. */
    private world: {
      maskAt: (x: number, y: number) => number;
      shapes: () => SceneShape[];
      view: () => Scene['view'];
      bounds: () => { width: number; height: number };
    },
  ) {
    this.height = opts.height;
    this.width = Math.max(8, Math.round(opts.height * 0.42));
  }

  get active() {
    return !this.destroyed;
  }

  /** True on side views: gravity, platforms and the jump exist only there. */
  private get platformer() {
    return this.world.view() === 'side';
  }

  async spawn(x: number, y: number) {
    this.pos = { x, y };
    const kb = this.scene.input.keyboard;
    if (kb) {
      const codes = Phaser.Input.Keyboard.KeyCodes;
      for (const [name, code] of [
        ['left', codes.LEFT],
        ['right', codes.RIGHT],
        ['up', codes.UP],
        ['down', codes.DOWN],
        ['a', codes.A],
        ['d', codes.D],
        ['w', codes.W],
        ['s', codes.S],
        ['shift', codes.SHIFT],
        ['space', codes.SPACE],
      ] as const) {
        this.keys[name] = kb.addKey(code, false);
      }
    }
    if (this.opts.characterId) {
      await this.dressAsCharacter(this.opts.characterId);
    }
    if (!this.sprite) {
      this.stick = this.scene.add.graphics().setDepth(40);
    }
  }

  /**
   * Load the character's sheet and build walk/run/jump/idle animations from
   * its own clips. Falls back to the stick figure when the sheet is missing —
   * a broken asset should degrade the dummy, not the whole playtest.
   */
  private async dressAsCharacter(id: string) {
    try {
      const character = await api.getAsset<Character>(id);
      const sheet = await api.getAsset<Spritesheet>(character.sheet.id);
      const key = `dummy:${sheet.id}`;
      if (!this.scene.textures.exists(key)) {
        await new Promise<void>((resolve, reject) => {
          this.scene.load.spritesheet(key, `${fileUrl(sheet.image)}?t=${Date.now()}`, {
            frameWidth: sheet.frameWidth,
            frameHeight: sheet.frameHeight,
            margin: sheet.margin,
            spacing: sheet.spacing,
          });
          this.scene.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
          this.scene.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, () =>
            reject(new Error('sheet load failed')),
          );
          this.scene.load.start();
        });
      }
      for (const slot of ['idle', 'walk', 'run', 'jump'] as const) {
        const ref = character.animations[slot];
        if (!ref) continue;
        const animKey = `dummy:${id}:${slot}`;
        if (this.scene.anims.exists(animKey)) continue;
        const clip = await api.getAsset<AnimationAsset>(ref.id);
        this.scene.anims.create({
          key: animKey,
          frames: clip.frames.map((f) => ({ key, frame: f })),
          frameRate: clip.frameRate,
          repeat: slot === 'jump' ? 0 : -1,
          yoyo: clip.yoyo,
        });
      }
      const sprite = this.scene.add.sprite(this.pos.x, this.pos.y, key).setDepth(40);
      sprite.setOrigin(0.5, 1); // feet at pos — that is what stands on the mask
      sprite.setScale(this.height / sheet.frameHeight);
      this.sprite = sprite;
      this.charId = id;
    } catch {
      this.sprite = null; // stick figure takes over
    }
  }

  private charId: string | null = null;
  /** Which pad family is driving, once one has spoken up. */
  private padType: 'xbox' | 'playstation' | 'generic' | null = null;

  /**
   * Read the first connected gamepad through Phaser's standard mapping, and
   * name it once: the same physical buttons carry different glyphs on an
   * Xbox and a PlayStation pad, and a toast that says "A JUMPS" to someone
   * holding a DualSense is wrong in the way that erodes trust.
   */
  private readPad() {
    const pad = this.scene.input.gamepad?.getPad(0);
    if (!pad || !pad.connected) return null;
    if (!this.padType) {
      const id = pad.id.toLowerCase();
      this.padType = /xbox|xinput|045e/.test(id)
        ? 'xbox'
        : /playstation|dualshock|dualsense|wireless controller|054c|09cc/.test(id)
          ? 'playstation'
          : 'generic';
      const jump = this.padType === 'playstation' ? '✕' : 'A';
      HudShell.toast(
        `${this.padType === 'generic' ? 'GAMEPAD' : this.padType.toUpperCase()} CONNECTED — ` +
          `STICK OR D-PAD MOVES${this.platformer ? `, ${jump} JUMPS` : ''}, PUSH THE STICK HARD TO RUN`,
      );
    }
    const stickX = pad.leftStick?.x ?? 0;
    const stickY = pad.leftStick?.y ?? 0;
    const dead = 0.25;
    return {
      left: pad.left || stickX < -dead,
      right: pad.right || stickX > dead,
      up: pad.up || stickY < -dead,
      down: pad.down || stickY > dead,
      // Running is the stick pushed to its edge, plus the usual sprint spots.
      run: Math.hypot(stickX, stickY) > 0.85 || pad.R1 > 0 || pad.X,
      jump: pad.A,
    };
  }

  /** Play a character clip if it exists; silently keep the last one if not. */
  private play(slot: 'idle' | 'walk' | 'run' | 'jump') {
    if (!this.sprite || !this.charId) return;
    const key = `dummy:${this.charId}:${slot}`;
    if (!this.scene.anims.exists(key)) return;
    if (this.sprite.anims.currentAnim?.key !== key) this.sprite.play(key);
  }

  /** The mask id at a world point, shapes included (shapes win). */
  private solidAt(x: number, y: number): number {
    for (const shape of this.world.shapes()) {
      if (pointInShape(shape, x, y)) return shape.kind;
    }
    return this.world.maskAt(x, y);
  }

  private blocked(x: number, y: number): boolean {
    const id = this.solidAt(x, y);
    return id === KIND.solid || id === KIND.ramp || id === KIND.stairs;
  }

  /** One-way platforms block only downward motion through their top. */
  private standable(x: number, y: number): boolean {
    return this.blocked(x, y) || this.solidAt(x, y) === KIND.platform;
  }

  update(dtMs: number) {
    if (this.destroyed) return;
    const dt = Math.min(0.05, dtMs / 1000); // clamp: a hitched frame must not tunnel
    const k = this.keys;
    const pad = this.readPad();
    const left = ((k.left?.isDown || k.a?.isDown) ?? false) || (pad?.left ?? false);
    const right = ((k.right?.isDown || k.d?.isDown) ?? false) || (pad?.right ?? false);
    const up = ((k.up?.isDown || k.w?.isDown) ?? false) || (pad?.up ?? false);
    const down = ((k.down?.isDown || k.s?.isDown) ?? false) || (pad?.down ?? false);
    const running = (k.shift?.isDown ?? false) || (pad?.run ?? false);
    this.padJump = pad?.jump ?? false;

    const inWater = this.solidAt(this.pos.x, this.pos.y - this.height / 2) === KIND.water;
    const speed = this.height * (running ? 5.5 : 2.8) * (inWater ? 0.45 : 1);

    if (this.platformer) {
      this.updatePlatformer(dt, { left, right, up, down, speed, inWater });
    } else {
      this.updateOverhead(dt, { left, right, up, down, speed });
    }
    this.render(running, dt);
  }

  private updatePlatformer(
    dt: number,
    input: { left: boolean; right: boolean; up: boolean; down: boolean; speed: number; inWater: boolean },
  ) {
    const k = this.keys;
    this.vel.x = (input.left ? -1 : 0) * input.speed + (input.right ? 1 : 0) * input.speed;
    if (this.vel.x !== 0) this.facing = Math.sign(this.vel.x);

    // Ladders suspend gravity while held.
    const onLadderCell =
      this.solidAt(this.pos.x, this.pos.y - this.height / 2) === KIND.ladder ||
      this.solidAt(this.pos.x, this.pos.y - 1) === KIND.ladder;
    if (onLadderCell && (input.up || input.down || this.onLadder)) {
      this.onLadder = true;
      this.vel.y = (input.up ? -1 : 0) * input.speed + (input.down ? 1 : 0) * input.speed;
    } else {
      this.onLadder = false;
      this.vel.y += GRAVITY * (input.inWater ? 0.35 : 1) * dt;
    }

    // Jump velocity from the requested apex: v = sqrt(2 g h).
    const wantJump = k.space?.isDown || input.up || this.padJump;
    if (wantJump && (this.grounded || this.onLadder)) {
      this.vel.y = -Math.sqrt(2 * GRAVITY * this.opts.jumpHeight);
      this.grounded = false;
      this.onLadder = false;
      this.play('jump');
    }

    // Horizontal, probed at knee and head so a step does not stop the chest.
    const nx = this.pos.x + this.vel.x * dt;
    const side = nx + this.facing * (this.width / 2);
    if (
      this.vel.x === 0 ||
      (!this.blocked(side, this.pos.y - 2) && !this.blocked(side, this.pos.y - this.height + 2))
    ) {
      this.pos.x = nx;
    } else if (!this.blocked(side, this.pos.y - this.height * 0.35)) {
      // A shallow step (ramp/stairs painted as cells): walk up it — but only
      // as far as a step can be. Unbounded, this loop would teleport the
      // figure up any wall whose top happened to be reachable.
      const maxStep = Math.ceil(this.height * 0.4);
      let climb = 0;
      while (
        climb <= maxStep &&
        this.blocked(this.pos.x + this.facing * (this.width / 2) + this.vel.x * dt, this.pos.y - climb - 2)
      ) {
        climb++;
      }
      if (climb <= maxStep) {
        this.pos.x = nx;
        this.pos.y -= climb;
      } else {
        this.vel.x = 0; // taller than a step: it is a wall
      }
    } else {
      this.vel.x = 0;
    }

    // Vertical. Standing on a surface is a STATE, not something to
    // re-discover by sinking half a pixel into it each frame: gravity gave a
    // tiny downward velocity, the landing scan could not see a surface less
    // than a pixel away, and `grounded` flickered off and on — with the pose
    // flickering between walk and jump along with it.
    const supported =
      this.vel.y >= 0 && !this.onLadder && this.standable(this.pos.x, this.pos.y + 1);
    const ny = this.pos.y + this.vel.y * dt;
    if (supported) {
      this.vel.y = 0;
      this.grounded = true;
    } else if (this.grounded && this.vel.y >= 0 && this.snapToGround()) {
      // Walked down the far side of a slope: the feet followed it.
    } else if (this.vel.y > 0) {
      // Falling: the FIRST standable pixel the feet cross is the ground.
      let landed = false;
      for (let y = Math.floor(this.pos.y) + 1; y <= ny; y++) {
        if (this.standable(this.pos.x, y)) {
          this.pos.y = y - 1; // feet rest on the pixel above the surface
          this.vel.y = 0;
          landed = true;
          break;
        }
      }
      if (!landed) this.pos.y = ny;
      this.grounded = landed;
    } else if (this.vel.y < 0) {
      const head = ny - this.height;
      if (this.blocked(this.pos.x, head)) {
        this.vel.y = 0; // bumped the ceiling — platforms do not block upward
      } else {
        this.pos.y = ny;
      }
      this.grounded = false;
    }

    // Walking INTO standable ground must climb it, not ghost through it.
    // One-way platforms never block sideways, so a staircase painted as
    // platform cells lets the body enter from the side; the feet are then
    // inside the region, and gravity has nothing to say about it. Lift to
    // the surface instead — that is what stepping onto a stair is.
    if (this.vel.y >= 0) {
      const maxLift = Math.max(4, this.height * 0.6);
      let surface = 0;
      while (surface < maxLift && this.standable(this.pos.x, this.pos.y - surface)) surface++;
      if (surface > 0 && surface < maxLift) {
        this.pos.y -= surface;
        this.vel.y = 0;
        this.grounded = true;
      }
    }

    // The scene has edges, not walls; do not fall out of the world forever.
    const b = this.world.bounds();
    this.pos.x = Phaser.Math.Clamp(this.pos.x, this.width / 2, b.width - this.width / 2);
    if (this.pos.y > b.height + this.height * 4) {
      this.pos.y = -this.height; // fell out: drop back in from the top
      this.vel.y = 0;
    }
  }

  /**
   * Glue the feet to ground that dropped away by less than a step. An angled
   * or hand-painted surface descends a pixel or two under every stride;
   * treating each dip as becoming airborne flashed the jump pose mid-walk.
   * Beyond a step's depth it is a real edge, and falling is correct.
   */
  private snapToGround(): boolean {
    const reach = Math.max(4, Math.ceil(this.height * 0.25));
    for (let drop = 1; drop <= reach; drop++) {
      if (this.standable(this.pos.x, this.pos.y + drop + 1)) {
        this.pos.y += drop;
        this.vel.y = 0;
        this.grounded = true;
        return true;
      }
    }
    return false;
  }

  private updateOverhead(
    dt: number,
    input: { left: boolean; right: boolean; up: boolean; down: boolean; speed: number },
  ) {
    const dx = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    const dy = (input.up ? -1 : 0) + (input.down ? 1 : 0);
    const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
    if (dx !== 0) this.facing = dx;
    const nx = this.pos.x + dx * input.speed * norm * dt;
    const ny = this.pos.y + dy * input.speed * norm * dt;
    // Overhead worlds read the mask at the feet; walkable does not block.
    const feetProbe = (x: number, y: number) => this.blocked(x, y - 2);
    if (!feetProbe(nx + Math.sign(dx) * (this.width / 2), this.pos.y)) this.pos.x = nx;
    if (!feetProbe(this.pos.x, ny + Math.sign(dy) * 2)) this.pos.y = ny;
    const b = this.world.bounds();
    this.pos.x = Phaser.Math.Clamp(this.pos.x, this.width / 2, b.width - this.width / 2);
    this.pos.y = Phaser.Math.Clamp(this.pos.y, this.height, b.height);
    this.vel.x = dx * input.speed;
    this.vel.y = dy * input.speed;
  }

  private render(running: boolean, dt: number) {
    const moving = Math.abs(this.vel.x) > 1 || (!this.platformer && Math.abs(this.vel.y) > 1);
    // The jump pose waits ~100ms of continuous air time: a surface that is
    // angled or hand-painted can cost the physics a single frame of ground
    // contact, and a pose that reacts faster than the eye reads as flicker.
    const inAir = this.platformer && !this.grounded && !this.onLadder;
    this.airMs = inAir ? this.airMs + dt * 1000 : 0;
    const airborne = inAir && this.airMs > 100;
    // Distance-driven phase, through TIME: one full stride per ~1.3 body
    // heights of ground covered. The old version advanced per FRAME, so at
    // 60fps the legs beat sixty times faster than the ground went by.
    const travelled = Math.hypot(this.vel.x, this.platformer ? 0 : this.vel.y) * dt;
    this.phase += travelled / (this.height * 1.3);

    if (this.sprite) {
      this.sprite.setPosition(this.pos.x, this.pos.y);
      this.sprite.setFlipX(this.facing < 0);
      if (airborne) this.play('jump');
      else if (moving) this.play(running ? 'run' : 'walk');
      else this.play('idle');
      return;
    }
    this.drawStickFigure(moving, running, airborne);
  }

  /**
   * The built-in figure: a stick person with a real gait. Legs and arms swing
   * in opposition, running lengthens the stride and leans the torso, and the
   * jump pose tucks the legs — so walk, run and jump all read at a glance.
   */
  private drawStickFigure(moving: boolean, running: boolean, airborne: boolean) {
    const g = this.stick;
    if (!g) return;
    g.clear();
    const h = this.height;
    const x = this.pos.x;
    const feetY = this.pos.y;

    const legLen = h * 0.42;
    const torsoLen = h * 0.36;
    const headR = h * 0.11;
    const swing = airborne ? 0 : moving ? Math.sin(this.phase * Math.PI * 2) : 0;
    const stride = running ? 0.9 : 0.55;
    const lean = airborne ? 0.15 : running && moving ? 0.28 : moving ? 0.1 : 0;

    const hipX = x + this.facing * lean * torsoLen * 0.4;
    const hipY = feetY - legLen;
    const shoulderX = hipX + this.facing * lean * torsoLen;
    const shoulderY = hipY - torsoLen;

    const leg = (dir: number) => {
      const a = airborne ? dir * 0.5 + 0.4 : swing * dir * stride;
      const kneeX = hipX + Math.sin(a) * legLen * 0.5 * this.facing;
      const kneeY = hipY + Math.cos(a) * legLen * 0.5 * (airborne ? 0.6 : 1);
      const footX = kneeX + Math.sin(a * (airborne ? 2 : 1.4)) * legLen * 0.5 * this.facing;
      const footY = airborne ? kneeY + legLen * 0.25 : feetY;
      g.lineBetween(hipX, hipY, kneeX, kneeY);
      g.lineBetween(kneeX, kneeY, footX, footY);
    };
    const arm = (dir: number) => {
      const a = airborne ? -0.9 * dir : swing * dir * stride * 0.8;
      const handX = shoulderX + Math.sin(a) * torsoLen * 0.8 * this.facing;
      const handY = shoulderY + Math.cos(a) * torsoLen * 0.8;
      g.lineBetween(shoulderX, shoulderY, handX, handY);
    };

    const weight = Math.max(1.5, h * 0.045);
    g.lineStyle(weight, 0xffffff, 0.95);
    leg(1);
    leg(-1);
    g.lineBetween(hipX, hipY, shoulderX, shoulderY);
    arm(1);
    arm(-1);
    g.strokeCircle(shoulderX + this.facing * lean * headR, shoulderY - headR, headR);
    // A hint of facing: a nose-tick on the head.
    g.lineBetween(
      shoulderX + this.facing * headR * 0.6,
      shoulderY - headR,
      shoulderX + this.facing * headR * 1.2,
      shoulderY - headR,
    );
  }

  /** The figure's feet, for the camera to follow. */
  get position() {
    return { x: this.pos.x, y: this.pos.y - this.height / 2 };
  }

  destroy() {
    this.destroyed = true;
    this.sprite?.destroy();
    this.stick?.destroy();
    this.sprite = null;
    this.stick = null;
  }
}
