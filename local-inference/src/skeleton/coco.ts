/**
 * COCO-18 keypoint layout as OpenPose emits it — the layout the SDXL OpenPose
 * ControlNet was trained on, so the indices, the limb pairs AND the exact
 * rainbow palette below are load-bearing: a skeleton drawn with different
 * colors conditions noticeably worse.
 */

export const KP = {
  nose: 0,
  neck: 1,
  rShoulder: 2,
  rElbow: 3,
  rWrist: 4,
  lShoulder: 5,
  lElbow: 6,
  lWrist: 7,
  rHip: 8,
  rKnee: 9,
  rAnkle: 10,
  lHip: 11,
  lKnee: 12,
  lAnkle: 13,
  rEye: 14,
  lEye: 15,
  rEar: 16,
  lEar: 17,
} as const;

export type KeypointName = keyof typeof KP;

export const KEYPOINT_COUNT = 18;

/** Limb pairs in OpenPose drawing order (17 segments). */
export const LIMBS: ReadonlyArray<readonly [number, number]> = [
  [KP.neck, KP.rShoulder],
  [KP.neck, KP.lShoulder],
  [KP.rShoulder, KP.rElbow],
  [KP.rElbow, KP.rWrist],
  [KP.lShoulder, KP.lElbow],
  [KP.lElbow, KP.lWrist],
  [KP.neck, KP.rHip],
  [KP.rHip, KP.rKnee],
  [KP.rKnee, KP.rAnkle],
  [KP.neck, KP.lHip],
  [KP.lHip, KP.lKnee],
  [KP.lKnee, KP.lAnkle],
  [KP.neck, KP.nose],
  [KP.nose, KP.rEye],
  [KP.rEye, KP.rEar],
  [KP.nose, KP.lEye],
  [KP.lEye, KP.lEar],
];

type Rgb = readonly [number, number, number];

/** OpenPose rainbow, one color per limb segment (index-matched to LIMBS). */
export const LIMB_COLORS: ReadonlyArray<Rgb> = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
];

/** One color per joint (index-matched to KP order). */
export const JOINT_COLORS: ReadonlyArray<Rgb> = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85],
];

/**
 * Index map that swaps every left keypoint with its right twin. Mirroring a
 * skeleton is a position flip PLUS this relabel — flipping positions alone
 * would leave "right" limbs drawn on the left, and the ControlNet reads the
 * colors, so a wrong label is a wrong pose.
 */
export const MIRROR_INDEX: ReadonlyArray<number> = (() => {
  const map = Array.from({ length: KEYPOINT_COUNT }, (_, i) => i);
  const swap = (a: number, b: number) => {
    map[a] = b;
    map[b] = a;
  };
  swap(KP.rShoulder, KP.lShoulder);
  swap(KP.rElbow, KP.lElbow);
  swap(KP.rWrist, KP.lWrist);
  swap(KP.rHip, KP.lHip);
  swap(KP.rKnee, KP.lKnee);
  swap(KP.rAnkle, KP.lAnkle);
  swap(KP.rEye, KP.lEye);
  swap(KP.rEar, KP.lEar);
  return map;
})();
