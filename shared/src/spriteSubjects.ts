/**
 * What a sprite can BE. Sprite Forge animates far more than characters, and
 * the prompts read badly (and generate badly) when a treasure chest is called
 * a "character" — so every subject carries the noun the prompts should use,
 * what its neutral anchor means, whether directional anchors are meaningful,
 * and the animation slots worth offering for it.
 */
/** The four sprite facings; east is always a free mirror of west (or back). */
export type AnchorView = 'south' | 'west' | 'east' | 'north';

export interface SpriteSubject {
  id: string;
  /** Shown in the UI picker. */
  label: string;
  /** Singular noun the image prompts use. */
  noun: string;
  plural: string;
  /** What "neutral anchor" means for this kind of thing. */
  anchorPose: string;
  /** Whether west/north/east anchors make sense (a coin has no back view). */
  directional: boolean;
  /**
   * The view the FIRST anchor is drawn in. Characters face the camera; a
   * weapon or projectile is drawn in side profile pointing right, so calling
   * that a "south" anchor and then asking for its back view is nonsense.
   */
  primaryView: AnchorView;
  /** Every view worth having. Opposite sides are mirrored for free. */
  views: AnchorView[];
  /**
   * How the non-primary views are made. 'derive' means every view is a free
   * transform of the primary — a gun aiming up is the side view rotated, not a
   * new drawing. 'generate' is for things with a real front and back (a
   * character's face and spine are different pictures).
   */
  derivation: 'derive' | 'generate';
  /** Animation slots offered in the preset list. */
  animations: string[];
}

export const SPRITE_SUBJECTS: SpriteSubject[] = [
  {
    id: 'character',
    label: 'Character',
    noun: 'character',
    plural: 'characters',
    anchorPose:
      'standing upright at rest, neutral confident stance, arms relaxed, hands empty',
    directional: true,
    primaryView: 'south',
    views: ['south', 'west', 'east', 'north'],
    derivation: 'generate',
    animations: [
      'idle', 'walk', 'run', 'jump', 'fall', 'land', 'crouch', 'dash', 'roll',
      'climb', 'swim', 'attack', 'attack2', 'shoot', 'cast', 'block', 'hurt',
      'death', 'spawn', 'victory', 'taunt',
    ],
  },
  {
    id: 'creature',
    label: 'Creature / Monster',
    noun: 'creature',
    plural: 'creatures',
    anchorPose: 'standing at rest in its natural neutral stance, no attack posture',
    directional: true,
    primaryView: 'south',
    views: ['south', 'west', 'east', 'north'],
    derivation: 'generate',
    animations: [
      'idle', 'walk', 'run', 'fly', 'attack', 'bite', 'charge', 'hurt', 'death',
      'spawn', 'roar', 'burrow',
    ],
  },
  {
    id: 'vehicle',
    label: 'Vehicle',
    noun: 'vehicle',
    plural: 'vehicles',
    anchorPose: 'parked at rest, level, engine idle, no motion effects',
    directional: true,
    primaryView: 'south',
    views: ['south', 'west', 'east', 'north'],
    derivation: 'generate',
    animations: [
      'idle', 'drive', 'accelerate', 'brake', 'turn', 'boost', 'damaged',
      'explode', 'spawn',
    ],
  },
  {
    id: 'prop',
    label: 'Prop / Object',
    noun: 'prop',
    plural: 'props',
    anchorPose: 'at rest and undisturbed, in its closed or default state',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['idle', 'open', 'close', 'shake', 'hit', 'break', 'activate', 'topple'],
  },
  {
    id: 'pickup',
    label: 'Pickup / Collectible',
    noun: 'pickup',
    plural: 'pickups',
    anchorPose: 'resting in its default presentation, facing the camera',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['idle', 'spin', 'bob', 'shine', 'collect', 'spawn', 'despawn'],
  },
  {
    id: 'weapon',
    label: 'Weapon',
    noun: 'weapon',
    plural: 'weapons',
    anchorPose: 'held level at rest, blade or barrel horizontal, no effects',
    directional: false,
    primaryView: 'east',
    views: ['east', 'west', 'north', 'south'],
    derivation: 'derive',
    animations: ['idle', 'swing', 'thrust', 'charge', 'fire', 'reload', 'recoil', 'impact'],
  },
  {
    id: 'projectile',
    label: 'Projectile',
    noun: 'projectile',
    plural: 'projectiles',
    anchorPose: 'in flight, level, travelling toward the right, no trail',
    directional: true,
    primaryView: 'east',
    views: ['east', 'west', 'north', 'south'],
    derivation: 'derive',
    animations: ['travel', 'spawn', 'charge', 'impact', 'dissipate', 'ricochet'],
  },
  {
    id: 'effect',
    label: 'Effect / VFX',
    noun: 'effect',
    plural: 'effects',
    anchorPose: 'at its first faint moment, before it grows',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['burst', 'buildup', 'loop', 'impact', 'dissipate', 'aura', 'trail'],
  },
  {
    id: 'environment',
    label: 'Environment piece',
    noun: 'environment piece',
    plural: 'environment pieces',
    anchorPose: 'standing still and undisturbed, no wind or motion',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['idle', 'sway', 'flicker', 'flow', 'grow', 'crumble', 'burn'],
  },
  {
    id: 'hazard',
    label: 'Hazard / Trap',
    noun: 'hazard',
    plural: 'hazards',
    anchorPose: 'in its safe, retracted, un-triggered state',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['idle', 'arm', 'trigger', 'active', 'reset', 'damage'],
  },
  {
    id: 'machine',
    label: 'Machine / Device',
    noun: 'machine',
    plural: 'machines',
    anchorPose: 'powered down at rest, panels closed, no lights or effects',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['idle', 'power_up', 'working', 'open', 'close', 'jam', 'shutdown', 'break'],
  },
  {
    id: 'ui',
    label: 'UI element',
    noun: 'UI element',
    plural: 'UI elements',
    anchorPose: 'in its default resting state, unpressed and unselected',
    directional: false,
    primaryView: 'south',
    views: ['south'],
    derivation: 'derive',
    animations: ['idle', 'hover', 'press', 'disabled', 'appear', 'dismiss', 'pulse'],
  },
];

