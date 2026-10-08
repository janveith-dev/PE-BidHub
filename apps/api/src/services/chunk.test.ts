import { describe, expect, it } from 'vitest';
import { chunkSections } from './chunk.js';

const opts = { target: 300, max: 500, overlap: 120 };

describe('chunkSections', () => {
  it('führt den Überschriftenpfad mit und trennt bei Themenwechsel', () => {
    const chunks = chunkSections(
      [{ heading: null, page: null, text: '# Betrieb\n\nDer Betrieb läuft rund um die Uhr.\n\n## Monitoring\n\nWir überwachen alle Systeme.' }],
      opts,
    );
    expect(chunks.map((c) => c.heading)).toEqual(['Betrieb', 'Betrieb › Monitoring']);
    expect(chunks[1]!.content).toBe('Wir überwachen alle Systeme.');
  });

  it('übernimmt die Seitenzahl des Abschnitts', () => {
    const chunks = chunkSections([{ heading: null, page: 7, text: 'Nur ein Satz.' }], opts);
    expect(chunks).toEqual([{ heading: null, page: 7, content: 'Nur ein Satz.' }]);
  });

  it('hält die Obergrenze ein und verliert dabei keinen Text', () => {
    const sentence = 'Dies ist ein vollständiger Satz über Rechenzentren. ';
    const text = sentence.repeat(40);
    const chunks = chunkSections([{ heading: null, page: null, text }], opts);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(500);
    const joined = chunks.map((c) => c.content).join(' ');
    expect((joined.match(/Rechenzentren/g) ?? []).length).toBeGreaterThanOrEqual(40);
  });

  it('teilt lange Zeilen ohne Satzzeichen hart', () => {
    const chunks = chunkSections([{ heading: null, page: null, text: 'x'.repeat(1300) }], opts);
    expect(chunks.every((c) => c.content.length <= 500)).toBe(true);
    expect(chunks.map((c) => c.content).join('').length).toBe(1300);
  });

  it('wiederholt die Tabellenkopfzeile in jedem Chunk', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `SKU-${i} | Server ${i} | ${i * 100} EUR`);
    const header = 'Artikel | Bezeichnung | Preis';
    const chunks = chunkSections(
      [{ heading: 'Tabellenblatt Preise', page: null, text: [header, ...rows].join('\n'), repeatLine: header }],
      opts,
    );
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.startsWith(header)).toBe(true);
      expect(c.content.length).toBeLessThanOrEqual(500);
    }
    // Die Kopfzeile steht nicht doppelt im ersten Chunk.
    expect(chunks[0]!.content.split(header).length - 1).toBe(1);
    // Jede Zeile kommt vor.
    const all = chunks.map((c) => c.content).join('\n');
    for (const row of rows) expect(all).toContain(row);
  });

  it('teilt zeilenweise ohne Zeilen zu verkleben', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `interface eth${i} mtu 9000`).join('\n');
    const chunks = chunkSections([{ heading: null, page: null, text: lines }], opts);
    for (const c of chunks) for (const l of c.content.split('\n')) expect(l).toMatch(/^interface eth\d+ mtu 9000$/);
  });

  it('übernimmt einen kurzen Schlussabsatz als Überlappung', () => {
    const para = (n: number) => `Absatz ${n}: ` + 'a'.repeat(110);
    const text = [1, 2, 3, 4, 5].map(para).join('\n\n');
    const chunks = chunkSections([{ heading: null, page: null, text }], { target: 260, max: 500, overlap: 130 });
    expect(chunks.length).toBeGreaterThan(1);
    const secondStart = chunks[1]!.content.split('\n\n')[0]!;
    expect(chunks[0]!.content).toContain(secondStart);
  });
});
