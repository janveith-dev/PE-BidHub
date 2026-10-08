import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import type { Extracted, Section } from './types.js';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string): string =>
  decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Eine Tabelle wird zu einer Textzeile je Zeile mit „ | " zwischen den Zellen.
 * Mammoth setzt Zellinhalte in Absätze; ohne eigene Behandlung bekäme jede Zelle
 * einen Absatzumbruch und eine SLA- oder Preistabelle zerfiele in Einzelwerte.
 */
function tableToText(tableHtml: string): string {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) =>
      [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((c) => stripTags(c[1]!))
        .join(' | '),
    )
    .filter((line) => line.replace(/[|\s]/g, '') !== '')
    .join('\n');
}

/** Wandelt das HTML aus mammoth in lesbaren Text mit Markdown-Überschriften, Listen und Tabellen. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<table[\s\S]*?<\/table>/gi, (table) => `\n\n${tableToText(table)}\n\n`)
      .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|ul|ol)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocx(buffer: Buffer): Promise<Extracted> {
  const { value, messages } = await mammoth.convertToHtml({ buffer });
  return {
    method: 'native',
    warnings: messages.filter((m) => m.type === 'warning').map((m) => m.message),
    sections: [{ heading: null, page: null, text: htmlToText(value) }],
  };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text);
    if ('error' in value) return '';
    return '';
  }
  return String(value).trim();
}

/** Zeilen einer Tabelle werden zu „Spalte | Spalte | …"; die erste nichtleere Zeile gilt als Kopfzeile. */
export async function extractXlsx(buffer: Buffer): Promise<Extracted> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sections: Section[] = [];

  for (const ws of wb.worksheets) {
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell.value)));
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) lines.push(cells.join(' | '));
    });
    if (!lines.length) continue;
    sections.push({
      heading: `Tabellenblatt ${ws.name}`,
      page: null,
      text: lines.join('\n'),
      repeatLine: lines[0]!,
    });
  }
  return { sections, method: 'native', warnings: [] };
}

function slideNumber(name: string): number {
  return Number.parseInt(/slide(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10);
}

export async function extractPptx(buffer: Buffer): Promise<Extracted> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const sections: Section[] = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name]!.async('string');
    const paragraphs = [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)]
      .map((m) =>
        decodeEntities(
          [...m[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(''),
        ).trim(),
      )
      .filter(Boolean);
    if (!paragraphs.length) continue;
    const n = slideNumber(name);
    sections.push({
      heading: `Folie ${n}: ${paragraphs[0]}`,
      page: n,
      text: paragraphs.join('\n\n'),
    });
  }
  return { sections, method: 'native', warnings: [] };
}
