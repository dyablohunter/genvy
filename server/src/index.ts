import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, aiStatus } from './config.js';
import { Library, LibraryError } from './services/library.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerFileRoutes } from './routes/files.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerImageOpRoutes } from './routes/imageOps.js';

async function main() {
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 32 * 1024 * 1024 });
  const library = new Library(config.libraryDir);
  await library.init();

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: library.filesDir,
    prefix: '/library/files/',
    decorateReply: false,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LibraryError) {
      reply.code(err.statusCode).send({ error: err.message, details: err.payload });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    app.log.error(err);
    reply.code(status).send({ error: (err as Error).message ?? 'Internal error' });
  });

  app.get('/api/health', async () => ({ ok: true, ai: aiStatus() }));

  registerAssetRoutes(app, library);
  registerFileRoutes(app, library);
  registerAiRoutes(app, library);
  registerImageOpRoutes(app, library);

  await app.listen({ port: config.port, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
