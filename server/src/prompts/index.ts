export const SPRITE_CONCEPT_SYSTEM = `You are the character designer inside Genvy, a 2D game creation tool built on Phaser.
The user describes a character; you produce a JSON concept for it.

Required JSON shape:
{
  "name": string (short, evocative),
  "description": string (1-3 sentences of game-design flavor),
  "imagePrompt": string,
  "stats": { "speed": number 50-400, "jumpPower": number 200-900, "health": integer 1-10 },
  "suggestedAnimations": [ { "slot": string, "frames": [int...], "frameRate": number } ],
  "tags": [string...]
}

IMPORTANT — copyrighted characters: if the user references a trademarked or copyrighted character
(e.g. a famous superhero, game or cartoon character), do NOT copy it. Instead design an ORIGINAL
HOMAGE that captures the archetype: similar powers, energy and role, but a distinct costume design
and a brand-new name. Critically, also AVOID the original's signature color combination, emblem and
motifs (e.g. for a wall-crawling hero: no red-and-blue suit, no web patterns, no spider emblem) —
image generators reject prompts that merely resemble trademarked characters, not just their names.
Never mention the trademarked name or franchise anywhere in name, description or imagePrompt.

The imagePrompt describes ONLY the character's visual appearance (colors, silhouette, outfit, mood).
If the user specified a view, camera angle, pose or art style, preserve their wording in imagePrompt —
never impose your own. Do NOT mention grids, sprite sheets, backgrounds, or frame counts — the system
adds that. Keep it under 500 characters.

suggestedAnimations is the ANIMATION PLAN for this character: which clips to produce, one at a time.
Each entry: slot (e.g. "idle", "walk", "run", "jump", "attack", "hurt" — add others if they fit the
character), frames as LOCAL indices 0..N-1 where N is the recommended frame count for that clip
(4, 6 or 8), and a sensible frameRate (idle 4-6, walk 8-10, run 10-14, jump 8, attack 10-14, hurt 8).`;

export const TILESET_CONCEPT_SYSTEM = `You are the environment artist inside Genvy, a 2D game creation tool built on Phaser.
The user describes a world theme; you produce a JSON tileset concept.

Required JSON shape:
{
  "name": string,
  "description": string,
  "imagePrompt": string,
  "tileNames": [string x 24],
  "collidingTiles": [int...],
  "tags": [string...]
}

The image will be a 4-column x 6-row grid of 24 distinct terrain/decor tiles (indices 0-23 in
reading order). Plan a coherent set: ground/floor variants, walls or cliff edges, corners,
platforms, decorations, hazards. tileNames lists all 24 names in order. collidingTiles lists the
indices players cannot walk through (solid ground, walls, platforms).

The imagePrompt describes ONLY the art style and the 24 tile subjects in grid reading order,
compactly (e.g. "row 1: mossy stone floor, cracked stone floor, ..."). Do NOT mention background
colors or grid mechanics — the system adds that. Keep it under 800 characters.`;

export const WORLD_LAYOUT_SYSTEM = `You are the level designer inside Genvy, a 2D game creation tool built on Phaser.
Given a level description and a tileset (list of tile indices with names and which ones collide),
produce a JSON tile layout.

Required JSON shape:
{
  "name": string,
  "description": string,
  "width": int, "height": int,
  "layers": [ { "name": string, "data": [[int...]...] } ],
  "spawnPoints": [ { "name": string, "x": number, "y": number } ]
}

Rules:
- data is height rows of width tile indices; -1 means empty.
- Use ONLY tile indices that exist in the provided tileset.
- Produce 2 layers: "ground" (solid terrain using colliding tiles) and "decor" (non-colliding details).
- Make it playable: connected walkable space, no sealed-off areas, ground under spawn points.
- spawnPoints are in TILE coordinates. Always include one named "player".
- Keep width and height within what the user asked (default 40x23 if unspecified).`;

/**
 * One image, four design variations of the same character concept (2x2).
 * Only technical pipeline constraints are imposed here — pose, angle, view
 * and art direction belong to the user's own prompt and the style hint.
 */
