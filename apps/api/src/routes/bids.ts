import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BidDocumentOptionsSchema,
  CreateBidSchema,
  SpecAnalysisSchema,
  type SpecAnalysis,
} from '@bid/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { BidPipeline } from '../services/bid/pipeline.js';
import { countWords } from '../services/bid/checks.js';
import {
  addBidFile,
  createBid,
  createBidDocument,
  deleteBid,
  deleteBidDocument,
  getBid,
  getBidDocument,
  getSection,
  listBidDocuments,
  listBids,
  listEvents,
  listSectionVersions,
  listSections,
  optionsOf,
  usageTotals,
  type BidDocumentRow,
  type SectionRow,
} from '../services/bid/store.js';
import { badRequest, HttpError, notFound } from '../services/errors.js';
import { buildDocx } from '../services/export/docx-export.js';
import { buildDefaultTemplate } from '../services/export/default-template.js';
import { loadTemplate } from '../services/export/template.js';
import { extractText, sectionsToText } from '../services/extract/index.js';
import { contentHash } from '../services/embeddings.js';
import { safeFilename, storeFile } from '../services/knowledge.js';
import { roleOf } from './helpers.js';

const uuid = z.uuid();

const documentDto = (d: BidDocumentRow) => ({
  id: d.id,
  bidId: d.bid_id,
  title: d.title,
  status: d.status,
  error: d.error,
  options: optionsOf(d),
  analysis: d.analysis,
  outlineApprovedAt: d.outline_approved_at,
  coverage: d.coverage,
  findings: d.findings,
  reviewSummary: d.review_summary,
  templateId: d.template_id,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

const sectionDto = (s: SectionRow) => ({
  id: s.id,
  ordinal: s.ordinal,
  outlineId: s.outline_id,
  number: s.number,
  title: s.title,
  level: s.level,
  purpose: s.purpose,
  requirementIds: s.requirement_ids,
  authorRole: s.author_role,
  targetWords: s.target_words,
  maxWords: s.max_words,
  status: s.status,
  facts: s.facts,
  content: s.content,
  notes: s.notes,
  version: s.version,
  lastAuthor: s.last_author,
  wordCount: countWords(s.content),
  updatedAt: s.updated_at,
});

const BuiltinTemplateId = 'standard';

async function resolveTemplate(
  ctx: AppContext,
  templateId: string | null | undefined,
): Promise<{ buffer: Buffer; name: string }> {
  const row =
    templateId && templateId !== BuiltinTemplateId
      ? await ctx.db.one<{ storage_path: string; name: string }>(
          'SELECT storage_path, name FROM templates WHERE id = $1',
          [templateId],
        )
      : templateId === BuiltinTemplateId
        ? null
        : await ctx.db.one<{ storage_path: string; name: string }>(
            'SELECT storage_path, name FROM templates WHERE is_default = true LIMIT 1',
          );
  if (templateId && templateId !== BuiltinTemplateId && !row) throw notFound('Vorlage');
  if (row) return { buffer: await readFile(row.storage_path), name: row.name };
  return { buffer: await buildDefaultTemplate(), name: 'Standardvorlage' };
}

async function readUploads(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  const files: { buffer: Buffer; filename: string; mime: string }[] = [];
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.file.truncated)
        throw new HttpError(413, 'Die Datei ist zu groß (höchstens 100 MB).');
      if (buffer.length) files.push({ buffer, filename: part.filename, mime: part.mimetype });
    } else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
  }
  return { fields, files };
}

