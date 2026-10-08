import type { ChatSource, SearchHit } from '@bid/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound } from './errors.js';
import { defineTool, type AgentEvent, type ChatTurn } from './llm/index.js';
import { hybridSearch } from './search.js';

const HISTORY_TURNS = 20;

const SYSTEM = `Du bist der Presales-Assistent der public edge GmbH, eines IT-Partners für den öffentlichen Sektor (souveräne IT, Rechenzentrum, Arbeitsplatz; Fokuspartner u. a. Dell, Hitachi Vantara, Fsas, HP, Lenovo, NetApp und Huawei).
Du hilfst dem Vertrieb, schnell die richtigen Unterlagen und Fakten zu finden: Produktdokumentation, Konzeptbausteine, Konfigurationen, Preislisten, Zertifikate und Referenzen aus der Wissensbasis.

Regeln:
- Suche mit search_knowledge, bevor du eine inhaltliche Frage beantwortest. Wenn die erste Suche nichts Passendes liefert, versuche andere Begriffe, eine andere Kategorie oder den Hersteller.
- Antworte ausschließlich mit dem, was in den Fundstellen steht. Enthält die Wissensbasis nichts dazu, sage das klar und nenne, welches Dokument man hochladen könnte. Allgemeines Wissen nur, wenn du es ausdrücklich als solches kennzeichnest.
- Belege jede Sachaussage mit der Quellennummer in eckigen Klammern, zum Beispiel [Q2]. Erfinde keine Nummern.
- Weise darauf hin, wenn eine Quelle abgelaufen (expired) ist oder bald abläuft (expiring). Preise und Zertifikate immer mit Gültigkeit nennen.
- Gib Preise, Artikelnummern und Zahlen exakt wie in der Quelle wieder, mit Währung und Stand. Rechne nicht selbst um und runde nicht.
- Antworte in der Sprache der Frage. Knapp und sachlich, ohne Einleitungsfloskeln.`;

const SPOKEN = `
Die Antwort wird vorgelesen: höchstens vier kurze Sätze, keine Aufzählungen, Tabellen oder Links. Schreibe Zahlen und Abkürzungen so, wie man sie spricht. Quellenmarken wie [Q1] setzt du trotzdem; sie werden nicht mitgesprochen.`;

const SearchInput = z.object({
  query: z.string().min(1).describe('Suchbegriffe oder eine kurze Frage'),
  categories: z
    .array(z.enum(['product', 'concept', 'config', 'pricelist', 'certificate', 'reference', 'other']))
    .optional()
    .describe('Auf Kategorien einschränken'),
  vendor: z.string().optional().describe('Auf einen Hersteller einschränken, z. B. Dell'),
});

export interface ChatTurnResult {
  sessionId: string;
  answer: string;
  sources: ChatSource[];
}

export interface ChatCallbacks {
  onSession?: (id: string) => void;
  onText?: (delta: string) => void;
  onEvent?: (e: AgentEvent) => void;
}

function formatHit(n: number, h: SearchHit): string {
  const meta = [
    h.category,
    h.vendor,
    `Version ${h.version}`,
    h.validUntil ? `gültig bis ${h.validUntil}` : 'unbefristet',
    `validity=${h.validity}`,
  ].filter(Boolean);
  const where = [h.heading, h.page ? `Seite ${h.page}` : null].filter(Boolean).join(' · ');
  return `[Q${n}] ${h.title} (${meta.join(', ')})${where ? `\nAbschnitt: ${where}` : ''}\n"""\n${h.content}\n"""`;
}

