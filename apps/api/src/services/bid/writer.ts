import type { AuthorRole, Fact, Requirement, SpecAnalysis } from '@bid/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { countWords, openPoints, sameProtectedTokens, stripUnknownMarkers } from './checks.js';
import { requirementsBlock } from './research.js';
import { REVISER_SYSTEM, writerSystem } from './prompts.js';
import { runStructured, type Emit } from './run.js';
import type { BidDocumentRow, BidRow, SectionRow } from './store.js';

export const WriterOutputSchema = z.object({
  content: z.string().min(20),
  usedFactIds: z.array(z.string()),
  openPoints: z.array(z.string()),
  addressedRequirementIds: z.array(z.string()),
});

const ReviseOutputSchema = z.object({ content: z.string().min(1), summary: z.string() });

export function factsBlock(facts: Fact[]): string {
  if (!facts.length)
    return '(keine Fakten verfügbar — setze bei allem Firmenspezifischen [OFFEN: …])';
  return facts
    .map((f) => {
      const where = f.sourceType === 'web' ? `Web: ${f.sourceRef}` : 'Wissensbasis';
      return `[${f.id}] ${f.statement} — Quelle: ${f.sourceTitle} (${where}${f.validUntil ? `, gültig bis ${f.validUntil}` : ''})`;
    })
    .join('\n');
}

function outlineBlock(analysis: SpecAnalysis, currentId: string): string {
  return analysis.outline
    .map((s) => `${s.number} ${s.title}${s.id === currentId ? '  ← dein Kapitel' : ''}`)
    .join('\n');
}

export interface WriteResult {
  content: string;
  notes: string;
  openPoints: string[];
  addressed: string[];
}