export const DEFAULT_SUBJECT_ID = 'character';

export function getSubject(id?: string): SpriteSubject {
  return SPRITE_SUBJECTS.find((s) => s.id === id) ?? SPRITE_SUBJECTS[0]!;
}

/** The mirror of a view, when it has one (east<->west). */
export function mirrorView(view: AnchorView): AnchorView | null {
  return view === 'west' ? 'east' : view === 'east' ? 'west' : null;
}

export interface ViewDerivation {
  from: AnchorView;
  /** Mirror horizontally first (handedness differs between the two views). */
  mirror: boolean;
  /** Clockwise turn applied after the mirror. */
  degrees: number;
}

/**
 * A facing has two parts: how far the sprite is turned, and whether it is
 * mirrored. WEST is the MIRROR of east, not a 180° rotation — rotating a gun
 * half a turn leaves it pointing left but hanging upside down. North and south
 * are quarter turns of the unmirrored drawing.
 */
const VIEW_ANGLE: Record<AnchorView, number> = { east: 0, west: 0, south: 90, north: 270 };
const VIEW_MIRRORED: Record<AnchorView, boolean> = {
  east: false,
  west: true,
  south: false,
  north: false,
};

/**
 * How to turn `from` into `to` with free transforms. Mirroring negates the
 * turn already baked into the source, so the two cases compose differently.
 */
export function deriveOp(from: AnchorView, to: AnchorView): ViewDerivation | null {
  if (from === to) return null;
  const mirror = VIEW_MIRRORED[from] !== VIEW_MIRRORED[to];
  const degrees = mirror
    ? (VIEW_ANGLE[to] + VIEW_ANGLE[from]) % 360
    : (VIEW_ANGLE[to] - VIEW_ANGLE[from] + 360) % 360;
  return { from, mirror, degrees };
}
