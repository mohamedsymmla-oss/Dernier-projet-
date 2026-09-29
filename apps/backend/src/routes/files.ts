import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { DatabaseStorage } from '../storage/storage.js';

/**
 * Fichiers médias stockés en base, servis au fournisseur WhatsApp via une URL signée et à durée limitée.
 * Sans signature valide : 404 (on ne révèle pas l'existence du fichier).
 */
export async function publicFileRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/files/*', async (req, reply) => {
    const storage = ctx.storage;
    if (!(storage instanceof DatabaseStorage)) return reply.code(404).send({ error: 'Introuvable' });
    const key = (req.params as { '*': string })['*'];
    const q = req.query as { exp?: string; sig?: string };
    if (!key || !q.sig || !storage.verify(key, Number(q.exp), q.sig)) return reply.code(404).send({ error: 'Introuvable' });
    const file = await storage.read(key);
    if (!file) return reply.code(404).send({ error: 'Introuvable' });
    return reply
      .header('content-type', file.contentType)
      .header('content-length', file.body.length)
      .header('cache-control', 'private, max-age=3600')
      .send(file.body);
  });
}
