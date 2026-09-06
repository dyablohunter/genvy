import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(repoRoot, '.env') });

export const config = {
  port: Number(process.env.PORT ?? 3020),
  libraryDir: process.env.LIBRARY_DIR ?? path.join(repoRoot, 'library'),
  deepseekApiKey: (process.env.DEEPSEEK_API_KEY ?? '').replace(/^"|"$/g, ''),
  openaiApiKey: (process.env.OPENAI_API_KEY ?? '').replace(/^"|"$/g, ''),
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
  // Sprite Pipeline v2 — additional BYO-key providers (missing key = LINK OFFLINE).
  retroDiffusionApiKey: (process.env.RETRODIFFUSION_API_KEY ?? '').replace(/^"|"$/g, ''),
  // P6 — the local-inference service (free, optional; offline until its /health answers).
  localInferenceUrl: process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:3021',
};

export const aiStatus = () => ({
  text: config.deepseekApiKey.length > 0,
  image: config.openaiApiKey.length > 0,
});