export async function chatTurn(
  ctx: AppContext,
  input: {
    sessionId?: string | undefined;
    message: string;
    spoken: boolean;
    role?: string | undefined;
    signal?: AbortSignal | undefined;
  },
  cb: ChatCallbacks = {},
): Promise<ChatTurnResult> {
  const { db } = ctx;

  let sessionId = input.sessionId;
  if (sessionId) {
    const exists = await db.one('SELECT 1 FROM chat_sessions WHERE id = $1', [sessionId]);
    if (!exists) throw notFound('Chat-Sitzung');
  } else {
    const title = input.message.replace(/\s+/g, ' ').slice(0, 60);
    sessionId = (await db.one<{ id: string }>('INSERT INTO chat_sessions (title, role) VALUES ($1, $2) RETURNING id', [
      title, input.role ?? null,
    ]))!.id;
  }
  cb.onSession?.(sessionId);

  const history = await db.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT ${HISTORY_TURNS}
     ) t ORDER BY created_at ASC`,
    [sessionId],
  );
  const messages: ChatTurn[] = [...history, { role: 'user', content: input.message }];

  // Quellen werden über alle Suchen eines Durchlaufs fortlaufend nummeriert; dasselbe Fundstück behält seine Nummer.
  const registry = new Map<string, { n: number; hit: SearchHit }>();
  const searchTool = defineTool({
    name: 'search_knowledge',
    description:
      'Durchsucht die Wissensbasis (Produktdokumentation, Konzeptbausteine, Konfigurationen, Preislisten, Zertifikate, Referenzen). Liefert nummerierte Fundstellen mit Gültigkeitsangabe. Die Suche versteht Umschreibungen nur begrenzt: Probiere bei einem schwachen Ergebnis Synonyme und verwandte Begriffe aus (z. B. Rechenzentrum, Serverraum, Standort).',
    schema: SearchInput,
    run: async ({ query, categories, vendor }) => {
      const hits = await hybridSearch(db, ctx.embedder, {
        query, limit: 6, excludeExpired: false,
        ...(categories ? { categories } : {}), ...(vendor ? { vendor } : {}),
      });
      if (!hits.length) return 'Keine Fundstellen. Die Wissensbasis enthält dazu nichts Passendes.';
      return hits
        .map((hit) => {
          const known = registry.get(hit.chunkId);
          const entry = known ?? { n: registry.size + 1, hit };
          registry.set(hit.chunkId, entry);
          return formatHit(entry.n, hit);
        })
        .join('\n\n');
    },
  });

  const result = await ctx.llm.run({
    model: ctx.config.models.chat,
    system: SYSTEM + (input.spoken ? SPOKEN : ''),
    messages,
    effort: 'low',
    maxTokens: 4000,
    tools: [searchTool],
    maxTurns: 6,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(cb.onText ? { onText: cb.onText } : {}),
    ...(cb.onEvent ? { onEvent: cb.onEvent } : {}),
  });

  const answer = result.text.trim();
  const cited = new Set([...answer.matchAll(/\[Q(\d+)\]/g)].map((m) => Number(m[1])));
  const all = [...registry.values()].sort((a, b) => a.n - b.n);
  // Nur zitierte Quellen anzeigen; fehlt jede Marke, sind die Fundstellen trotzdem der Beleg der Antwort.
  const shown = cited.size ? all.filter((e) => cited.has(e.n)) : all.slice(0, 5);
  const sources: ChatSource[] = shown.map(({ n, hit }) => ({
    ref: `Q${n}`,
    documentId: hit.documentId,
    title: hit.title,
    heading: hit.heading,
    page: hit.page,
    validity: hit.validity,
    excerpt: hit.content.slice(0, 280),
  }));

  await db.tx(async (tx) => {
    await tx.query('INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)', [sessionId, 'user', input.message]);
    await tx.query('INSERT INTO chat_messages (session_id, role, content, sources) VALUES ($1, $2, $3, $4::jsonb)', [
      sessionId, 'assistant', answer, JSON.stringify(sources),
    ]);
    await tx.query('UPDATE chat_sessions SET updated_at = now() WHERE id = $1', [sessionId]);
  });

  return { sessionId, answer, sources };
}

export async function listSessions(db: AppContext['db']) {
  return db.query<{ id: string; title: string; role: string | null; updated_at: string }>(
    'SELECT id, title, role, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT 100',
  );
}

export async function getSession(db: AppContext['db'], id: string) {
  const session = await db.one<{ id: string; title: string }>('SELECT id, title FROM chat_sessions WHERE id = $1', [id]);
  if (!session) throw notFound('Chat-Sitzung');
  const messages = await db.query<{ id: string; role: string; content: string; sources: ChatSource[]; created_at: string }>(
    'SELECT id, role, content, sources, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at, role DESC',
    [id],
  );
  return { ...session, messages };
}

export async function deleteSession(db: AppContext['db'], id: string): Promise<void> {
  const row = await db.one('DELETE FROM chat_sessions WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Chat-Sitzung');
}
