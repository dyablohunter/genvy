import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nano = customAlphabet(alphabet, 10);

export type AssetId = string;

/** Prefixed ids like `chr_x7Kd9aB2cD` keep the type readable in file names and logs. */
export const ID_PREFIXES = {
  spritesheet: 'sht',
  animation: 'anm',
  character: 'chr',
  tileset: 'tls',
  world: 'wld',
  scene: 'scn',
  npc: 'npc',
  enemy: 'enm',
  item: 'itm',
  sound: 'snd',
  music: 'mus',
  particle: 'pfx',
  dialogue: 'dlg',
  quest: 'qst',
  physicsPreset: 'phy',
  camera: 'cam',
  uiTheme: 'uit',
  gameUi: 'gui',
  cutscene: 'cut',
  projectMeta: 'prj',
} as const;

export type AssetType = keyof typeof ID_PREFIXES;

export function newAssetId(type: AssetType): AssetId {
  return `${ID_PREFIXES[type]}_${nano()}`;
}

export interface AssetRef {
  id: AssetId;
  type: AssetType;
}
