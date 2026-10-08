import { extractText, getDocumentProxy } from 'unpdf';
import type { ExtractContext, Extracted, Section } from './types.js';

/** Unter dieser Zeichenzahl pro Seite gilt eine PDF-Seite als eingescannt. */
const SCANNED_CHARS_PER_PAGE = 40;

export async function extractPdf(buffer: Buffer, filename: string, ctx: ExtractContext): Promise<Extracted> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  const sections: Section[] = pages.map((text, i) => ({
    heading: null,
    page: i + 1,
    text: text.replace(/[ \t]+\n/g, '\n').replace(/\u0000/g, ''),
  }));

  const chars = sections.reduce((n, s) => n + s.text.trim().length, 0);
  const warnings: string[] = [];
  const looksScanned = sections.length > 0 && chars / sections.length < SCANNED_CHARS_PER_PAGE;

  if (!looksScanned) return { sections, method: 'native', warnings };

  if (!ctx.ocr) {
    warnings.push(
      'Die PDF scheint eingescannt zu sein und enthält kaum Text. Für die Texterkennung wird der ML-Dienst benötigt (ML_SERVICE_URL).',
    );
    return { sections, method: 'native', warnings };
  }

  const recognized = await ctx.ocr.ocr(buffer, 'application/pdf', filename);
  return {
    method: 'ocr',
    warnings,
    sections: recognized.map((text, i) => ({ heading: null, page: i + 1, text })),
  };
}
