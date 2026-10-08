import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validityOf, type DocumentMeta, type DocumentSummary } from '@bid/shared';
import type { Config } from '../config.js';
import { toVectorLiteral, type Db } from '../db/client.js';
import { chunkSections } from './chunk.js';
import { contentHash, type Embedder } from './embeddings.js';
import { detectLanguage, extractText, sectionsToText, type OcrProvider } from './extract/index.js';
import { HttpError, notFound } from './errors.js';

export interface KnowledgeDeps {
  db: Db;
  embedder: Embedder;
  config: Pick<Config, 'dataDir'>;
  ocr?: OcrProvider | undefined;
}

export interface UploadInput {
  buffer: Buffer;
  filename: string;
  mime: string;
  meta: DocumentMeta;
  role?: string | undefined;
}

interface DocumentRow {
  id: string;
  family_id: string;
  title: string;
  category: DocumentSummary['category'];
  vendor: string | null;
  tags: string[];
  language: string | null;
  valid_from: string | null;
  valid_until: string | null;
  version: number;
  is_current: boolean;
  filename: string;
  mime: string;
  size_bytes: number;
  extraction_method: string;
  uploaded_by_role: string | null;
  created_at: string;
  chunk_count: number;
}

const SELECT_SUMMARY = `
  SELECT d.id, d.family_id, d.title, d.category, d.vendor, d.tags, d.language, d.valid_from, d.valid_until,
         d.version, d.is_current, d.filename, d.mime, d.size_bytes, d.extraction_method, d.uploaded_by_role,
         d.created_at, (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
  FROM documents d`;

export function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    familyId: row.family_id,
    title: row.title,
    category: row.category,
    vendor: row.vendor,
    tags: row.tags,
    language: row.language,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    version: row.version,
    isCurrent: row.is_current,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    chunkCount: row.chunk_count,
    extractionMethod: row.extraction_method,
    uploadedByRole: row.uploaded_by_role,
    createdAt: row.created_at,
    validity: validityOf(row.valid_until),
  };
}

/** Dateiname ohne Pfadanteile und Sonderzeichen — er landet im Dateisystem. */
export function safeFilename(name: string): string {
  const base = path
    .basename(name.replace(/\\/g, '/'))
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : 'datei';
}

export async function storeFile(
  dataDir: string,
  sha256: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const dir = path.join(dataDir, 'uploads', sha256.slice(0, 2), sha256);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, safeFilename(filename));
  await writeFile(target, buffer);
  return target;
}

export interface IngestResult {
  document: DocumentSummary;
  duplicate: boolean;
  warnings: string[];
}

