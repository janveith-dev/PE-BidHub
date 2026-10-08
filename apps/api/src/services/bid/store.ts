import {
  BidDocumentOptionsSchema,
  type BidDocumentOptions,
  type BidDocumentStatus,
  type CoverageItem,
  type CreateBid,
  type Fact,
  type Finding,
  type SectionStatus,
  type SpecAnalysis,
} from '@bid/shared';
import type { Db } from '../../db/client.js';
import { HttpError, notFound } from '../errors.js';

// --- Zeilentypen und Abbildung ---------------------------------------------------

export interface BidRow {
  id: string;
  name: string;
  customer: string;
  deadline: string | null;
  language: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BidDocumentRow {
  id: string;
  bid_id: string;
  title: string;
  spec_file_id: string | null;
  spec_text: string;
  status: BidDocumentStatus;
  analysis: SpecAnalysis | null;
  outline_approved_at: string | null;
  coverage: CoverageItem[] | null;
  findings: Finding[] | null;
  review_summary: string | null;
  template_id: string | null;
  options: Partial<BidDocumentOptions>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SectionRow {
  id: string;
  bid_document_id: string;
  ordinal: number;
  outline_id: string;
  number: string;
  title: string;
  level: number;
  purpose: string;
  requirement_ids: string[];
  author_role: string;
  target_words: number | null;
  max_words: number | null;
  status: SectionStatus;
  facts: Fact[];
  content: string;
  notes: string;
  version: number;
  last_author: string;
  updated_at: string;
}

export const optionsOf = (doc: Pick<BidDocumentRow, 'options'>): BidDocumentOptions => BidDocumentOptionsSchema.parse(doc.options ?? {});

// --- Aufträge ----------------------------------------------------------------------

export async function createBid(db: Db, input: CreateBid): Promise<BidRow> {
  return (await db.one<BidRow>(
    `INSERT INTO bids (name, customer, deadline, language, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.customer, input.deadline ?? null, input.language, input.notes ?? null],
  ))!;
}

export async function listBids(db: Db) {
  return db.query<BidRow & { document_count: number }>(
    `SELECT b.*, (SELECT count(*) FROM bid_documents d WHERE d.bid_id = b.id) AS document_count
     FROM bids b ORDER BY b.updated_at DESC LIMIT 200`,
  );
}

export async function getBid(db: Db, id: string): Promise<BidRow> {
  const row = await db.one<BidRow>('SELECT * FROM bids WHERE id = $1', [id]);
  if (!row) throw notFound('Ausschreibung');
  return row;
}

export async function deleteBid(db: Db, id: string): Promise<void> {
  if (!(await db.one('DELETE FROM bids WHERE id = $1 RETURNING id', [id]))) throw notFound('Ausschreibung');
}

export async function listBidDocuments(db: Db, bidId: string) {
  return db.query<BidDocumentRow & { section_count: number; written_count: number }>(
    `SELECT d.*,
            (SELECT count(*) FROM bid_sections s WHERE s.bid_document_id = d.id) AS section_count,
            (SELECT count(*) FROM bid_sections s WHERE s.bid_document_id = d.id AND s.status = 'written') AS written_count
     FROM bid_documents d WHERE d.bid_id = $1 ORDER BY d.created_at`,
    [bidId],
  );
}

export async function addBidFile(
  db: Db,
  bidId: string,
  file: { filename: string; mime: string; sizeBytes: number; storagePath: string; contentText: string },
): Promise<string> {
  return (await db.one<{ id: string }>(
    `INSERT INTO bid_files (bid_id, filename, mime, size_bytes, storage_path, content_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bidId, file.filename, file.mime, file.sizeBytes, file.storagePath, file.contentText],
  ))!.id;
}

// --- Dokumente --------------------------------------------------------------------------

export async function createBidDocument(
  db: Db,
  input: { bidId: string; title: string; specText: string; specFileId?: string | undefined; options?: Partial<BidDocumentOptions> | undefined },
): Promise<BidDocumentRow> {
  await getBid(db, input.bidId);
  return (await db.one<BidDocumentRow>(
    `INSERT INTO bid_documents (bid_id, title, spec_text, spec_file_id, options) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [input.bidId, input.title, input.specText, input.specFileId ?? null, JSON.stringify(input.options ?? {})],
  ))!;
}

export async function getBidDocument(db: Db, id: string): Promise<BidDocumentRow> {
  const row = await db.one<BidDocumentRow>('SELECT * FROM bid_documents WHERE id = $1', [id]);
  if (!row) throw notFound('Dokument');
  return row;
}

export async function deleteBidDocument(db: Db, id: string): Promise<void> {
  const doc = await getBidDocument(db, id);
  if (['analyzing', 'writing', 'reviewing'].includes(doc.status)) {
    throw new HttpError(409, 'Das Dokument wird gerade bearbeitet. Bitte warten, bis der Lauf beendet ist.');
  }
  await db.query('DELETE FROM bid_documents WHERE id = $1', [id]);
}

export async function setStatus(db: Db, id: string, status: BidDocumentStatus, error: string | null = null): Promise<void> {
  await db.query('UPDATE bid_documents SET status = $2, error = $3, updated_at = now() WHERE id = $1', [id, status, error]);
}

/** Legt einen Statuswechsel atomar fest: schlägt fehl, wenn das Dokument nicht im erwarteten Zustand ist. */
export async function transition(
  db: Db,
  id: string,
  from: BidDocumentStatus[],
  to: BidDocumentStatus,
): Promise<BidDocumentRow> {
  const row = await db.one<BidDocumentRow>(
    `UPDATE bid_documents SET status = $3, error = NULL, updated_at = now()
     WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    [id, from, to],
  );
  if (row) return row;
  const current = await getBidDocument(db, id);
  throw new HttpError(409, `Dieser Schritt ist im Status „${current.status}" nicht möglich (erlaubt: ${from.join(', ')}).`);
}

// --- Kapitel -----------------------------------------------------------------------------

export async function listSections(db: Db, bidDocumentId: string): Promise<SectionRow[]> {
  return db.query<SectionRow>('SELECT * FROM bid_sections WHERE bid_document_id = $1 ORDER BY ordinal', [bidDocumentId]);
}

export async function getSection(db: Db, id: string): Promise<SectionRow> {
  const row = await db.one<SectionRow>('SELECT * FROM bid_sections WHERE id = $1', [id]);
  if (!row) throw notFound('Kapitel');
  return row;
}

/** Ersetzt alle Kapitel durch die Gliederung. Nur vor der Freigabe, solange noch kein Text existiert. */
export async function replaceSections(db: Db, bidDocumentId: string, outline: SpecAnalysis['outline']): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM bid_sections WHERE bid_document_id = $1', [bidDocumentId]);
    for (const [i, s] of outline.entries()) {
      await tx.query(
        `INSERT INTO bid_sections (bid_document_id, ordinal, outline_id, number, title, level, purpose, requirement_ids, author_role, target_words, max_words)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [bidDocumentId, i, s.id, s.number, s.title, s.level, s.purpose, s.requirementIds, s.authorRole, s.targetWords ?? null, s.maxWords ?? null],
      );
    }
  });
}

export async function setSectionStatus(db: Db, id: string, status: SectionStatus, notes?: string): Promise<void> {
  if (notes === undefined) await db.query('UPDATE bid_sections SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  else await db.query('UPDATE bid_sections SET status = $2, notes = $3, updated_at = now() WHERE id = $1', [id, status, notes]);
}

export async function saveSectionFacts(db: Db, id: string, facts: Fact[]): Promise<void> {
  await db.query('UPDATE bid_sections SET facts = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(facts)]);
}

/** Schreibt eine neue Fassung des Kapitels und legt die vorherige samt ihrem Autor in die Versionshistorie. */
export async function saveSectionContent(
  db: Db,
  id: string,
  content: string,
  author: string,
  extra: { status?: SectionStatus; notes?: string } = {},
): Promise<SectionRow> {
  return db.tx(async (tx) => {
    const current = await tx.one<SectionRow>('SELECT * FROM bid_sections WHERE id = $1 FOR UPDATE', [id]);
    if (!current) throw notFound('Kapitel');
    if (current.content.trim()) {
      await tx.query('INSERT INTO bid_section_versions (section_id, version, content, author) VALUES ($1, $2, $3, $4)', [
        id, current.version, current.content, current.last_author || 'unbekannt',
      ]);
    }
    return (await tx.one<SectionRow>(
      `UPDATE bid_sections SET content = $2, version = $3, last_author = $4, status = $5, notes = $6, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, content, current.version + 1, author, extra.status ?? current.status, extra.notes ?? current.notes],
    ))!;
  });
}