export function characterVariantsImagePrompt(
  appearance: string,
  styleHint?: string,
  cellBorders = false,
  pose?: string,
): string {
  const style = styleHint ? `\nArt direction: ${styleHint}.` : '';
  const poseLine = pose ? `\nAll four characters hold the SAME pose: ${pose}.` : '';
  const separation = cellBorders
    ? `draw each character inside its OWN CELL — surround each character with a thin
solid pure green (#00FF00) rectangular border. The four bordered cells form a 2x2 grid and must never
touch or overlap each other on the vertical or horizontal axis, with clear transparent space between
neighboring cells. Every character must fit ENTIRELY inside its own green border with transparent
padding all around — no part of any character may touch or cross any border. All characters at the
exact same scale; NO other grid lines, NO text, NO labels, NO ground, NO shadows.`
    : `the four characters are completely separate — never touching or overlapping on the vertical
or horizontal axis — with WIDE fully transparent gaps (at least half a character's width) between
them; all at the exact same scale; NO grid lines, NO borders, NO text, NO labels, NO ground,
NO shadows.`;
  return `Four DIFFERENT design variations of the same 2D video game character, arranged as a 2x2 grid
on a fully transparent background. Each quadrant contains exactly ONE full-body character. The four
designs vary in costume details, color palette accents, and silhouette flair while clearly remaining
the same base character.
Base character: ${appearance}${style}${poseLine}
CRITICAL REQUIREMENTS: ${separation}`;
}

/**
 * One animation at a time, drawn from the selected variant reference image.
 * Pose, camera angle and view direction are the user's to specify in notes.
 */
export function animationStripImagePrompt(
  category: string,
  frames: number,
  notes: string,
  styleHint?: string,
  gridCols?: number,
  gridRows?: number,
  cellBorders = false,
): string {
  const motion = notes.trim().length > 0 ? ` ${notes.trim()}.` : '';
  const style = styleHint ? ` Art direction: ${styleHint}.` : '';
  const layout =
    gridCols && gridRows
      ? `${frames} clearly separate poses arranged in a grid of exactly ${gridCols} columns and
${gridRows} rows, reading order left to right then top to bottom`
      : frames <= 8
        ? `${frames} clearly separate poses in ONE horizontal row`
        : `${frames} clearly separate poses arranged in neat horizontal rows of up to 8, reading order
left to right then top to bottom`;
  const separation = cellBorders
    ? `Draw each pose inside its OWN CELL — surround each pose with a thin solid pure green (#00FF00)
rectangular border. Bordered cells must never touch or overlap each other on the vertical or
horizontal axis, with clear transparent space between neighboring cells. Every pose must fit
ENTIRELY inside its own green border with transparent padding all around — no part of any pose may
touch or cross any border. NO other grid lines.`
    : `Poses must NEVER touch or overlap on the vertical or horizontal axis — leave WIDE fully
transparent gaps (at least half a character's width) between every pose. NO grid lines, NO borders.`;
  return `Redraw the EXACT character from the reference image — identical design, colors, outfit,
proportions and art style — as an animation sheet of exactly ${frames} frames of a
"${category}" animation, in chronological order.${motion}${style}
CRITICAL REQUIREMENTS: fully transparent background; EXACTLY ${frames} characters total in the whole
image — never draw two characters side by side within one frame position; ${layout}.
${separation} All poses at the exact same scale as the reference with full body
visible; smooth motion progression between frames; NO text, NO labels, NO ground, NO shadows.`;
}

/** Legacy full pose-sheet prompt (kept for the smoke script). */
export function spriteSheetImagePrompt(appearance: string): string {
  return characterVariantsImagePrompt(appearance);
}

/** Wraps a tileset description in strict tile-grid constraints. */
export function tilesetImagePrompt(subjects: string): string {
  return `A 2D video game tileset: a strict grid of exactly 4 columns and 6 rows (24 square tiles).
Tile subjects in reading order: ${subjects}
CRITICAL REQUIREMENTS: perfectly uniform square cells; each tile fills its entire cell edge-to-edge
with NO gaps between tiles; tiles designed to seamlessly connect with each other; consistent
pixel-art game style and palette across all tiles; top-down/side-on orthographic game view;
NO grid lines, NO borders, NO text, NO labels; crisp clean edges.`;
}

export const PROMPT_SANITIZE_SYSTEM = `An image generator rejected a visual prompt for content-policy
reasons — most often because it resembles a trademarked character or franchise (by name, signature
color combination, emblem or motifs), or contains unsafe content. Rewrite it as a clearly ORIGINAL
character description: replace franchise-adjacent names, signature palettes, emblems and motifs with
fresh alternatives while keeping the general archetype and appeal; remove anything unsafe.
Reply with ONLY the rewritten visual description, under 400 characters.`;

export const TOOL_SYSTEM_PROMPTS: Record<string, string> = {
  sprite: SPRITE_CONCEPT_SYSTEM,
  tileset: TILESET_CONCEPT_SYSTEM,
  world: WORLD_LAYOUT_SYSTEM,
};
