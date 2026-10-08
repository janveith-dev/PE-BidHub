import type { Fact, Requirement, SearchHit, SpecAnalysis } from '@bid/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { defineTool } from '../llm/index.js';
import { hybridSearch } from '../search.js';
import { normalizeForQuote, quoteInText } from './checks.js';
import { RESEARCHER_SYSTEM } from './prompts.js';
import { eventLogger, type Emit } from './run.js';
import type { BidDocumentRow, BidRow, SectionRow } from './store.js';

const MAX_FACTS = 30;

const SearchInput = z.object({
  query: z.string().min(1).describe('Suchbegriffe oder eine kurze Frage'),
  categories: z.array(z.enum(['product', 'concept', 'config', 'pricelist', 'certificate', 'reference', 'other'])).optional(),
  vendor: z.string().optional(),
});

const RecordFactInput = z.object({
  statement: z.string().min(10).max(600).describe('Eine überprüfbare Aussage in einem Satz'),
  quote: z.string().min(5).max(500).describe('Wörtliches Zitat aus der Quelle, das die Aussage belegt'),
  ref: z.string().optional().describe('Kürzel der Fundstelle aus search_knowledge, z. B. K3'),
  url: z.string().optional().describe('Adresse einer Quelle aus der Websuche'),
});

const ReportGapsInput = z.object({
  gaps: z
    .array(z.string().min(3).max(300))
    .max(20)
    .describe('Zugeordnete Anforderungen, die nicht belegt werden konnten, je Eintrag mit Kennung und fehlender Angabe. Leer, wenn alles belegt ist.'),
});

/** Adressen vergleichbar machen: ohne Fragment, ohne abschließenden Schrägstrich, Groß-/Kleinschreibung egal. */
const normalizeUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

export interface ResearchResult {
  facts: Fact[];
  /** Vom Rechercheur gemeldete, nicht belegte Punkte. Leer heißt: alles belegt. */
  gaps: string[];
  /** false, wenn der Rechercheur keine Lückenmeldung abgegeben hat — dann ist unbekannt, ob etwas fehlt. */
  gapsReported: boolean;
  webSources: { url: string; title: string }[];
}

