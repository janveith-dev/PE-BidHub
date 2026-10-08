import path from 'node:path';
import { unprocessable } from '../errors.js';
import { extractDocx, extractPptx, extractXlsx } from './office.js';
import { extractPdf } from './pdf.js';
import { extractPlain } from './text.js';
import type { ExtractContext, Extracted, Section } from './types.js';

export type { ExtractContext, Extracted, OcrProvider, Section } from './types.js';

const PLAIN_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.ini', '.conf', '.cfg', '.toml', '.log', '.properties', '.env', '.sh', '.ps1', '.tf', '.j2', '.rst',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);

export const SUPPORTED_HINT =
  'PDF, DOCX, XLSX, PPTX, Textformate (TXT, MD, CSV, JSON, YAML, XML, CFG, CONF …) und — mit ML-Dienst — Bilder';

export async function extractText(
  buffer: Buffer,
  filename: string,
  mime: string,
  ctx: ExtractContext = {},
): Promise<Extracted> {
  const ext = path.extname(filename).toLowerCase();

  let result: Extracted;
  if (ext === '.pdf' || mime === 'application/pdf') result = await extractPdf(buffer, filename, ctx);
  else if (ext === '.docx') result = await extractDocx(buffer);
  else if (ext === '.xlsx' || ext === '.xlsm') result = await extractXlsx(buffer);
  else if (ext === '.pptx') result = await extractPptx(buffer);
  else if (PLAIN_EXTENSIONS.has(ext) || mime.startsWith('text/')) result = extractPlain(buffer, filename);
  else if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
    if (!ctx.ocr) throw unprocessable('Bilder lassen sich nur mit dem ML-Dienst (Texterkennung) aufnehmen.');
    const pages = await ctx.ocr.ocr(buffer, mime, filename);
    result = { method: 'ocr', warnings: [], sections: pages.map((text, i) => ({ heading: null, page: i + 1, text })) };
  } else if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    throw unprocessable(`Das alte Binärformat ${ext} wird nicht gelesen. Bitte als ${ext}x speichern oder als PDF exportieren.`);
  } else {
    throw unprocessable(`Dateityp ${ext || mime} wird nicht unterstützt. Unterstützt: ${SUPPORTED_HINT}.`);
  }

  const sections: Section[] = result.sections.filter((s) => s.text.trim().length > 0);
  if (!sections.length) {
    throw unprocessable(
      result.warnings[0] ?? 'In der Datei wurde kein Text gefunden.',
    );
  }
  return { ...result, sections };
}

const GERMAN = /\b(und|der|die|das|nicht|mit|für|ist|werden|eine|auf|den|von|zu|sich|dem|im|als|auch)\b/gi;
const ENGLISH = /\b(and|the|of|to|is|are|with|for|that|this|in|on|be|as|by|from|or|an)\b/gi;

/** Grobe Spracherkennung über Funktionswörter; reicht, um Dokumente als de/en zu markieren. */
export function detectLanguage(text: string): 'de' | 'en' | null {
  const sample = text.slice(0, 20_000);
  const de = sample.match(GERMAN)?.length ?? 0;
  const en = sample.match(ENGLISH)?.length ?? 0;
  if (de + en < 5) return null;
  return de >= en ? 'de' : 'en';
}

export function sectionsToText(sections: Section[]): string {
  return sections
    .map((s) => (s.heading ? `${s.heading}\n${s.text}` : s.text))
    .join('\n\n');
}
