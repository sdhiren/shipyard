import fs from 'node:fs';
import { ATTACHMENT_MAX_BYTES, INLINE_IMAGE_TYPES } from '@shipyard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { absPath, deleteAttachment, formatBytes, getAttachmentRow, listAttachments, saveAttachment } from '../services/attachments.js';

const idParams = z.object({ id: z.string() });
const INLINE_TYPES = [...INLINE_IMAGE_TYPES, 'application/pdf'];

/** RFC 6266 header with an ASCII fallback and the UTF-8 name. */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  // Uploads are the raw file body. Scoped to this plugin, so the JSON parser and
  // the 5 MB limit stay as they are everywhere else.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, _req, reply) => {
    if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: `File is larger than ${formatBytes(ATTACHMENT_MAX_BYTES)}` });
    }
    throw err;
  });

  app.post('/api/items/:id/attachments', { bodyLimit: ATTACHMENT_MAX_BYTES }, async (req, reply) => {
    const { draft } = z.object({ draft: z.enum(['0', '1']).default('0') }).parse(req.query);
    const header = req.headers['x-filename'];
    let filename = 'file';
    try {
      filename = decodeURIComponent(typeof header === 'string' ? header : 'file');
    } catch {
      // Malformed escapes: keep the default name.
    }
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const attachment = await saveAttachment({ itemId: idParams.parse(req.params).id, filename, mimeType: req.headers['content-type'], data, draft: draft === '1' });
    return reply.code(201).send(attachment);
  });

  app.get('/api/items/:id/attachments', async (req) => listAttachments(idParams.parse(req.params).id));

  /**
   * Only raster images and PDFs are shown inline. Everything else (SVG and
   * HTML included) downloads, and the sandbox CSP plus nosniff stop an uploaded
   * file from running script on this origin, which can make Claude edit code.
   */
  app.get('/api/attachments/:id', async (req, reply) => {
    const row = getAttachmentRow(idParams.parse(req.params).id);
    const inline = INLINE_TYPES.includes(row.mimeType);
    return reply
      .header('Content-Type', row.mimeType)
      .header('Content-Length', row.size)
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.filename))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(absPath(row)));
  });

  app.delete('/api/attachments/:id', async (req, reply) => {
    deleteAttachment(idParams.parse(req.params).id);
    return reply.code(204).send();
  });
}
