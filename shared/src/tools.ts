/** The full Genvy tool roster. Tools without `ready: true` render dimmed ("COMING ONLINE") in the hub. */
export interface ToolDef {
  id: string;
  name: string;
  icon: string; // emoji placeholder until custom icons land
  blurb: string;
  ready: boolean;
}

export const TOOLS: ToolDef[] = [
  { id: 'sprite', name: 'Sprite Forge', icon: '🧬', blurb: 'AI sprites & spritesheets', ready: true },
  { id: 'world', name: 'World Maker', icon: '🗺️', blurb: 'Level painting and tilesets', ready: true },
  { id: 'npc', name: 'NPC Designer', icon: '🧑‍🚀', blurb: 'Personalities, schedules, dialogue', ready: false },
  { id: 'enemy', name: 'Enemy Forge', icon: '👾', blurb: 'Behaviors, stats, drop tables', ready: false },
  { id: 'item', name: 'Item Smith', icon: '⚒️', blurb: 'Icons, effects, rarity', ready: false },
  { id: 'animation', name: 'Animation Studio', icon: '🎞️', blurb: 'Timelines, onion-skin, clips', ready: false },
  { id: 'particle', name: 'FX Lab', icon: '✨', blurb: 'Particle emitters & presets', ready: false },
  { id: 'sound', name: 'Sound Designer', icon: '🔊', blurb: 'Retro sfx synthesis', ready: false },
  { id: 'music', name: 'Music Composer', icon: '🎹', blurb: 'Chiptune sequencing', ready: false },
  { id: 'dialogue', name: 'Dialogue Writer', icon: '💬', blurb: 'Branching conversations', ready: false },
  { id: 'quest', name: 'Quest Architect', icon: '📜', blurb: 'Objectives & rewards', ready: false },
  { id: 'gameui', name: 'UI Kit Builder', icon: '🎛️', blurb: 'HUDs for your games', ready: false },
  { id: 'physics', name: 'Physics Tuner', icon: '🎢', blurb: 'Gravity, drag, bounce presets', ready: false },
  { id: 'camera', name: 'Camera Director', icon: '🎥', blurb: 'Follow, shake, zoom rigs', ready: false },
  { id: 'cutscene', name: 'Cutscene Composer', icon: '🎬', blurb: 'Timeline storytelling', ready: false },
  { id: 'parallax', name: 'Parallax Painter', icon: '🌄', blurb: 'Layered scrolling backdrops', ready: false },
  { id: 'portrait', name: 'Portrait Studio', icon: '🖼️', blurb: 'Faces, emotes, expressions', ready: false },
  { id: 'projectile', name: 'Weapon Workshop', icon: '🚀', blurb: 'Projectiles & impacts', ready: false },
  { id: 'pickup', name: 'Pickup Designer', icon: '💎', blurb: 'Collectibles & hazards', ready: false },
  { id: 'bundle', name: 'Game Assembler', icon: '🕹️', blurb: 'Bundle assets into games', ready: false },
];