export async function listSectionVersions(db: Db, sectionId: string) {
  return db.query<{ id: string; version: number; content: string; author: string; created_at: string }>(
    'SELECT id, version, content, author, created_at FROM bid_section_versions WHERE section_id = $1 ORDER BY version DESC',
    [sectionId],
  );
}

// --- Protokoll ----------------------------------------------------------------------------

export interface EventInput {
  sectionId?: string | undefined;
  agent: string;
  kind: 'info' | 'tool' | 'result' | 'error' | 'gate';
  message: string;
  data?: unknown;
}

export async function logEvent(db: Db, bidDocumentId: string, e: EventInput): Promise<void> {
  await db.query(
    `INSERT INTO agent_events (bid_document_id, section_id, agent, kind, message, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [bidDocumentId, e.sectionId ?? null, e.agent, e.kind, e.message.slice(0, 2000), e.data === undefined ? null : JSON.stringify(e.data)],
  );
}

export async function listEvents(db: Db, bidDocumentId: string, afterId = 0) {
  return db.query<{ id: number; section_id: string | null; agent: string; kind: string; message: string; data: unknown; created_at: string }>(
    'SELECT id, section_id, agent, kind, message, data, created_at FROM agent_events WHERE bid_document_id = $1 AND id > $2 ORDER BY id LIMIT 500',
    [bidDocumentId, afterId],
  );
}

export async function usageTotals(db: Db, bidDocumentId: string) {
  // sum(bigint) ergibt numeric und käme als String an; das Ergebnis wird deshalb zurück auf bigint gesetzt.
  const row = await db.one<{ input: number; output: number; cache_read: number }>(
    `SELECT coalesce(sum((data->'usage'->>'inputTokens')::bigint), 0)::bigint AS input,
            coalesce(sum((data->'usage'->>'outputTokens')::bigint), 0)::bigint AS output,
            coalesce(sum((data->'usage'->>'cacheReadTokens')::bigint), 0)::bigint AS cache_read
     FROM agent_events WHERE bid_document_id = $1 AND kind = 'result'`,
    [bidDocumentId],
  );
  return { inputTokens: row?.input ?? 0, outputTokens: row?.output ?? 0, cacheReadTokens: row?.cache_read ?? 0 };
}

/** Beim Start: Läufe, die ein Neustart unterbrochen hat, sind nicht mehr „in Arbeit". */
export async function recoverInterruptedJobs(db: Db): Promise<number> {
  const stuck = await db.query<{ id: string; status: string }>(
    `UPDATE bid_documents SET
       status = CASE WHEN status = 'analyzing' THEN 'draft' WHEN status = 'writing' THEN 'outline_review' ELSE 'written' END,
       error = 'Der Lauf wurde durch einen Neustart des Servers unterbrochen. Bitte erneut starten.',
       updated_at = now()
     WHERE status IN ('analyzing', 'writing', 'reviewing') RETURNING id, status`,
  );
  await db.query(`UPDATE bid_sections SET status = 'pending' WHERE status IN ('researching', 'writing')`);
  return stuck.length;
}