export async function writeSection(
  ctx: AppContext,
  p: {
    bid: BidRow;
    doc: BidDocumentRow;
    analysis: SpecAnalysis;
    section: SectionRow;
    requirements: Requirement[];
    facts: Fact[];
    gaps: string[];
    gapsReported: boolean;
    instruction?: string | undefined;
    previous?: string | undefined;
    emit: Emit;
  },
): Promise<WriteResult> {
  const { section, emit } = p;
  const agent = `writer:${section.author_role}`;

  const result = await runStructured(
    ctx,
    {
      model: ctx.config.models.writer,
      system: writerSystem({
        role: section.author_role as AuthorRole,
        docTitle: p.doc.title,
        customer: p.bid.customer,
        language: p.analysis.language,
        analysis: p.analysis,
        targetWords: section.target_words,
        maxWords: section.max_words,
      }),
      effort: 'high',
      maxTokens: 32_000,
      output: WriterOutputSchema,
      messages: [
        {
          role: 'user',
          content: [
            `Gliederung des Gesamtdokuments (schreibe nur dein Kapitel, verweise bei Bedarf mit „siehe Kapitel X"):\n${outlineBlock(p.analysis, section.outline_id)}`,
            `Dein Kapitel: ${section.number} „${section.title}"\nZweck: ${section.purpose || '–'}`,
            `Zugeordnete Anforderungen:\n${requirementsBlock(p.requirements)}`,
            `Fakten:\n${factsBlock(p.facts)}`,
            p.gaps.length
              ? `Lücken laut Recherche:\n${p.gaps.map((g) => `- ${g}`).join('\n')}`
              : '',
            p.instruction ? `Anweisung des Bid Managers: ${p.instruction}` : '',
            p.previous
              ? `Bisheriger Text (überarbeite ihn entsprechend der Anweisung):\n${p.previous}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
    emit,
    agent,
    section.id,
  );

  const notes: string[] = [];
  const cleaned = stripUnknownMarkers(result.parsed!.content, p.facts);
  let content = cleaned.content.trim();
  if (cleaned.removed.length)
    notes.push(`Unbekannte Quellenmarken entfernt: ${[...new Set(cleaned.removed)].join(', ')}.`);

  if (section.max_words && countWords(content) > section.max_words) {
    const before = countWords(content);
    await emit({
      agent,
      sectionId: section.id,
      kind: 'info',
      message: `${before} Wörter bei Grenze ${section.max_words} — Kürzung wird angefordert`,
    });
    const shortened = await reviseText(ctx, {
      ...p,
      content,
      instruction: `Kürze das Kapitel auf höchstens ${section.max_words} Wörter, ohne eine zugeordnete Anforderung aufzugeben. Streiche zuerst Wiederholungen und Allgemeines.`,
      agent,
    });
    if (countWords(shortened.content) < before) content = shortened.content;
    if (countWords(content) > section.max_words) {
      notes.push(
        `Längenlimit überschritten: ${countWords(content)} von höchstens ${section.max_words} Wörtern.`,
      );
    }
  }

  const open = openPoints(content);
  if (open.length) notes.push(`Offene Punkte: ${open.join('; ')}`);
  if (p.gaps.length) notes.push(`Lücken laut Recherche: ${p.gaps.join('; ')}`);
  else if (!p.gapsReported)
    notes.push(
      'Die Recherche hat keine Lückenmeldung abgegeben — Vollständigkeit der Fakten prüfen.',
    );

  await emit({
    agent,
    sectionId: section.id,
    kind: 'result',
    message: `${countWords(content)} Wörter, ${open.length} offene Punkte`,
    data: { usage: result.usage, servedBy: result.servedBy },
  });
  return {
    content,
    notes: notes.join('\n'),
    openPoints: open,
    addressed: result.parsed!.addressedRequirementIds,
  };
}

export async function reviseText(
  ctx: AppContext,
  p: {
    bid: BidRow;
    doc: BidDocumentRow;
    analysis: SpecAnalysis;
    section: SectionRow;
    facts: Fact[];
    content: string;
    instruction: string;
    emit: Emit;
    agent?: string;
    model?: string;
  },
): Promise<{ content: string; summary: string }> {
  const agent = p.agent ?? 'lektor';
  const result = await runStructured(
    ctx,
    {
      model: p.model ?? ctx.config.models.editor,
      system: REVISER_SYSTEM({
        language: p.analysis.language,
        analysis: p.analysis,
        maxWords: p.section.max_words,
      }),
      effort: 'medium',
      maxTokens: 32_000,
      output: ReviseOutputSchema,
      messages: [
        {
          role: 'user',
          content: `Kapitel ${p.section.number} „${p.section.title}"\n\nFakten:\n${factsBlock(p.facts)}\n\nAktueller Text:\n"""\n${p.content}\n"""\n\nAnweisung: ${p.instruction}`,
        },
      ],
    },
    p.emit,
    agent,
    p.section.id,
  );
  await p.emit({
    agent,
    sectionId: p.section.id,
    kind: 'result',
    message: result.parsed!.summary,
    data: { usage: result.usage },
  });
  const cleaned = stripUnknownMarkers(result.parsed!.content, p.facts);
  return { content: cleaned.content.trim(), summary: result.parsed!.summary };
}

export const POLISH_INSTRUCTION =
  'Glätte Stil und Lesbarkeit: einheitlicher Ton, kurze klare Sätze, Begriffe des Auftraggebers durchgängig verwenden, Füllwörter und Wiederholungen streichen. Inhalt, Zahlen und Quellenmarken bleiben unverändert.';

type ReviseParams = Parameters<typeof reviseText>[1];

/** Reine Stilbearbeitung: Wird eine Zahl oder Quellenmarke verändert, wird das Ergebnis verworfen. */
export async function polishText(
  ctx: AppContext,
  p: Omit<ReviseParams, 'instruction'>,
): Promise<{ content: string; changed: boolean; reason?: string }> {
  const result = await reviseText(ctx, { ...p, instruction: POLISH_INSTRUCTION });
  if (!sameProtectedTokens(p.content, result.content)) {
    return {
      content: p.content,
      changed: false,
      reason: 'Zahlen oder Quellenmarken wurden verändert — Überarbeitung verworfen.',
    };
  }
  return { content: result.content, changed: result.content.trim() !== p.content.trim() };
}
