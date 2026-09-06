import { KP, KEYPOINT_COUNT, MIRROR_INDEX } from './coco.js';

/**
 * Procedural, phase-accurate skeletons for the standard clips. This replaces
 * the diffusion model's guess about where the limbs go with a constraint:
 * every frame's 18 COCO keypoints are computed from an explicit gait phase,
 * so leg alternation, arm counter-swing and body bob are correct BY
 * CONSTRUCTION and the animation gate only has to catch identity drift.
 *
 * All positions are normalized to a square canvas: x,y in [0,1], y down.
 * Looping clips (walk/run/idle) sample t = i/N so frame N would land exactly
 * on frame 0 — the loop closure the prompts used to beg gpt-image-2 for.
 * One-shot clips (jump/attack) sample u = i/(N-1) to hit both endpoints.
 */

export type ClipId = 'walk' | 'run' | 'idle' | 'jump' | 'attack';
export type Facing = 'south' | 'west' | 'east' | 'north';

export interface Keypoint {
  x: number;
  y: number;
  /** Occluded joints (e.g. the far eye in profile) are not drawn. */
  visible: boolean;
}

export interface SkeletonFrame {
  keypoints: Keypoint[]; // length 18, COCO order
}

export interface ClipRequest {
  clip: string;
  frames: number;
  facing?: Facing;
}

/** Canvas-relative proportions (fractions of the canvas, not of the body). */
const H = 0.72; // total body height budget
const GROUND = 0.92;
const TORSO = 0.3 * H;
const NECK_HEAD = 0.1 * H; // neck -> nose
const LEG_UPPER = 0.24 * H;
const LEG_LOWER = 0.24 * H;
const ARM_UPPER = 0.16 * H;
const ARM_LOWER = 0.14 * H;
const HIP_HALF = 0.055 * H;
const SHOULDER_HALF = 0.085 * H;
/** Tiny near/far offset in profile so overlapping limbs stay distinguishable. */
const DEPTH = 0.012;

const PELVIS_BASE_Y = GROUND - LEG_UPPER - LEG_LOWER;
const TAU = Math.PI * 2;

/** Per-frame pose parameters in profile terms (angles from straight down, + = forward). */
interface FrameParams {
  /** Pelvis vertical offset (+down, canvas units). Bob and flight both land here. */
  pelvisDy: number;
  /** Breathing offset applied to the upper body ONLY — feet stay planted. */
  breathDy: number;
  /** Forward torso lean in radians. */
  lean: number;
  hipR: number;
  hipL: number;
  /** Knee flexion, always >= 0 (a knee never bends forward). */
  kneeR: number;
  kneeL: number;
  shoulderR: number;
  shoulderL: number;
  /** Elbow flexion, always >= 0 (bends forward of the upper arm). */
  elbowR: number;
  elbowL: number;
  /** Extra forward shift of the torso (attack lunge) — legs stay put. */
  torsoDx: number;
}

const rest = (): FrameParams => ({
  pelvisDy: 0,
  breathDy: 0,
  lean: 0,
  hipR: 0,
  hipL: 0,
  kneeR: 0.08,
  kneeL: 0.08,
  shoulderR: 0,
  shoulderL: 0,
  elbowR: 0.15,
  elbowL: 0.15,
  torsoDx: 0,
});

