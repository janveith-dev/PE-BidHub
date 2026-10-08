import type { Fact, Finding } from '@bid/shared';

/** Faktenmarken im Text: [F3]. Sie gelten je Kapitel. */
const FACT_MARKER = /\[F(\d+)\]/g;
const OPEN_POINT = /\[OFFEN:\s*([^\]]*)\]/g;

/** Vergleichsform für Zitate: Groß-/Kleinschreibung, Leerraum, Anführungszeichen und Striche vereinheitlicht. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/[„“”«»‚‘’'"`´]/g, '"')
    .replace(/[–—−‐‑]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function quoteInText(quote: string, text: string): boolean {
  const q = normalizeForQuote(quote).replace(/^[.…\s"]+|[.…\s"]+$/g, '');
  return q.length >= 5 && normalizeForQuote(text).includes(q);
}

/** Wörter ohne Faktenmarken und Markdown-Zeichen — das ist die Größe, gegen die Längenvorgaben geprüft werden. */
export function countWords(markdown: string): number {
  const plain = markdown
    .replace(FACT_MARKER, '')
    .replace(/[#>*_`|]/g, ' ')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return plain.split(/\s+/).filter(Boolean).length;
}

export function factMarkers(content: string): string[] {
  return [...content.matchAll(FACT_MARKER)].map((m) => `F${m[1]}`);
}

export function openPoints(content: string): string[] {
  return [...content.matchAll(OPEN_POINT)].map((m) => m[1]!.trim()).filter(Boolean);
}

/** Entfernt Marken, die zu keinem Fakt des Kapitels gehören. Eine erfundene Quelle ist schlimmer als keine. */
export function stripUnknownMarkers(
  content: string,
  facts: Fact[],
): { content: string; removed: string[] } {
  const known = new Set(facts.map((f) => f.id));
  const removed: string[] = [];
  const cleaned = content.replace(FACT_MARKER, (marker, n: string) => {
    if (known.has(`F${n}`)) return marker;
    removed.push(`F${n}`);
    return '';
  });
  return { content: cleaned.replace(/ +([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' '), removed };
}

/** Zahlen und Faktenmarken eines Textes — beides darf eine reine Stilbearbeitung nicht verändern. */
export function protectedTokens(content: string): string[] {
  return [...(content.match(/\d+(?:[.,]\d+)*|\[F\d+\]/g) ?? [])].sort();
}

export function sameProtectedTokens(before: string, after: string): boolean {
  const a = protectedTokens(before);
  const b = protectedTokens(after);
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

export interface SectionForChecks {
  outlineId: string;
  number: string;
  title: string;
  content: string;
  facts: Fact[];
  maxWords: number | null;
}

/**
 * Prüfungen, die kein Modell braucht und die deshalb nicht von dessen Urteil abhängen:
 * Länge, Quellenmarken, offene Punkte und Gültigkeit der verwendeten Quellen.
 */
export function deterministicFindings(
  sections: SectionForChecks[],
  opts: { today: string; deadline: string | null },
): Omit<Finding, 'id'>[] {
  const out: Omit<Finding, 'id'>[] = [];
  const label = (s: SectionForChecks) => `Kapitel ${s.number} „${s.title}"`;

  for (const s of sections) {
    const words = countWords(s.content);
    if (s.maxWords && words > s.maxWords) {
      out.push({
        severity: 'blocker',
        kind: 'length',
        sectionId: s.outlineId,
        message: `${label(s)} hat ${words} Wörter; zulässig sind höchstens ${s.maxWords}.`,
      });
    }
    if (!s.content.trim()) {
      out.push({
        severity: 'blocker',
        kind: 'coverage',
        sectionId: s.outlineId,
        message: `${label(s)} ist leer.`,
      });
      continue;
    }
    for (const point of openPoints(s.content)) {
      out.push({
        severity: 'major',
        kind: 'coverage',
        sectionId: s.outlineId,
        message: `${label(s)}: offener Punkt — ${point}`,
      });
    }
    const known = new Set(s.facts.map((f) => f.id));
    const unknown = [...new Set(factMarkers(s.content).filter((m) => !known.has(m)))];
    if (unknown.length) {
      out.push({
        severity: 'major',
        kind: 'unsupported_claim',
        sectionId: s.outlineId,
        message: `${label(s)} verweist auf unbekannte Quellenmarken: ${unknown.join(', ')}.`,
      });
    }

    const used = new Set(factMarkers(s.content));
    for (const fact of s.facts.filter((f) => used.has(f.id))) {
      if (!fact.validUntil) continue;
      if (fact.validUntil < opts.today) {
        out.push({
          severity: 'blocker',
          kind: 'stale_source',
          sectionId: s.outlineId,
          message: `${label(s)} stützt sich auf „${fact.sourceTitle}", gültig bis ${fact.validUntil} — abgelaufen.`,
        });
      } else if (opts.deadline && fact.validUntil < opts.deadline) {
        out.push({
          severity: 'major',
          kind: 'stale_source',
          sectionId: s.outlineId,
          message: `${label(s)} stützt sich auf „${fact.sourceTitle}", gültig bis ${fact.validUntil} — läuft vor der Abgabefrist (${opts.deadline}) ab.`,
        });
      }
    }
  }
  return out;
}
