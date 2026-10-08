import { SpecAnalysisSchema, type SpecAnalysis } from '@bid/shared';
import type { AppContext } from '../../context.js';
import { quoteInText } from './checks.js';
import { ANALYST_SYSTEM } from './prompts.js';
import { runStructured, type Emit } from './run.js';
import type { BidDocumentRow, BidRow } from './store.js';

export interface AnalysisResult {
  analysis: SpecAnalysis;
  /** Hinweise für den Bid Manager vor der Freigabe. */
  warnings: string[];
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Vergibt IDs selbst (das Modell liefert gelegentlich Dubletten), belegt Zitate
 * gegen die Vorgabe und prüft, dass jede Muss-Anforderung einem Kapitel zugeordnet ist.
 */
export function normalizeAnalysis(raw: SpecAnalysis, specText: string): AnalysisResult {
  const warnings: string[] = [];
  const idMap = new Map<string, string>();

  const requirements = raw.requirements.map((r, i) => {
    const id = `R-${pad(i + 1, 3)}`;
    if (!idMap.has(r.id)) idMap.set(r.id, id);
    const quoteVerified = r.sourceQuote ? quoteInText(r.sourceQuote, specText) : undefined;
    return { ...r, id, ...(quoteVerified === undefined ? {} : { quoteVerified }) };
  });

  const unverified = requirements.filter((r) => r.quoteVerified === false).length;
  if (unverified)
    warnings.push(
      `${unverified} Zitat(e) konnten in der Vorgabe nicht wiedergefunden werden — bitte gegen das Original prüfen.`,
    );

  let dropped = 0;
  const outline = raw.outline.map((s, i) => {
    const requirementIds = [
      ...new Set(
        s.requirementIds.flatMap((id) => {
          const mapped = idMap.get(id);
          if (!mapped) dropped++;
          return mapped ? [mapped] : [];
        }),
      ),
    ];
    return {
      ...s,
      id: `S-${pad(i + 1, 2)}`,
      level: Math.min(3, Math.max(1, s.level)),
      requirementIds,
    };
  });
  if (dropped)
    warnings.push(
      `${dropped} Verweis(e) der Gliederung auf unbekannte Anforderungen wurden entfernt.`,
    );

  const assigned = new Set(outline.flatMap((s) => s.requirementIds));
  const missing = requirements.filter((r) => r.kind === 'must' && !assigned.has(r.id));
  if (missing.length) {
    warnings.push(
      `${missing.length} Muss-Anforderung(en) sind keinem Kapitel zugeordnet: ${missing.map((r) => r.id).join(', ')}.`,
    );
  }
  if (!outline.length) warnings.push('Die Gliederung ist leer.');
  if (!requirements.length) warnings.push('Es wurden keine Anforderungen erkannt.');

  return { analysis: { ...raw, requirements, outline }, warnings };
}

export async function runAnalyst(
  ctx: AppContext,
  doc: BidDocumentRow,
  bid: BidRow,
  emit: Emit,
): Promise<AnalysisResult> {
  const result = await runStructured(
    ctx,
    {
      model: ctx.config.models.analyst,
      system: ANALYST_SYSTEM,
      effort: 'high',
      maxTokens: 64_000,
      output: SpecAnalysisSchema,
      messages: [
        {
          role: 'user',
          content: `Zu erstellendes Dokument: ${doc.title}\nAuftraggeber: ${bid.customer}\nSprache laut Auftrag: ${bid.language}\n\nVorgabe des Auftraggebers:\n"""\n${doc.spec_text}\n"""`,
        },
      ],
    },
    emit,
    'analyst',
  );
  await emit({
    agent: 'analyst',
    kind: 'result',
    message: `${result.parsed!.requirements.length} Anforderungen, ${result.parsed!.outline.length} Kapitel erkannt`,
    data: { usage: result.usage },
  });
  return normalizeAnalysis(result.parsed!, doc.spec_text);
}
