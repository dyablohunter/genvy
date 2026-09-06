import sharp from 'sharp';
import { LIMBS, LIMB_COLORS, JOINT_COLORS, KEYPOINT_COUNT } from './coco.js';
import type { Keypoint, SkeletonFrame } from './clips.js';

/**
 * Rasterize skeleton frames to OpenPose-style conditioning images: colored
 * limb strokes and joint dots on pure black. Pure integer stamping — no
 * canvas, no anti-aliasing, byte-for-byte deterministic — then PNG-encoded
 * with sharp.
 */

export interface RenderOptions {
  /** Square canvas side in pixels (default 768 — the ~12GB SDXL sweet spot). */
  size?: number;
  /** Stroke thickness in px; defaults to size/96 (8px at 768). */
  lineWidth?: number;
  /** Joint dot radius in px; defaults to lineWidth. */
  jointRadius?: number;
}

export interface RawRgb {
  data: Buffer; // RGB, 3 channels
  width: number;
  height: number;
}

function stampDisc(img: RawRgb, cx: number, cy: number, r: number, rgb: readonly [number, number, number]) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * img.width + x) * 3;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
    }
  }
}

function stampLine(
  img: RawRgb,
  a: Keypoint,
  b: Keypoint,
  halfWidth: number,
  rgb: readonly [number, number, number],
) {
  const ax = a.x * img.width;
  const ay = a.y * img.height;
  const bx = b.x * img.width;
  const by = b.y * img.height;
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / Math.max(1, halfWidth * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const k = s / steps;
    stampDisc(img, ax + (bx - ax) * k, ay + (by - ay) * k, halfWidth, rgb);
  }
}

/** Draw one frame to a raw RGB buffer (black background). */
export function renderSkeleton(frame: SkeletonFrame, opts: RenderOptions = {}): RawRgb {
  const size = opts.size ?? 768;
  const lineWidth = opts.lineWidth ?? Math.max(2, Math.round(size / 96));
  const jointRadius = opts.jointRadius ?? lineWidth;
  if (frame.keypoints.length !== KEYPOINT_COUNT) {
    throw new Error(`Skeleton frame must have ${KEYPOINT_COUNT} keypoints, got ${frame.keypoints.length}`);
  }
  const img: RawRgb = { data: Buffer.alloc(size * size * 3), width: size, height: size };
  LIMBS.forEach(([ai, bi], li) => {
    const a = frame.keypoints[ai]!;
    const b = frame.keypoints[bi]!;
    if (!a.visible || !b.visible) return;
    stampLine(img, a, b, lineWidth / 2, LIMB_COLORS[li]!);
  });
  frame.keypoints.forEach((k, i) => {
    if (!k.visible) return;
    stampDisc(img, k.x * size, k.y * size, jointRadius, JOINT_COLORS[i]!);
  });
  return img;
}

/** One frame as a PNG buffer. */
export async function skeletonFramePng(frame: SkeletonFrame, opts: RenderOptions = {}): Promise<Buffer> {
  const raw = renderSkeleton(frame, opts);
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 3 } })
    .png()
    .toBuffer();
}

/** All frames side by side in one horizontal strip PNG — the free preview of what will condition the diffusion pass. */
export async function skeletonStripPng(frames: SkeletonFrame[], opts: RenderOptions = {}): Promise<Buffer> {
  const size = opts.size ?? 768;
  const rendered = frames.map((f) => renderSkeleton(f, opts));
  const strip = Buffer.alloc(size * size * frames.length * 3);
  const rowBytes = size * 3;
  const stripRowBytes = rowBytes * frames.length;
  rendered.forEach((img, fi) => {
    for (let y = 0; y < size; y++) {
      img.data.copy(strip, y * stripRowBytes + fi * rowBytes, y * rowBytes, (y + 1) * rowBytes);
    }
  });
  return sharp(strip, { raw: { width: size * frames.length, height: size, channels: 3 } })
    .png()
    .toBuffer();
}
