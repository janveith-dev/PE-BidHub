import type { Section } from './extract/types.js';

export interface Chunk {
  heading: string | null;
  page: number | null;
  content: string;
}

export interface ChunkOptions {
  /** Zielgröße eines Chunks in Zeichen. */
  target: number;
  /** Harte Obergrenze; längere Absätze werden an Satz- oder Zeilengrenzen geteilt. */
  max: number;
  /** Ein kurzer letzter Absatz wird in den nächsten Chunk übernommen, damit Zusammenhänge nicht an der Grenze reißen. */
  overlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { target: 900, max: 1500, overlap: 160 };

interface Block {
  heading: string | null;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Zerlegt den Text eines Abschnitts in Absätze und führt dabei den Überschriftenpfad mit. */
function toBlocks(section: Section): Block[] {
  const blocks: Block[] = [];
  const stack: string[] = [];
  let paragraph: string[] = [];

  const path = (): string | null => {
    const parts = [section.heading, ...stack].filter((p): p is string => Boolean(p));
    return parts.length ? parts.join(' › ') : null;
  };
  const flush = (): void => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ heading: path(), text });
    paragraph = [];
  };

  for (const line of section.text.split('\n')) {
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      stack.length = Math.min(stack.length, level - 1);
      while (stack.length < level - 1) stack.push('');
      stack[level - 1] = h[2]!;
      continue;
    }
    if (line.trim() === '') flush();
    else paragraph.push(line);
  }
  flush();

  // Leere Platzhalter im Pfad (übersprungene Ebenen) entfernen.
  return blocks.map((b) => ({ ...b, heading: b.heading?.replace(/( › )+/g, ' › ').replace(/^ › | › $/g, '') ?? null }));
}

/** Teilt einen zu langen Absatz an Zeilenenden, dann an Satzenden, zuletzt hart. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const lines = text.split('\n');
  const byLine = lines.length > 1 && lines.every((l) => l.length <= max);
  // Satzenden behalten ihre Trennzeichen und den Folgeraum; Zeilen müssen wieder mit \n verbunden werden.
  const units = byLine ? lines : (text.match(/[^.!?;\n]+[.!?;]?\s*/g) ?? [text]);
  const joiner = byLine ? '\n' : '';

  const parts: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.trim()) parts.push(current.trim());
    current = '';
  };
  for (const unit of units) {
    if (unit.length > max) {
      push();
      for (let i = 0; i < unit.length; i += max) parts.push(unit.slice(i, i + max).trim());
      continue;
    }
    if (current && (current + joiner + unit).length > max) push();
    current = current ? current + joiner + unit : unit;
  }
  push();
  return parts.filter(Boolean);
}

export function chunkSections(sections: Section[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const prefix = section.repeatLine ? `${section.repeatLine}\n` : '';
    const budget = Math.max(200, options.max - prefix.length);
    const target = Math.max(150, Math.min(options.target, budget));
    const tabular = Boolean(section.repeatLine);

    const blocks = toBlocks(section).flatMap((b) =>
      splitLong(b.text, budget).map((text) => ({ heading: b.heading, text })),
    );

    let current: string[] = [];
    let heading: string | null = null;
    let size = 0;

    const emit = (): void => {
      if (!current.length) return;
      let content = current.join(tabular ? '\n' : '\n\n');
      // Die Kopfzeile nicht doppelt ausgeben, wenn der Chunk mit ihr beginnt.
      if (prefix && !content.startsWith(section.repeatLine!)) content = prefix + content;
      chunks.push({ heading, page: section.page, content });
    };

    for (const block of blocks) {
      const headingChanged = current.length > 0 && block.heading !== heading;
      const wouldOverflow = size + block.text.length + 2 > target && current.length > 0;

      if (headingChanged || wouldOverflow) {
        const last = current[current.length - 1]!;
        emit();
        // Überlappung nur innerhalb derselben Überschrift und nicht bei Tabellen.
        const carry = !headingChanged && !tabular && last.length <= options.overlap ? [last] : [];
        current = carry;
        size = carry.reduce((n, p) => n + p.length + 2, 0);
      }
      if (!current.length) heading = block.heading;
      current.push(block.text);
      size += block.text.length + 2;
    }
    emit();
  }
  return chunks;
}
