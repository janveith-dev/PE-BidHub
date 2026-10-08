import { validityOf, type SearchHit, type SearchRequest } from '@bid/shared';
import { toVectorLiteral, type Db } from '../db/client.js';
import type { Embedder } from './embeddings.js';

const CANDIDATES = 40;
const RRF_K = 60;
const MAX_CHUNKS_PER_DOCUMENT = 3;

const STOP = new Set(
  'der die das und oder nicht mit für ist sind wird werden eine einer einen von zu im in auf den dem des als auch wie was welche welcher welches gibt es wir ihr sie ein the and of to is are with for that this on be as by from or an a what which how do does'.split(
    ' ',
  ),
);

/**
 * Baut eine ODER-verknüpfte tsquery. Wörter ab vier Zeichen werden als Präfix
 * gesucht: der deutsche Stemmer führt „Rechenzentrum" und „Rechenzentren" auf
 * verschiedene Stämme, das Präfix `rechenzentr:*` trifft beide.
 */
export function buildTsQuery(query: string): string | null {
  const tokens = [...new Set([...query.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]))]
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => (t.length >= 4 ? `${t}:*` : t)).join(' | ');
}

function filterSql(req: SearchRequest, params: unknown[]): string {
  const parts = ['d.is_current = true'];
  if (req.categories?.length)
    parts.push(`d.category = ANY($${params.push(req.categories)}::text[])`);
  if (req.vendor) parts.push(`d.vendor ILIKE $${params.push(req.vendor)}`);
  if (req.excludeExpired) parts.push('(d.valid_until IS NULL OR d.valid_until >= current_date)');
  return parts.join(' AND ');
}

interface HitRow {
  chunk_id: string;
  document_id: string;
  title: string;
  category: SearchHit['category'];
  vendor: string | null;
  heading: string | null;
  page: number | null;
  content: string;
  valid_until: string | null;
  version: number;
}

/**
 * Hybridsuche: Volltext (deutsch + englisch, Präfixe) und Vektorähnlichkeit
 * liefern je eine Rangliste, die per Reciprocal Rank Fusion zusammengeführt
 * wird. Der Volltext findet exakte Bezeichner wie „R760" oder „ISO 27001", die
 * Vektoren finden Umschreibungen.
 */
export async function hybridSearch(
  db: Db,
  embedder: Embedder,
  req: SearchRequest,
): Promise<SearchHit[]> {
  const ranks = new Map<string, number>();
  const add = (ids: string[]): void =>
    ids.forEach((id, i) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + i + 1)));

  const tsquery = buildTsQuery(req.query);
  if (tsquery) {
    const params: unknown[] = [tsquery];
    const where = filterSql(req, params);
    const rows = await db.query<{ id: string }>(
      `WITH q AS (SELECT to_tsquery('german', $1) || to_tsquery('english', $1) AS tsq)
       SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id, q
       WHERE c.tsv @@ q.tsq AND ${where}
       ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC LIMIT ${CANDIDATES}`,
      params,
    );
    add(rows.map((r) => r.id));
  }

  const [queryVector] = await embedder.embed([req.query], 'query');
  if (queryVector) {
    const params: unknown[] = [toVectorLiteral(queryVector), embedder.name];
    const where = filterSql(req, params);
    const rows = await db.query<{ id: string }>(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding_model = $2 AND ${where}
       ORDER BY c.embedding <=> $1::vector LIMIT ${CANDIDATES}`,
      params,
    );
    add(rows.map((r) => r.id));
  }

  const ordered = [...ranks.entries()].sort((a, b) => b[1] - a[1]);
  if (!ordered.length) return [];

  const ids = ordered.map(([id]) => id);
  const details = await db.query<HitRow>(
    `SELECT c.id AS chunk_id, d.id AS document_id, d.title, d.category, d.vendor, c.heading, c.page, c.content, d.valid_until, d.version
     FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(details.map((r) => [r.chunk_id, r]));

  const perDocument = new Map<string, number>();
  const hits: SearchHit[] = [];
  for (const [id, score] of ordered) {
    const row = byId.get(id);
    if (!row) continue;
    const n = perDocument.get(row.document_id) ?? 0;
    if (n >= MAX_CHUNKS_PER_DOCUMENT) continue;
    perDocument.set(row.document_id, n + 1);
    hits.push({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      category: row.category,
      vendor: row.vendor,
      heading: row.heading,
      page: row.page,
      content: row.content,
      score,
      validUntil: row.valid_until,
      validity: validityOf(row.valid_until),
      version: row.version,
    });
    if (hits.length >= req.limit) break;
  }
  return hits;
}