export async function ingestDocument(
  deps: KnowledgeDeps,
  input: UploadInput,
): Promise<IngestResult> {
  const { db, embedder } = deps;
  const sha256 = contentHash(input.buffer);

  // Dieselbe Datei als aktuelle Fassung noch einmal hochzuladen ist fast immer ein Versehen.
  const existing = await db.one<{ id: string }>(
    'SELECT id FROM documents WHERE sha256 = $1 AND is_current = true LIMIT 1',
    [sha256],
  );
  if (existing && !input.meta.replacesDocumentId) {
    const row = await db.one<DocumentRow>(`${SELECT_SUMMARY} WHERE d.id = $1`, [existing.id]);
    return {
      document: toSummary(row!),
      duplicate: true,
      warnings: ['Diese Datei ist bereits in der Wissensbasis.'],
    };
  }

  const extracted = await extractText(input.buffer, input.filename, input.mime, { ocr: deps.ocr });
  const chunks = chunkSections(extracted.sections);
  const contentText = sectionsToText(extracted.sections);
  const language = detectLanguage(contentText);

  // Einbetten vor der Transaktion: der Aufruf kann dauern und soll keine Sperren halten.
  const vectors = await embedder.embed(
    chunks.map((c) => (c.heading ? `${c.heading}\n${c.content}` : c.content)),
    'passage',
  );
  const storagePath = await storeFile(deps.config.dataDir, sha256, input.filename, input.buffer);

  const id = await db.tx(async (tx) => {
    let familyId: string;
    let version = 1;

    if (input.meta.replacesDocumentId) {
      const old = await tx.one<{ family_id: string }>(
        'SELECT family_id FROM documents WHERE id = $1',
        [input.meta.replacesDocumentId],
      );
      if (!old) throw notFound('Das zu ersetzende Dokument');
      familyId = old.family_id;
      const max = await tx.one<{ v: number }>(
        'SELECT max(version) AS v FROM documents WHERE family_id = $1',
        [familyId],
      );
      version = (max?.v ?? 0) + 1;
      await tx.query('UPDATE documents SET is_current = false WHERE family_id = $1', [familyId]);
    } else {
      familyId = (await tx.one<{ id: string }>('SELECT gen_random_uuid() AS id'))!.id;
    }

    const doc = await tx.one<{ id: string }>(
      `INSERT INTO documents (family_id, version, is_current, title, category, vendor, tags, language, valid_from, valid_until,
                              filename, mime, size_bytes, sha256, storage_path, content_text, extraction_method, uploaded_by_role)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        familyId,
        version,
        input.meta.title,
        input.meta.category,
        input.meta.vendor ?? null,
        input.meta.tags,
        language,
        input.meta.validFrom ?? null,
        input.meta.validUntil ?? null,
        safeFilename(input.filename),
        input.mime,
        input.buffer.length,
        sha256,
        storagePath,
        contentText,
        extracted.method,
        input.role ?? null,
      ],
    );

    for (const [i, chunk] of chunks.entries()) {
      await tx.query(
        `INSERT INTO chunks (document_id, ordinal, heading, page, content, embedding_model, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          doc!.id,
          i,
          chunk.heading,
          chunk.page,
          chunk.content,
          embedder.name,
          toVectorLiteral(vectors[i]!),
        ],
      );
    }
    return doc!.id;
  });

  const row = await db.one<DocumentRow>(`${SELECT_SUMMARY} WHERE d.id = $1`, [id]);
  return { document: toSummary(row!), duplicate: false, warnings: extracted.warnings };
}

export interface ListFilters {
  category?: string | undefined;
  vendor?: string | undefined;
  q?: string | undefined;
  includeOld?: boolean | undefined;
  validity?: DocumentSummary['validity'] | undefined;
}