export async function registerBidRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  pipeline: BidPipeline,
): Promise<void> {
  const { db } = ctx;

  // --- Ausschreibungen ---------------------------------------------------------------------
  app.get('/api/bids', async () => listBids(db));
  app.post('/api/bids', async (req, reply) =>
    reply.status(201).send(await createBid(db, CreateBidSchema.parse(req.body))),
  );
  app.get<{ Params: { id: string } }>('/api/bids/:id', async (req) => {
    const id = uuid.parse(req.params.id);
    return {
      bid: await getBid(db, id),
      documents: (await listBidDocuments(db, id)).map((d) => ({
        ...documentDto(d),
        sectionCount: d.section_count,
        writtenCount: d.written_count,
      })),
    };
  });
  app.delete<{ Params: { id: string } }>('/api/bids/:id', async (req, reply) => {
    const id = uuid.parse(req.params.id);
    if ((await listBidDocuments(db, id)).some((d) => pipeline.isRunning(d.id)))
      throw new HttpError(409, 'Es läuft noch ein Vorgang für diese Ausschreibung.');
    await deleteBid(db, id);
    return reply.status(204).send();
  });

  // --- Dokumente: Vorgabe hochladen ---------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/bids/:id/documents', async (req, reply) => {
    const bidId = uuid.parse(req.params.id);
    await getBid(db, bidId);

    let fields: Record<string, string> = {};
    let files: { buffer: Buffer; filename: string; mime: string }[] = [];
    if (req.isMultipart()) ({ fields, files } = await readUploads(req));
    else fields = z.record(z.string(), z.unknown()).parse(req.body ?? {}) as Record<string, string>;

    const title = z.string().trim().min(1).max(200).parse(fields.title);
    const options = BidDocumentOptionsSchema.parse({
      allowWeb: fields.allowWeb === undefined ? true : String(fields.allowWeb) !== 'false',
    });

    const texts: string[] = [];
    let firstFileId: string | undefined;
    for (const f of files) {
      const extracted = await extractText(f.buffer, f.filename, f.mime, { ocr: ctx.ocr });
      const text = sectionsToText(extracted.sections);
      const stored = await storeFile(
        ctx.config.dataDir,
        contentHash(f.buffer),
        f.filename,
        f.buffer,
      );
      const fileId = await addBidFile(db, bidId, {
        filename: safeFilename(f.filename),
        mime: f.mime,
        sizeBytes: f.buffer.length,
        storagePath: stored,
        contentText: text,
      });
      firstFileId ??= fileId;
      texts.push(files.length > 1 ? `### Datei: ${f.filename}\n\n${text}` : text);
    }
    if (fields.specText?.trim()) texts.push(fields.specText.trim());
    const specText = texts.join('\n\n');
    if (specText.length < 20)
      throw badRequest('Bitte die Kundenvorgabe als Datei hochladen oder als Text einfügen.');

    const doc = await createBidDocument(db, {
      bidId,
      title,
      specText,
      specFileId: firstFileId,
      options,
    });
    return reply.status(201).send(documentDto(doc));
  });

  // --- Dokument: Stand, Protokoll, Schritte ------------------------------------------------------------
  const docId = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

  app.get<{ Params: { id: string } }>('/api/bid-documents/:id', async (req) => {
    const id = docId(req);
    const [doc, sections, usage] = await Promise.all([
      getBidDocument(db, id),
      listSections(db, id),
      usageTotals(db, id),
    ]);
    return {
      ...documentDto(doc),
      specText: doc.spec_text,
      running: pipeline.isRunning(id),
      usage,
      sections: sections.map(sectionDto),
    };
  });

  app.get<{ Params: { id: string } }>('/api/bid-documents/:id/events', async (req) => {
    const { after } = z
      .object({ after: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    const id = docId(req);
    await getBidDocument(db, id);
    return (await listEvents(db, id, after)).map((e) => ({
      id: e.id,
      sectionId: e.section_id,
      agent: e.agent,
      kind: e.kind,
      message: e.message,
      data: e.data,
      createdAt: e.created_at,
    }));
  });

  app.patch<{ Params: { id: string } }>('/api/bid-documents/:id', async (req) => {
    const id = docId(req);
    const body = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        allowWeb: z.boolean().optional(),
        templateId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const doc = await getBidDocument(db, id);
    const options = {
      ...optionsOf(doc),
      ...(body.allowWeb === undefined ? {} : { allowWeb: body.allowWeb }),
    };
    const templateId =
      body.templateId === undefined
        ? doc.template_id
        : body.templateId === BuiltinTemplateId
          ? null
          : body.templateId;
    if (templateId) await resolveTemplate(ctx, templateId);
    const row = await db.one<BidDocumentRow>(
      'UPDATE bid_documents SET title = $2, options = $3::jsonb, template_id = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [id, body.title ?? doc.title, JSON.stringify(options), templateId],
    );
    return documentDto(row!);
  });

  app.delete<{ Params: { id: string } }>('/api/bid-documents/:id', async (req, reply) => {
    const id = docId(req);
    if (pipeline.isRunning(id)) throw new HttpError(409, 'Das Dokument wird gerade bearbeitet.');
    await deleteBidDocument(db, id);
    return reply.status(204).send();
  });

  const accepted = (reply: FastifyReply, doc: BidDocumentRow) =>
    reply.status(202).send(documentDto(doc));
  const Force = z.object({ force: z.boolean().default(false) }).default({ force: false });

  app.post<{ Params: { id: string } }>('/api/bid-documents/:id/analyze', async (req, reply) =>
    accepted(reply, await pipeline.startAnalysis(docId(req))),
  );

  app.put<{ Params: { id: string } }>('/api/bid-documents/:id/analysis', async (req) => {
    const { analysis, issues } = await pipeline.saveAnalysis(
      docId(req),
      SpecAnalysisSchema.parse(req.body) satisfies SpecAnalysis,
    );
    return { analysis, issues };
  });

  app.post<{ Params: { id: string } }>(
    '/api/bid-documents/:id/approve-outline',
    async (req, reply) =>
      accepted(
        reply,
        await pipeline.approveOutline(docId(req), Force.parse(req.body ?? undefined)),
      ),
  );
  app.post<{ Params: { id: string } }>('/api/bid-documents/:id/retry-failed', async (req, reply) =>
    accepted(reply, await pipeline.retryFailed(docId(req))),
  );
  app.post<{ Params: { id: string } }>('/api/bid-documents/:id/review', async (req, reply) =>
    accepted(reply, await pipeline.startReview(docId(req), Force.parse(req.body ?? undefined))),
  );
  app.post<{ Params: { id: string } }>('/api/bid-documents/:id/polish', async (req, reply) =>
    accepted(reply, await pipeline.polish(docId(req))),
  );

  // --- Kapitel ---------------------------------------------------------------------------------------------
  const sectionOf = async (req: { params: unknown }) =>
    getSection(db, uuid.parse((req.params as { sid: string }).sid));

  app.put<{ Params: { sid: string } }>('/api/bid-sections/:sid', async (req) => {
    const s = await sectionOf(req);
    const { content } = z.object({ content: z.string().max(200_000) }).parse(req.body);
    return sectionDto(await pipeline.editSection(s.bid_document_id, s.id, content, roleOf(req)));
  });
  app.post<{ Params: { sid: string } }>('/api/bid-sections/:sid/rewrite', async (req, reply) => {
    const s = await sectionOf(req);
    const { instruction } = z
      .object({ instruction: z.string().trim().max(2000).optional() })
      .parse(req.body ?? {});
    return accepted(reply, await pipeline.rewriteSection(s.bid_document_id, s.id, instruction));
  });
  app.post<{ Params: { sid: string } }>('/api/bid-sections/:sid/revise', async (req, reply) => {
    const s = await sectionOf(req);
    const { instruction } = z
      .object({ instruction: z.string().trim().min(3).max(2000) })
      .parse(req.body);
    return accepted(reply, await pipeline.reviseSection(s.bid_document_id, s.id, instruction));
  });
  app.get<{ Params: { sid: string } }>('/api/bid-sections/:sid/versions', async (req) => {
    const s = await sectionOf(req);
    return listSectionVersions(db, s.id);
  });
  app.post<{ Params: { sid: string } }>('/api/bid-sections/:sid/restore', async (req) => {
    const s = await sectionOf(req);
    const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
    const old = (await listSectionVersions(db, s.id)).find((v) => v.version === version);
    if (!old) throw notFound('Version');
    return sectionDto(
      await pipeline.editSection(s.bid_document_id, s.id, old.content, roleOf(req)),
    );
  });

  // --- Export und Vorlagen -----------------------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/bid-documents/:id/export.docx', async (req, reply) => {
    const id = docId(req);
    const q = z
      .object({ templateId: z.string().optional(), sources: z.enum(['0', '1']).default('0') })
      .parse(req.query);
    if (pipeline.isRunning(id))
      throw new HttpError(409, 'Es läuft gerade ein Vorgang. Export bitte danach.');
    const doc = await getBidDocument(db, id);
    const sections = await listSections(db, id);
    if (!sections.some((s) => s.content.trim()))
      throw new HttpError(409, 'Es gibt noch keinen Text, der sich exportieren ließe.');

    const bid = await getBid(db, doc.bid_id);
    const template = await resolveTemplate(ctx, q.templateId ?? doc.template_id);
    const result = await buildDocx(
      {
        title: doc.title,
        customer: bid.customer,
        bidName: bid.name,
        author: ctx.config.companyName,
        date: new Date().toLocaleDateString('de-DE', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }),
        includeSources: q.sources === '1',
        sections: sections.map((s) => ({
          number: s.number,
          title: s.title,
          level: s.level,
          content: s.content,
          facts: s.facts,
        })),
      },
      template.buffer,
    );
    return reply
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFilename(doc.title)}.docx`)}`,
      )
      .header('x-open-points', String(result.openPoints.length))
      .header('x-template', encodeURIComponent(template.name))
      .header('x-content-marker', result.usedContentMarker ? '1' : '0')
      .header(
        'access-control-expose-headers',
        'x-open-points, x-template, x-content-marker, content-disposition',
      )
      .type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .send(result.buffer);
  });

  app.get('/api/templates', async () => {
    const rows = await db.query<{
      id: string;
      name: string;
      filename: string;
      is_default: boolean;
      created_at: string;
    }>('SELECT id, name, filename, is_default, created_at FROM templates ORDER BY created_at DESC');
    return [
      {
        id: BuiltinTemplateId,
        name: 'Standardvorlage',
        filename: 'standardvorlage.docx',
        isDefault: !rows.some((r) => r.is_default),
        builtin: true,
      },
      ...rows.map((r) => ({
        id: r.id,
        name: r.name,
        filename: r.filename,
        isDefault: r.is_default,
        builtin: false,
      })),
    ];
  });

  app.get('/api/templates/standard/file', async (_req, reply) =>
    reply
      .header('content-disposition', `attachment; filename*=UTF-8''standardvorlage.docx`)
      .type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .send(await buildDefaultTemplate()),
  );

  app.post('/api/templates', async (req, reply) => {
    if (!req.isMultipart()) throw badRequest('Erwartet multipart/form-data mit einer Word-Datei.');
    const { fields, files } = await readUploads(req);
    const file = files[0];
    if (!file) throw badRequest('Es wurde keine Datei übertragen.');
    if (!/\.(docx|dotx)$/i.test(file.filename))
      throw new HttpError(422, 'Vorlagen müssen als .docx oder .dotx vorliegen.');
    const parts = await loadTemplate(file.buffer); // wirft 422 bei ungültigen Dateien
    const warnings: string[] = [];
    if (!parts.documentXml.includes('{{INHALT}}')) {
      warnings.push(
        'Die Vorlage enthält keinen Absatz mit {{INHALT}}. Der Text wird hinter den vorhandenen Vorlagentext gesetzt.',
      );
    }
    const name = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .default(file.filename.replace(/\.[^.]+$/, ''))
      .parse(fields.name?.trim() || undefined);
    const makeDefault = fields.isDefault === 'true';

    const id = (await db.one<{ id: string }>('SELECT gen_random_uuid() AS id'))!.id;
    const dir = path.join(ctx.config.dataDir, 'templates', id);
    await mkdir(dir, { recursive: true });
    const stored = path.join(dir, safeFilename(file.filename));
    await writeFile(stored, file.buffer);
    await db.tx(async (tx) => {
      if (makeDefault) await tx.query('UPDATE templates SET is_default = false');
      await tx.query(
        'INSERT INTO templates (id, name, filename, storage_path, is_default) VALUES ($1, $2, $3, $4, $5)',
        [id, name, safeFilename(file.filename), stored, makeDefault],
      );
    });
    return reply.status(201).send({ id, name, isDefault: makeDefault, warnings });
  });

  app.patch<{ Params: { id: string } }>('/api/templates/:id', async (req) => {
    const { isDefault } = z.object({ isDefault: z.boolean() }).parse(req.body);
    const id = req.params.id;
    if (id === BuiltinTemplateId) {
      if (isDefault) await db.query('UPDATE templates SET is_default = false');
      return { id, isDefault };
    }
    uuid.parse(id);
    await db.tx(async (tx) => {
      if (isDefault) await tx.query('UPDATE templates SET is_default = false');
      if (
        !(await tx.one('UPDATE templates SET is_default = $2 WHERE id = $1 RETURNING id', [
          id,
          isDefault,
        ]))
      )
        throw notFound('Vorlage');
    });
    return { id, isDefault };
  });

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (req, reply) => {
    const id = uuid.parse(req.params.id);
    const row = await db.one<{ storage_path: string }>(
      'DELETE FROM templates WHERE id = $1 RETURNING storage_path',
      [id],
    );
    if (!row) throw notFound('Vorlage');
    await rm(path.dirname(row.storage_path), { recursive: true, force: true });
    return reply.status(204).send();
  });
}
