import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  CATEGORY_LABELS,
  DocumentMetaSchema,
  DOCUMENT_CATEGORIES,
  SearchRequestSchema,
} from '@bid/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, HttpError } from '../services/errors.js';
import {
  deleteDocument,
  getDocument,
  getDocumentFile,
  getDocumentText,
  ingestDocument,
  listDocuments,
  reindex,
  updateDocumentMeta,
} from '../services/knowledge.js';
import { hybridSearch } from '../services/search.js';
import { roleOf } from './helpers.js';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const optionalText = (v: string | undefined): string | undefined =>
  v?.trim() ? v.trim() : undefined;

function parseTags(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  if (raw.trim().startsWith('[')) {
    try {
      return z.array(z.string()).parse(JSON.parse(raw));
    } catch {
      throw badRequest('tags: ungültiges JSON');
    }
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  vendor: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  validFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export async function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/categories', async () =>
    DOCUMENT_CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] })),
  );

  app.get('/api/documents', async (req) => {
    const q = z
      .object({
        category: z.enum(DOCUMENT_CATEGORIES).optional(),
        vendor: z.string().optional(),
        q: z.string().optional(),
        validity: z.enum(['valid', 'expiring', 'expired', 'unlimited']).optional(),
        includeOld: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return listDocuments(ctx.db, { ...q, includeOld: q.includeOld === 'true' });
  });

  app.post('/api/documents', async (req, reply) => {
    if (!req.isMultipart()) throw badRequest('Erwartet multipart/form-data mit einer Datei.');

    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; filename: string; mime: string } | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) throw badRequest('Bitte jeweils nur eine Datei hochladen.');
        const buffer = await part.toBuffer();
        if (part.file.truncated)
          throw new HttpError(
            413,
            `Die Datei ist größer als ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
          );
        file = { buffer, filename: part.filename, mime: part.mimetype };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!file || file.buffer.length === 0) throw badRequest('Es wurde keine Datei übertragen.');

    const meta = DocumentMetaSchema.parse({
      title: optionalText(fields.title) ?? file.filename.replace(/\.[^.]+$/, ''),
      category: fields.category,
      vendor: optionalText(fields.vendor),
      tags: parseTags(fields.tags),
      validFrom: optionalText(fields.validFrom),
      validUntil: optionalText(fields.validUntil),
      replacesDocumentId: optionalText(fields.replacesDocumentId),
    });
    if (meta.validFrom && meta.validUntil && meta.validUntil < meta.validFrom) {
      throw badRequest('„Gültig bis" liegt vor „Gültig ab".');
    }

    const result = await ingestDocument(
      { db: ctx.db, embedder: ctx.embedder, config: ctx.config, ocr: ctx.ocr },
      { ...file, meta, role: roleOf(req) },
    );
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (req) =>
    getDocument(ctx.db, z.uuid().parse(req.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/documents/:id/text', async (req) =>
    getDocumentText(ctx.db, z.uuid().parse(req.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/documents/:id/file', async (req, reply) => {
    const file = await getDocumentFile(ctx.db, z.uuid().parse(req.params.id));
    return reply
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .type(file.mime || 'application/octet-stream')
      .send(createReadStream(file.path));
  });

  app.patch<{ Params: { id: string } }>('/api/documents/:id', async (req) =>
    updateDocumentMeta(ctx.db, z.uuid().parse(req.params.id), PatchSchema.parse(req.body)),
  );

  app.delete<{ Params: { id: string } }>('/api/documents/:id', async (req, reply) => {
    await deleteDocument(ctx.db, z.uuid().parse(req.params.id));
    return reply.status(204).send();
  });

  app.post('/api/search', async (req) =>
    hybridSearch(ctx.db, ctx.embedder, SearchRequestSchema.parse(req.body)),
  );

  app.post('/api/admin/reindex', async () => reindex({ db: ctx.db, embedder: ctx.embedder }));
}
