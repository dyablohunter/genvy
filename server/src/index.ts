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
import { registerExportRoutes } from './routes/export.js';
import { providerRegistry } from './providers/index.js';
import { usage } from './services/usage.js';
import { activity } from './services/activity.js';

async function main() {
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 32 * 1024 * 1024 });
  const library = new Library(config.libraryDir);
  await library.init();
  await usage.init(config.libraryDir);

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: library.filesDir,
    prefix: '/library/files/',
    decorateReply: false,
  });
  await app.register(fastifyStatic, {
    root: library.exportsDir,
    prefix: '/library/exports/',
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

  app.get('/api/health', async () => ({
    ok: true,
    ai: { ...aiStatus(), providers: providerRegistry.status() },
  }));

  /** Estimated AI spend per provider (from published pricing, not billing). */
  app.get('/api/usage', async () => usage.snapshot());

  /** Live stage/step of the in-flight AI op — the HUD's bar follows this. */
  app.get('/api/ai/activity', async () => activity.snapshot());

  registerAssetRoutes(app, library);
  registerFileRoutes(app, library);
  registerAiRoutes(app, library);
  registerImageOpRoutes(app, library);
  registerExportRoutes(app, library);

  // Drain in-flight work before exiting. `tsx watch` restarts on every file
  // save, and a discarded AI request is real money thrown away — so finish
  // what is running instead of resetting the socket.
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      app.log.info('shutting down — waiting for in-flight requests');
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen({ port: config.port, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