/** Piecewise-linear keyframe track: pts are [u, value], u ascending over [0,1]. */
export function track(pts: ReadonlyArray<readonly [number, number]>, u: number): number {
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (u <= first[0]) return first[1];
  if (u >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i]!;
    if (u <= b[0]) {
      const a = pts[i - 1]!;
      const k = (u - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return last[1];
}

// ---------------------------------------------------------------- clips

/**
 * Walk: hip swing is a sine; the two legs run exactly half a cycle apart.
 * Knee flexion peaks mid-swing (when the leg passes under the body) and the
 * leg is straight through stance; the body bobs TWICE per cycle, highest at
 * the passing poses. Arms counter-swing their same-side leg.
 */
function walkParams(t: number): FrameParams {
  const phiR = TAU * t;
  const phiL = phiR + Math.PI;
  const hip = (phi: number) => 0.55 * Math.sin(phi);
  const knee = (phi: number) => 0.15 + 0.65 * Math.max(0, Math.cos(phi));
  const p = rest();
  p.hipR = hip(phiR);
  p.hipL = hip(phiL);
  p.kneeR = knee(phiR);
  p.kneeL = knee(phiL);
  p.pelvisDy = -0.012 * (1 + Math.cos(2 * phiR)) * 0.5;
  p.lean = 0.06;
  p.shoulderR = -0.35 * Math.sin(phiR);
  p.shoulderL = -0.35 * Math.sin(phiL);
  p.elbowR = 0.3;
  p.elbowL = 0.3;
  return p;
}

/** Run: the same phase machinery as walk, with bigger amplitudes, a real forward lean, bent elbows, and airborne moments at the passing poses. */
function runParams(t: number): FrameParams {
  const phiR = TAU * t;
  const phiL = phiR + Math.PI;
  const hip = (phi: number) => 0.85 * Math.sin(phi);
  const knee = (phi: number) => 0.35 + 1.15 * Math.max(0, Math.cos(phi));
  const p = rest();
  p.hipR = hip(phiR);
  p.hipL = hip(phiL);
  p.kneeR = knee(phiR);
  p.kneeL = knee(phiL);
  // Bob twice per cycle plus a flight lift at each passing pose — running is
  // the gait where both feet leave the ground.
  const flight = Math.max(0, Math.cos(2 * phiR));
  p.pelvisDy = -0.014 * (1 + Math.cos(2 * phiR)) * 0.5 - 0.03 * flight * flight;
  p.lean = 0.22;
  p.shoulderR = -0.7 * Math.sin(phiR);
  p.shoulderL = -0.7 * Math.sin(phiL);
  p.elbowR = 1.25;
  p.elbowL = 1.25;
  return p;
}

/** Idle: feet nailed to the ground; only the torso breathes. */
function idleParams(t: number): FrameParams {
  const s = Math.sin(TAU * t);
  const p = rest();
  p.hipR = 0.04;
  p.hipL = -0.04;
  p.breathDy = -0.005 * (1 + s) * 0.5;
  p.shoulderR = 0.03 * s;
  p.shoulderL = 0.03 * s;
  return p;
}

/** Jump (one-shot): crouch, launch, tucked flight with the apex past midway, landing absorb, settle. */
function jumpParams(u: number): FrameParams {
  const p = rest();
  const knee = track(
    [
      [0, 0.1],
      [0.28, 1.1],
      [0.45, 0.2],
      [0.62, 0.95],
      [0.78, 0.95],
      [0.9, 1.05],
      [1, 0.15],
    ],
    u,
  );
  p.kneeR = knee;
  p.kneeL = knee * 0.92; // legs never perfectly identical — reads as stiff
  p.pelvisDy = track(
    [
      [0, 0],
      [0.28, 0.05],
      [0.45, -0.03],
      [0.62, -0.1],
      [0.78, -0.03],
      [0.9, 0.04],
      [1, 0],
    ],
    u,
  );
  const arm = track(
    [
      [0, 0],
      [0.28, -0.8],
      [0.45, 0.6],
      [0.62, 1.3],
      [0.78, 0.7],
      [1, 0.1],
    ],
    u,
  );
  p.shoulderR = arm;
  p.shoulderL = arm * 0.9;
  p.elbowR = 0.25;
  p.elbowL = 0.25;
  p.lean = track(
    [
      [0, 0.05],
      [0.28, 0.25],
      [0.62, 0.05],
      [1, 0.05],
    ],
    u,
  );
  return p;
}

/** Attack (one-shot): planted lunge stance; the striking arm winds up behind, whips forward, recovers. */
function attackParams(u: number): FrameParams {
  const p = rest();
  p.hipR = 0.3;
  p.hipL = -0.25;
  p.kneeR = 0.28;
  p.kneeL = 0.16;
  p.shoulderR = track(
    [
      [0, 0.2],
      [0.3, -1.9],
      [0.45, -1.9],
      [0.6, 1.5],
      [0.8, 1.1],
      [1, 0.3],
    ],
    u,
  );
  p.elbowR = track(
    [
      [0, 0.4],
      [0.3, 1.4],
      [0.45, 1.3],
      [0.6, 0.1],
      [0.8, 0.3],
      [1, 0.4],
    ],
    u,
  );
  p.shoulderL = track(
    [
      [0, 0],
      [0.3, 0.5],
      [0.6, -0.45],
      [1, 0],
    ],
    u,
  );
  p.elbowL = 0.4;
  p.lean = track(
    [
      [0, 0.05],
      [0.3, -0.12],
      [0.55, 0.28],
      [1, 0.08],
    ],
    u,
  );
  p.torsoDx = track(
    [
      [0, 0],
      [0.3, -0.02],
      [0.55, 0.05],
      [1, 0.01],
    ],
    u,
  );
  return p;
}

const CLIP_FNS: Record<ClipId, { fn: (t: number) => FrameParams; loops: boolean }> = {
  walk: { fn: walkParams, loops: true },
  run: { fn: runParams, loops: true },
  idle: { fn: idleParams, loops: true },
  jump: { fn: jumpParams, loops: false },
  attack: { fn: attackParams, loops: false },
};

/** Aliases from the sprite subjects' animation slots to a skeleton clip. */
const CLIP_ALIASES: Record<string, ClipId> = {
  walk: 'walk',
  walking: 'walk',
  climb: 'walk',
  swim: 'walk',
  run: 'run',
  running: 'run',
  dash: 'run',
  sprint: 'run',
  charge: 'run',
  idle: 'idle',
  stand: 'idle',
  breathe: 'idle',
  taunt: 'idle',
  victory: 'idle',
  jump: 'jump',
  leap: 'jump',
  hop: 'jump',
  fall: 'jump',
  land: 'jump',
  attack: 'attack',
  attack2: 'attack',
  swing: 'attack',
  strike: 'attack',
  slash: 'attack',
  thrust: 'attack',
  punch: 'attack',
  kick: 'attack',
  shoot: 'attack',
  cast: 'attack',
  bite: 'attack',
};

/**
 * Map a Genvy animation slot to a skeleton clip. `exact: false` means the
 * action has no purpose-built cycle and fell back to idle — callers should
 * lean on the text prompt for the motion in that case.
 */
export function resolveClip(action: string): { clip: ClipId; exact: boolean } {
  const mapped = CLIP_ALIASES[action.trim().toLowerCase()];
  return mapped ? { clip: mapped, exact: true } : { clip: 'idle', exact: false };
}

// ------------------------------------------------------- view construction

interface Vec {
  x: number;
  y: number;
}

const kp = (x: number, y: number, visible = true): Keypoint => ({ x, y, visible });

/**
 * Profile view (east: facing +x). Forward kinematics from the pelvis: legs
 * hang from the hips by hip angle then knee flexion (which only ever bends
 * the lower leg BACKWARD); arms hang from the shoulders likewise (elbows
 * bend forward). The right side is the near side.
 */
function buildProfile(p: FrameParams): Keypoint[] {
  const pelvis: Vec = { x: 0.5, y: PELVIS_BASE_Y + p.pelvisDy };
  const upperDy = p.breathDy;
  const neck: Vec = {
    x: pelvis.x + TORSO * Math.sin(p.lean) + p.torsoDx,
    y: pelvis.y - TORSO * Math.cos(p.lean) + upperDy,
  };
  const nose: Vec = {
    x: neck.x + NECK_HEAD * Math.sin(p.lean) + 0.045 * H,
    y: neck.y - NECK_HEAD * Math.cos(p.lean) - 0.02 * H,
  };

  const leg = (hipAngle: number, kneeFlex: number, depth: number) => {
    const hip: Vec = { x: pelvis.x + depth, y: pelvis.y };
    const knee: Vec = {
      x: hip.x + LEG_UPPER * Math.sin(hipAngle),
      y: hip.y + LEG_UPPER * Math.cos(hipAngle),
    };
    const shin = hipAngle - kneeFlex;
    const ankle: Vec = {
      x: knee.x + LEG_LOWER * Math.sin(shin),
      y: knee.y + LEG_LOWER * Math.cos(shin),
    };
    return { hip, knee, ankle };
  };
  const arm = (shoulderAngle: number, elbowFlex: number, depth: number) => {
    const shoulder: Vec = { x: neck.x + depth, y: neck.y + 0.02 * H };
    const elbow: Vec = {
      x: shoulder.x + ARM_UPPER * Math.sin(shoulderAngle),
      y: shoulder.y + ARM_UPPER * Math.cos(shoulderAngle),
    };
    const fore = shoulderAngle + elbowFlex;
    const wrist: Vec = {
      x: elbow.x + ARM_LOWER * Math.sin(fore),
      y: elbow.y + ARM_LOWER * Math.cos(fore),
    };
    return { shoulder, elbow, wrist };
  };

  const legR = leg(p.hipR, p.kneeR, DEPTH);
  const legL = leg(p.hipL, p.kneeL, -DEPTH);
  const armR = arm(p.shoulderR, p.elbowR, DEPTH);
  const armL = arm(p.shoulderL, p.elbowL, -DEPTH);

  const out: Keypoint[] = new Array(KEYPOINT_COUNT);
  out[KP.nose] = kp(nose.x, nose.y);
  out[KP.neck] = kp(neck.x, neck.y);
  out[KP.rShoulder] = kp(armR.shoulder.x, armR.shoulder.y);
  out[KP.rElbow] = kp(armR.elbow.x, armR.elbow.y);
  out[KP.rWrist] = kp(armR.wrist.x, armR.wrist.y);
  out[KP.lShoulder] = kp(armL.shoulder.x, armL.shoulder.y);
  out[KP.lElbow] = kp(armL.elbow.x, armL.elbow.y);
  out[KP.lWrist] = kp(armL.wrist.x, armL.wrist.y);
  out[KP.rHip] = kp(legR.hip.x, legR.hip.y);
  out[KP.rKnee] = kp(legR.knee.x, legR.knee.y);
  out[KP.rAnkle] = kp(legR.ankle.x, legR.ankle.y);
  out[KP.lHip] = kp(legL.hip.x, legL.hip.y);
  out[KP.lKnee] = kp(legL.knee.x, legL.knee.y);
  out[KP.lAnkle] = kp(legL.ankle.x, legL.ankle.y);
  // Profile facing right: only the near (right) eye and ear are visible.
  out[KP.rEye] = kp(nose.x - 0.015 * H, nose.y - 0.03 * H);
  out[KP.lEye] = kp(nose.x, nose.y, false);
  out[KP.rEar] = kp(neck.x - 0.01 * H, nose.y - 0.02 * H);
  out[KP.lEar] = kp(neck.x, nose.y, false);
  return out;
}

/**
 * Frontal view (south faces the camera, north is the back). Leg motion reads
 * as foot lifts: the ankle hangs below the hip by a length shortened by knee
 * flexion, clamped to the ground — so stance legs stay planted and swing legs
 * lift, with the same anti-phase the profile view has. `side` fixes which
 * screen side the character's right is on (south: viewer's left).
 */
function buildFrontal(p: FrameParams, view: 'south' | 'north'): Keypoint[] {
  // Facing the camera, the character's right hand is on the viewer's LEFT.
  const s = view === 'south' ? -1 : 1;
  const sway = 0.35 * (p.hipR - p.hipL) * 0.02;
  const pelvis: Vec = { x: 0.5 + sway, y: PELVIS_BASE_Y + p.pelvisDy };
  const upperDy = p.breathDy;
  const neck: Vec = { x: pelvis.x + s * p.torsoDx, y: pelvis.y - TORSO + upperDy };
  const nose: Vec = { x: neck.x, y: neck.y - NECK_HEAD };

  const legLen = LEG_UPPER + LEG_LOWER;
  const leg = (kneeFlex: number, side: number) => {
    const hip: Vec = { x: pelvis.x + side * HIP_HALF, y: pelvis.y };
    // Lift measures flex ABOVE the relaxed stance flex (~0.2 rad), so a
    // standing leg reads as planted instead of hovering a few pixels up.
    const flexNorm = Math.min(1, Math.max(0, kneeFlex - 0.2) / 1.4);
    const hang = legLen * (1 - 0.45 * flexNorm);
    const ankleY = Math.min(hip.y + hang, GROUND);
    const reach = ankleY - hip.y;
    const knee: Vec = {
      x: hip.x + side * 0.03 * H * flexNorm,
      y: hip.y + Math.min(LEG_UPPER * (1 - 0.3 * flexNorm), reach * 0.55),
    };
    return { hip, knee, ankle: { x: hip.x, y: ankleY } };
  };
  const arm = (shoulderAngle: number, elbowFlex: number, side: number) => {
    const shoulder: Vec = { x: neck.x + side * SHOULDER_HALF, y: neck.y + 0.02 * H };
    // Fore/back swing reads as a vertical wrist shift plus a slight outward drift.
    const swing = Math.sin(shoulderAngle);
    const elbow: Vec = {
      x: shoulder.x + side * 0.015 * H,
      y: shoulder.y + ARM_UPPER * (1 - 0.15 * Math.abs(swing)),
    };
    const lift = ARM_LOWER * (0.5 * Math.abs(swing) + 0.85 * Math.min(1, elbowFlex / 1.6));
    const wrist: Vec = {
      x: elbow.x + side * 0.012 * H,
      y: elbow.y + ARM_LOWER - lift,
    };
    return { shoulder, elbow, wrist };
  };

  const legR = leg(p.kneeR, s);
  const legL = leg(p.kneeL, -s);
  const armR = arm(p.shoulderR, p.elbowR, s);
  const armL = arm(p.shoulderL, p.elbowL, -s);

  const front = view === 'south';
  const out: Keypoint[] = new Array(KEYPOINT_COUNT);
  out[KP.nose] = kp(nose.x, nose.y, front);
  out[KP.neck] = kp(neck.x, neck.y);
  out[KP.rShoulder] = kp(armR.shoulder.x, armR.shoulder.y);
  out[KP.rElbow] = kp(armR.elbow.x, armR.elbow.y);
  out[KP.rWrist] = kp(armR.wrist.x, armR.wrist.y);
  out[KP.lShoulder] = kp(armL.shoulder.x, armL.shoulder.y);
  out[KP.lElbow] = kp(armL.elbow.x, armL.elbow.y);
  out[KP.lWrist] = kp(armL.wrist.x, armL.wrist.y);
  out[KP.rHip] = kp(legR.hip.x, legR.hip.y);
  out[KP.rKnee] = kp(legR.knee.x, legR.knee.y);
  out[KP.rAnkle] = kp(legR.ankle.x, legR.ankle.y);
  out[KP.lHip] = kp(legL.hip.x, legL.hip.y);
  out[KP.lKnee] = kp(legL.knee.x, legL.knee.y);
  out[KP.lAnkle] = kp(legL.ankle.x, legL.ankle.y);
  out[KP.rEye] = kp(nose.x + s * 0.02 * H, nose.y - 0.02 * H, front);
  out[KP.lEye] = kp(nose.x - s * 0.02 * H, nose.y - 0.02 * H, front);
  out[KP.rEar] = kp(nose.x + s * 0.045 * H, nose.y - 0.015 * H);
  out[KP.lEar] = kp(nose.x - s * 0.045 * H, nose.y - 0.015 * H);
  return out;
}

/** West is the MIRROR of east — position flip plus left/right relabel — never a rotation (spriteSubjects.deriveOp encodes the same law). */
function mirrorFrame(frame: Keypoint[]): Keypoint[] {
  const out: Keypoint[] = new Array(KEYPOINT_COUNT);
  for (let i = 0; i < KEYPOINT_COUNT; i++) {
    const src = frame[MIRROR_INDEX[i]!]!;
    out[i] = { x: 1 - src.x, y: src.y, visible: src.visible };
  }
  return out;
}

/**
 * Generate the skeleton frames for one clip. Frames are normalized [0,1]
 * keypoints; render them with `renderSkeleton`/`skeletonFramePng`.
 */
export function clipSkeleton(req: ClipRequest): SkeletonFrame[] {
  const frames = Math.max(1, Math.floor(req.frames));
  const facing = req.facing ?? 'east';
  const { clip } = resolveClip(req.clip);
  const { fn, loops } = CLIP_FNS[clip];
  const out: SkeletonFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const t = loops ? i / frames : frames === 1 ? 0 : i / (frames - 1);
    const p = fn(t);
    let keypoints: Keypoint[];
    if (facing === 'south' || facing === 'north') keypoints = buildFrontal(p, facing);
    else if (facing === 'east') keypoints = buildProfile(p);
    else keypoints = mirrorFrame(buildProfile(p));
    out.push({ keypoints });
  }
  return out;
}
