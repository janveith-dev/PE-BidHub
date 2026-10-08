import type { Extracted } from './types.js';

/** UTF-8 (auch mit BOM), UTF-16 mit BOM, sonst Windows-1252 — Konfigurationsdateien stammen oft aus Altsystemen. */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function extractPlain(buffer: Buffer, filename: string): Extracted {
  const text = decodeText(buffer).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const isCsv = /\.(csv|tsv)$/i.test(filename);
  const firstLine = text.split('\n', 1)[0] ?? '';
  return {
    method: 'text',
    warnings: [],
    sections: [
      {
        heading: null,
        page: null,
        text,
        ...(isCsv && firstLine.trim() ? { repeatLine: firstLine } : {}),
      },
    ],
  };
}