export function requirementsBlock(reqs: Requirement[]): string {
  return reqs.length
    ? reqs.map((r) => `- ${r.id} (${r.kind}): ${r.text}${r.sourceQuote ? ` — Vorgabe: „${r.sourceQuote}"` : ''}`).join('\n')
    : '- (keine Anforderung direkt zugeordnet; behandle den Zweck des Kapitels)';
}

export async function researchSection(
  ctx: AppContext,
  p: {
    bid: BidRow;
    doc: BidDocumentRow;
    analysis: SpecAnalysis;
    section: SectionRow;
    requirements: Requirement[];
    allowWeb: boolean;
    instruction?: string | undefined;
    emit: Emit;
  },
): Promise<ResearchResult> {
  const { section, emit } = p;

  // Kürzel K1, K2 … statt UUIDs: Das Modell kann nur Fundstellen zitieren, die es wirklich gesehen hat.
  const refs = new Map<string, SearchHit>();
  const refOf = new Map<string, string>();
  const webUrls = new Map<string, { url: string; title: string }>();
  const facts: Fact[] = [];
  const seen = new Set<string>();

  const searchTool = defineTool({
    name: 'search_knowledge',
    description:
      'Durchsucht die Wissensbasis von public edge (Produkte, Konzeptbausteine, Konfigurationen, Preislisten, Zertifikate, Referenzen). Abgelaufene Dokumente sind ausgeschlossen. Liefert Fundstellen mit Kürzel (K1 …). Die Suche versteht Umschreibungen nur begrenzt: Probiere bei einem schwachen Ergebnis Synonyme und verwandte Begriffe aus (z. B. Rechenzentrum, Serverraum, Standort).',
    schema: SearchInput,
    run: async ({ query, categories, vendor }) => {
      const hits = await hybridSearch(ctx.db, ctx.embedder, {
        query, limit: 8, excludeExpired: true,
        ...(categories ? { categories } : {}), ...(vendor ? { vendor } : {}),
      });
      if (!hits.length) return 'Keine Fundstellen.';
      return hits
        .map((h) => {
          let ref = refOf.get(h.chunkId);
          if (!ref) {
            ref = `K${refs.size + 1}`;
            refs.set(ref, h);
            refOf.set(h.chunkId, ref);
          }
          const meta = [h.category, h.vendor, `Version ${h.version}`, h.validUntil ? `gültig bis ${h.validUntil}` : 'unbefristet'].filter(Boolean).join(', ');
          const where = [h.heading, h.page ? `Seite ${h.page}` : null].filter(Boolean).join(' · ');
          return `[${ref}] ${h.title} (${meta})${where ? `\nAbschnitt: ${where}` : ''}\n"""\n${h.content}\n"""`;
        })
        .join('\n\n');
    },
  });

  const recordTool = defineTool({
    name: 'record_fact',
    description:
      'Hält einen belegten Fakt fest. Entweder ref (Fundstelle aus search_knowledge) oder url (Quelle aus der Websuche) angeben. Das Zitat muss wörtlich in der Quelle stehen.',
    schema: RecordFactInput,
    run: async ({ statement, quote, ref, url }) => {
      if (facts.length >= MAX_FACTS) throw new Error(`Es sind höchstens ${MAX_FACTS} Fakten je Kapitel möglich.`);
      if (!!ref === !!url) throw new Error('Genau eines von ref und url angeben.');
      const key = normalizeForQuote(statement);
      if (seen.has(key)) return 'Dieser Fakt ist bereits erfasst.';

      let fact: Fact;
      if (ref) {
        const hit = refs.get(ref.toUpperCase());
        if (!hit) throw new Error(`Die Fundstelle ${ref} wurde in dieser Recherche nicht geliefert.`);
        if (!quoteInText(quote, hit.content)) {
          throw new Error(`Das Zitat steht nicht wörtlich in ${ref}. Zitiere exakt aus dem Fundstück.`);
        }
        fact = {
          id: `F${facts.length + 1}`, statement, sourceType: 'kb', sourceRef: hit.documentId,
          sourceTitle: hit.title, quote, validUntil: hit.validUntil, quoteVerified: true,
        };
      } else {
        const known = webUrls.get(normalizeUrl(url!));
        if (!known) throw new Error('Diese Adresse stammt nicht aus den Ergebnissen der Websuche dieser Recherche.');
        fact = {
          id: `F${facts.length + 1}`, statement, sourceType: 'web', sourceRef: known.url,
          sourceTitle: known.title, quote, quoteVerified: false,
        };
      }
      seen.add(key);
      facts.push(fact);
      return `Erfasst als ${fact.id}.`;
    },
  });

  let gaps: string[] = [];
  let gapsReported = false;
  const gapsTool = defineTool({
    name: 'report_gaps',
    description: 'Schließt die Recherche ab: meldet, welche zugeordneten Anforderungen sich nicht belegen ließen (leere Liste, wenn alles belegt ist).',
    schema: ReportGapsInput,
    run: async (input) => {
      gaps = input.gaps;
      gapsReported = true;
      return 'Lückenmeldung erfasst. Die Recherche ist abgeschlossen.';
    },
  });

  const log = eventLogger(emit, 'researcher', section.id);
  const result = await ctx.llm.run({
    model: ctx.config.models.research,
    system: RESEARCHER_SYSTEM({ allowWeb: p.allowWeb }),
    effort: 'medium',
    maxTokens: 16_000,
    maxTurns: 16,
    tools: [searchTool, recordTool, gapsTool],
    ...(p.allowWeb ? { webSearch: { maxUses: 5, blockedDomains: ctx.config.webBlockedDomains } } : {}),
    onEvent: (e) => {
      // Ergebnisse der Websuche vor dem nächsten Werkzeugaufruf vormerken: Nur diese Adressen dürfen zitiert werden.
      if (e.type === 'web_results') for (const s of e.sources) webUrls.set(normalizeUrl(s.url), s);
      log(e);
    },
    messages: [
      {
        role: 'user',
        content: [
          `Dokument: ${p.doc.title} für ${p.bid.customer}. Abgabefrist: ${p.bid.deadline ?? 'unbekannt'}.`,
          `Kapitel ${section.number} „${section.title}"`,
          `Zweck: ${section.purpose || '–'}`,
          `Zugeordnete Anforderungen:\n${requirementsBlock(p.requirements)}`,
          p.instruction ? `Hinweis des Bid Managers: ${p.instruction}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
  });

  await emit({
    agent: 'researcher', sectionId: section.id, kind: 'result',
    message: `${facts.length} Fakten belegt (${facts.filter((f) => f.sourceType === 'web').length} aus dem Web)`,
    data: { usage: result.usage },
  });
  return { facts, gaps, gapsReported, webSources: result.webSources };
}