export async function listDocuments(db: Db, filters: ListFilters = {}): Promise<DocumentSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filters.includeOld) where.push('d.is_current = true');
  if (filters.category) where.push(`d.category = $${params.push(filters.category)}`);
  if (filters.vendor) where.push(`d.vendor ILIKE $${params.push(filters.vendor)}`);
  if (filters.q) {
    const p = params.push(`%${filters.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(
      `(d.title ILIKE $${p} OR d.filename ILIKE $${p} OR d.vendor ILIKE $${p} OR array_to_string(d.tags, ' ') ILIKE $${p})`,
    );
  }
  const rows = await db.query<DocumentRow>(
    `${SELECT_SUMMARY} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC LIMIT 500`,
    params,
  );
  const docs = rows.map(toSummary);
  return filters.validity ? docs.filter((d) => d.validity === filters.validity) : docs;
}

export async function getDocument(
  db: Db,
  id: string,
): Promise<{ document: DocumentSummary; versions: DocumentSummary[] }> {
  const row = await db.one<DocumentRow>(`${SELECT_SUMMARY} WHERE d.id = $1`, [id]);
  if (!row) throw notFound('Dokument');
  const versions = await db.query<DocumentRow>(
    `${SELECT_SUMMARY} WHERE d.family_id = $1 ORDER BY d.version DESC`,
    [row.family_id],
  );
  return { document: toSummary(row), versions: versions.map(toSummary) };
}

export async function getDocumentText(
  db: Db,
  id: string,
): Promise<{ title: string; text: string }> {
  const row = await db.one<{ title: string; content_text: string }>(
    'SELECT title, content_text FROM documents WHERE id = $1',
    [id],
  );
  if (!row) throw notFound('Dokument');
  return { title: row.title, text: row.content_text };
}

export async function getDocumentFile(
  db: Db,
  id: string,
): Promise<{ path: string; filename: string; mime: string }> {
  const row = await db.one<{ storage_path: string; filename: string; mime: string }>(
    'SELECT storage_path, filename, mime FROM documents WHERE id = $1',
    [id],
  );
  if (!row) throw notFound('Dokument');
  return { path: row.storage_path, filename: row.filename, mime: row.mime };
}

export interface MetaPatch {
  title?: string | undefined;
  category?: DocumentSummary['category'] | undefined;
  vendor?: string | null | undefined;
  tags?: string[] | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
}

export async function updateDocumentMeta(
  db: Db,
  id: string,
  patch: MetaPatch,
): Promise<DocumentSummary> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown): void =>
    void sets.push(`${col} = $${params.push(value)}`);
  if (patch.title !== undefined) set('title', patch.title);
  if (patch.category !== undefined) set('category', patch.category);
  if (patch.vendor !== undefined) set('vendor', patch.vendor);
  if (patch.tags !== undefined) set('tags', patch.tags);
  if (patch.validFrom !== undefined) set('valid_from', patch.validFrom);
  if (patch.validUntil !== undefined) set('valid_until', patch.validUntil);
  if (!sets.length) throw new HttpError(400, 'Keine Änderungen angegeben');
  params.push(id);
  const updated = await db.one<{ id: string }>(
    `UPDATE documents SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params,
  );
  if (!updated) throw notFound('Dokument');
  return (await getDocument(db, id)).document;
}

/** Löscht eine Fassung; war es die aktuelle, rückt die vorherige nach. Die Datei bleibt, solange eine andere Fassung sie nutzt. */
export async function deleteDocument(db: Db, id: string): Promise<void> {
  const doc = await db.one<{ family_id: string; is_current: boolean; storage_path: string }>(
    'SELECT family_id, is_current, storage_path FROM documents WHERE id = $1',
    [id],
  );
  if (!doc) throw notFound('Dokument');
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM documents WHERE id = $1', [id]);
    if (doc.is_current) {
      await tx.query(
        `UPDATE documents SET is_current = true
         WHERE id = (SELECT id FROM documents WHERE family_id = $1 ORDER BY version DESC LIMIT 1)`,
        [doc.family_id],
      );
    }
  });
  const stillUsed = await db.one('SELECT 1 FROM documents WHERE storage_path = $1 LIMIT 1', [
    doc.storage_path,
  ]);
  if (!stillUsed) await rm(path.dirname(doc.storage_path), { recursive: true, force: true });
}

/** Bettet alle Chunks neu ein, deren Vektor aus einem anderen Modell stammt (z. B. nach Zuschalten des ML-Dienstes). */
export async function reindex(
  deps: Pick<KnowledgeDeps, 'db' | 'embedder'>,
): Promise<{ reindexed: number }> {
  const { db, embedder } = deps;
  const rows = await db.query<{ id: string; heading: string | null; content: string }>(
    'SELECT id, heading, content FROM chunks WHERE embedding_model IS DISTINCT FROM $1 ORDER BY document_id, ordinal',
    [embedder.name],
  );
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    const vectors = await embedder.embed(
      batch.map((r) => (r.heading ? `${r.heading}\n${r.content}` : r.content)),
      'passage',
    );
    await db.tx(async (tx) => {
      for (const [j, row] of batch.entries()) {
        await tx.query(
          'UPDATE chunks SET embedding = $1::vector, embedding_model = $2 WHERE id = $3',
          [toVectorLiteral(vectors[j]!), embedder.name, row.id],
        );
      }
    });
  }
  return { reindexed: rows.length };
}
