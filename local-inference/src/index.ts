import { config } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const app = await buildServer({ ...config, logger: true });
  await app.listen({ port: config.port, host: '127.0.0.1' });
  app.log.info(`genvy local-inference on :${config.port} (ComfyUI at ${config.comfyUrl})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
