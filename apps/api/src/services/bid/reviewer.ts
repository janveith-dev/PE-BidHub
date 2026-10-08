import { CoverageItemSchema, FindingSchema, type CoverageItem, type Finding, type SpecAnalysis } from '@bid/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { deterministicFindings } from './checks.js';
import { REVIEWER_SYSTEM } from './prompts.js';
import { runStructured, type Emit } from './run.js';
import type { BidDocumentRow, BidRow, SectionRow } from './store.js';

const ReviewOutputSchema = z.object({
  coverage: z.array(CoverageItemSchema),
  findings: z.array(FindingSchema.omit({ id: true })),
  summary: z.string(),
});

export interface ReviewResult {
  coverage: CoverageItem[];
  findings: Finding[];
  summary: string;
}

const SEVERITY_ORDER = { blocker: 0, major: 1, minor: 2 } as const;

/** Bringt die Antwort des Prüfers in eine vollständige, in sich stimmige Form. */
export function normalizeReview(
  raw: z.infer<typeof ReviewOutputSchema>,
  analysis: SpecAnalysis,
  sections: SectionRow[],
  extra: Omit<Finding, 'id'>[],
): ReviewResult {
  const sectionIds = new Set(sections.map((s) => s.outline_id));
  const byRequirement = new Map(raw.coverage.map((c) => [c.requirementId, c]));

  // Jede Anforderung bekommt einen Eintrag; was der Prüfer ausgelassen hat, gilt nicht als erfüllt.
  const coverage: CoverageItem[] = analysis.requirements.map((r) => {
    const c = byRequirement.get(r.id);
    if (!c) return { requirementId: r.id, status: 'missing', sectionIds: [], comment: 'Vom Prüfer nicht bewertet.' };
    const known = c.sectionIds.filter((id) => sectionIds.has(id));
    // „Erfüllt" ohne Fundstelle im Text ist nicht belegbar.
    if (c.status === 'covered' && known.length === 0) {
      return { ...c, status: 'partial', sectionIds: [], comment: `${c.comment} (Keine Kapitelzuordnung — Bewertung herabgestuft.)` };
    }
    return { ...c, sectionIds: known };
  });

  const requirementIds = new Set(analysis.requirements.map((r) => r.id));
  const findings = [...raw.findings, ...extra]
    .map((f) => ({
      ...f,
      ...(f.sectionId && !sectionIds.has(f.sectionId) ? { sectionId: undefined } : {}),
      ...(f.requirementId && !requirementIds.has(f.requirementId) ? { requirementId: undefined } : {}),
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((f, i): Finding => ({ ...f, id: `B-${String(i + 1).padStart(3, '0')}` }));

  return { coverage, findings, summary: raw.summary };
}

export async function reviewDocument(
  ctx: AppContext,
  p: { bid: BidRow; doc: BidDocumentRow; analysis: SpecAnalysis; sections: SectionRow[]; emit: Emit; today?: string },
): Promise<ReviewResult> {
  const { analysis, sections } = p;
  const today = p.today ?? new Date().toISOString().slice(0, 10);

  const text = [
    `Dokument: ${p.doc.title} für ${p.bid.customer}`,
    `Formvorgaben:\n${analysis.formalRules.map((r) => `- ${r}`).join('\n') || '- keine'}`,
    `Bewertungskriterien:\n${analysis.evaluationCriteria.map((r) => `- ${r}`).join('\n') || '- keine genannt'}`,
    `Anforderungen:\n${analysis.requirements.map((r) => `${r.id} (${r.kind}, ${r.topic}): ${r.text}`).join('\n')}`,
    `Kapitel:\n${sections
      .map((s) => `=== ${s.outline_id} · Kapitel ${s.number} „${s.title}" ===\nFakten dieses Kapitels:\n${s.facts.map((f) => `[${f.id}] ${f.statement}`).join('\n') || '(keine)'}\nText:\n${s.content || '(leer)'}`)
      .join('\n\n')}`,
  ].join('\n\n');

  const result = await runStructured(
    ctx,
    {
      model: ctx.config.models.reviewer,
      system: REVIEWER_SYSTEM,
      effort: 'high',
      maxTokens: 64_000,
      output: ReviewOutputSchema,
      messages: [{ role: 'user', content: text }],
    },
    p.emit,
    'reviewer',
  );

  const checks = deterministicFindings(
    sections.map((s) => ({ outlineId: s.outline_id, number: s.number, title: s.title, content: s.content, facts: s.facts, maxWords: s.max_words })),
    { today, deadline: p.bid.deadline },
  );
  const review = normalizeReview(result.parsed!, analysis, sections, checks);
  await p.emit({
    agent: 'reviewer', kind: 'result',
    message: `${review.coverage.filter((c) => c.status === 'covered').length} von ${review.coverage.length} Anforderungen erfüllt, ${review.findings.length} Befunde`,
    data: { usage: result.usage },
  });
  return review;
}
