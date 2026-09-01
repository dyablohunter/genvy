import type { FastifyInstance } from 'fastify';
import type { AssetType } from '@genvy/shared';
import { Library, LibraryError } from '../services/library.js';

export function registerAssetRoutes(app: FastifyInstance, library: Library) {
  app.get<{ Querystring: { type?: string; tag?: string; q?: string } }>(
    '/api/assets',
    async (req) => library.list(req.query),
  );

  app.get<{ Params: { id: string } }>('/api/assets/:id', async (req) => library.get(req.params.id));

  app.post<{ Body: { type: AssetType; data: Record<string, unknown> } }>(
    '/api/assets',
    async (req, reply) => {
      const { type, data } = req.body ?? {};
      if (!type || !data) throw new LibraryError(400, 'Body must be { type, data }');
      const asset = await library.create(type, data);
      reply.code(201);
      return asset;
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/assets/:id',
    async (req) => library.update(req.params.id, req.body ?? {}),
  );

  app.delete<{ Params: { id: string }; Querystring: { force?: string; cascade?: string } }>(
    '/api/assets/:id',
    async (req, reply) => {
      await library.remove(req.params.id, {
        force: req.query.force === 'true',
        cascade: req.query.cascade === 'true',
      });
      reply.code(204);
    },
  );

  // Interrupted-session recovery: unsaved file dirs.
  app.get('/api/library/orphans', async () => library.orphans());
  // All file dirs with session linkage + saved assets (drawer grouping).
  app.get('/api/library/workspaces', async () => library.workspaces());
  app.delete<{ Params: { id: string } }>('/api/library/orphans/:id', async (req, reply) => {
    await library.removeOrphan(req.params.id);
    reply.code(204);
  });

  // Dev/testing: nuke the entire collection (assets + files + index).
  app.post('/api/library/wipe', async () => {
    await library.wipe();
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/assets/:id/refs', async (req) => ({
    inbound: await library.referrers(req.params.id),
    outbound: await library.outboundRefs(req.params.id),
  }));
}
