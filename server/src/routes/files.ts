import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Library, LibraryError } from '../services/library.js';

const SAFE_NAME = /^[\w.-]+$/;

export function registerFileRoutes(app: FastifyInstance, library: Library) {
  app.post<{ Params: { assetId: string } }>('/api/files/:assetId', async (req, reply) => {
    const part = await req.file();
    if (!part) throw new LibraryError(400, 'No file uploaded');
    const filename = path.basename(part.filename ?? 'upload.bin');
    if (!SAFE_NAME.test(filename)) throw new LibraryError(400, 'Invalid filename');
    const dir = await library.fileDir(req.params.assetId);
    const buf = await part.toBuffer();
    await fs.writeFile(path.join(dir, filename), buf);
    reply.code(201);
    return { fileRef: { path: `${req.params.assetId}/${filename}` } };
  });

  app.delete<{ Params: { assetId: string; filename: string } }>(
    '/api/files/:assetId/:filename',
    async (req, reply) => {
      if (!SAFE_NAME.test(req.params.filename)) throw new LibraryError(400, 'Invalid filename');
      const abs = library.resolveFile(`${req.params.assetId}/${req.params.filename}`);
      await fs.rm(abs, { force: true });
      reply.code(204);
    },
  );
}
