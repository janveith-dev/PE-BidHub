import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { openTestDb } from '../test-db.js';
import { HashEmbedder } from './embeddings.js';
import { extractText } from './extract/index.js';
import {
  deleteDocument,
  getDocument,
  ingestDocument,
  listDocuments,
  reindex,
  updateDocumentMeta,
  type KnowledgeDeps,
} from './knowledge.js';
import { hybridSearch, buildTsQuery } from './search.js';
import { makeDocx, makePdf, makePptx, makeXlsx } from './test-fixtures.js';

const text = (s: string) => Buffer.from(s, 'utf8');

describe('Extraktion', () => {
  it('liest PDF seitenweise', async () => {
    const r = await extractText(
      makePdf([
        'Erste Seite mit genug Text fuer die Erkennung',
        'Zweite Seite ebenfalls mit Inhalt und Text',
      ]),
      'a.pdf',
      'application/pdf',
    );
    expect(r.method).toBe('native');
    expect(r.sections.map((s) => s.page)).toEqual([1, 2]);
    expect(r.sections[1]!.text).toContain('Zweite Seite');
  });

  it('meldet eingescannte PDFs ohne ML-Dienst verständlich', async () => {
    await expect(extractText(makePdf(['', '']), 'scan.pdf', 'application/pdf')).rejects.toThrow(
      /eingescannt|kein Text/,
    );
  });

  it('nutzt die Texterkennung für eingescannte PDFs, wenn verfügbar', async () => {
    const ocr = { ocr: async () => ['Erkannter Text Seite 1', 'Erkannter Text Seite 2'] };
    const r = await extractText(makePdf(['', '']), 'scan.pdf', 'application/pdf', { ocr });
    expect(r.method).toBe('ocr');
    expect(r.sections).toHaveLength(2);
  });

  it('behält Überschriften und Tabellen aus DOCX', async () => {
    const r = await extractText(await makeDocx(), 'k.docx', '');
    const t = r.sections[0]!.text;
    expect(t).toContain('# Servicekonzept Rechenzentrum');
    expect(t).toContain('## Reaktionszeiten');
    expect(t).toContain('Priorität | Reaktionszeit\n1 | 30 Minuten');
  });

  it('liest XLSX mit Kopfzeile je Tabellenblatt', async () => {
    const r = await extractText(
      await makeXlsx([
        ['Artikel', 'Preis'],
        ['R760', '4999'],
      ]),
      'p.xlsx',
      '',
    );
    expect(r.sections[0]).toMatchObject({
      heading: 'Tabellenblatt Preise',
      repeatLine: 'Artikel | Preis',
    });
    expect(r.sections[0]!.text).toContain('R760 | 4999');
  });

  it('liest PPTX je Folie', async () => {
    const r = await extractText(
      await makePptx([['Titel A', 'Punkt 1'], ['Titel B & Co']]),
      'f.pptx',
      '',
    );
    expect(r.sections.map((s) => s.heading)).toEqual(['Folie 1: Titel A', 'Folie 2: Titel B & Co']);
  });

  it('erkennt Windows-1252-Konfigurationsdateien', async () => {
    const r = await extractText(
      Buffer.from('Gr\xfc\xdfe aus dem Altsystem', 'latin1'),
      'x.cfg',
      'text/plain',
    );
    expect(r.sections[0]!.text).toBe('Grüße aus dem Altsystem');
  });

  it('weist alte Binärformate und unbekannte Typen mit Hinweis ab', async () => {
    await expect(extractText(Buffer.from('x'), 'a.doc', '')).rejects.toThrow(/\.docx|PDF/);
    await expect(
      extractText(Buffer.from('x'), 'a.exe', 'application/octet-stream'),
    ).rejects.toThrow(/nicht unterstützt/);
  });
});

describe('Tsquery', () => {
  it('entfernt Füllwörter und sucht lange Wörter als Präfix', () => {
    expect(buildTsQuery('Welche Rechenzentren betreibt ihr?')).toBe('rechenzentren:* | betreibt:*');
    expect(buildTsQuery('R760 und die')).toBe('r760:*');
    expect(buildTsQuery('???')).toBeNull();
  });

  it('lässt keine Operatoren aus Nutzereingaben durch', () => {
    expect(buildTsQuery("a'); DROP TABLE x; -- & | !")).not.toMatch(/[';&!]|--/);
  });
});

describe('Wissensbasis', () => {
  let db: Db;
  let dir: string;
  let deps: KnowledgeDeps;

  beforeAll(async () => {
    db = await openTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), 'bidhub-'));
    deps = { db, embedder: new HashEmbedder(), config: { dataDir: dir } };
  });
  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const upload = (name: string, content: string, meta: Record<string, unknown> = {}) =>
    ingestDocument(deps, {
      buffer: text(content),
      filename: name,
      mime: 'text/plain',
      meta: { title: name, category: 'concept', tags: [], ...meta } as never,
    });

  it('nimmt Dokumente auf, zerlegt sie in Chunks und legt die Datei ab', async () => {
    const r = await upload(
      'betrieb.md',
      '# Betrieb\n\nWir betreiben Ihre Systeme in zwei georedundanten Rechenzentren in Deutschland.\n\n# Support\n\nDer Service Desk ist rund um die Uhr erreichbar.',
      { title: 'Betriebskonzept', vendor: 'public edge', tags: ['betrieb'] },
    );
    expect(r.duplicate).toBe(false);
    expect(r.document).toMatchObject({
      title: 'Betriebskonzept',
      version: 1,
      isCurrent: true,
      language: 'de',
      validity: 'unlimited',
    });
    expect(r.document.chunkCount).toBe(2);
    await expect(stat(path.join(dir, 'uploads'))).resolves.toBeTruthy();
  });

  it('erkennt identische Dateien als Duplikat', async () => {
    const again = await upload(
      'betrieb-kopie.md',
      '# Betrieb\n\nWir betreiben Ihre Systeme in zwei georedundanten Rechenzentren in Deutschland.\n\n# Support\n\nDer Service Desk ist rund um die Uhr erreichbar.',
    );
    expect(again.duplicate).toBe(true);
    expect((await listDocuments(db)).filter((d) => d.title === 'Betriebskonzept')).toHaveLength(1);
  });

  it('findet Inhalte über Wortformen und Umschreibungen', async () => {
    await upload(
      'pe.txt',
      'Der Dell PowerEdge R760 ist ein 2HE-Server mit zwei Sockeln für Virtualisierung und Datenbanken.',
      { title: 'R760 Datenblatt', category: 'product', vendor: 'Dell' },
    );
    const plural = await hybridSearch(db, deps.embedder, {
      query: 'Rechenzentren',
      limit: 5,
      excludeExpired: false,
    });
    expect(plural[0]?.title).toBe('Betriebskonzept'); // Stamm von „Rechenzentrum" ≠ „Rechenzentren" — Präfix und Trigramme fangen das ab
    const exact = await hybridSearch(db, deps.embedder, {
      query: 'R760',
      limit: 5,
      excludeExpired: false,
    });
    expect(exact[0]).toMatchObject({
      title: 'R760 Datenblatt',
      vendor: 'Dell',
      category: 'product',
    });
  });

  it('filtert nach Kategorie und Hersteller', async () => {
    const hits = await hybridSearch(db, deps.embedder, {
      query: 'Server Rechenzentrum',
      categories: ['product'],
      limit: 5,
      excludeExpired: false,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.category === 'product')).toBe(true);
    const none = await hybridSearch(db, deps.embedder, {
      query: 'R760',
      vendor: 'Lenovo',
      limit: 5,
      excludeExpired: false,
    });
    expect(none).toEqual([]);
  });

  it('kennzeichnet abgelaufene Dokumente und kann sie ausblenden', async () => {
    await upload(
      'iso-alt.txt',
      'Zertifikat ISO 27001 für den Betrieb der Rechenzentren, ausgestellt 2021.',
      {
        title: 'ISO 27001 (alt)',
        category: 'certificate',
        validUntil: '2024-06-30',
      },
    );
    const all = await hybridSearch(db, deps.embedder, {
      query: 'ISO 27001 Zertifikat',
      limit: 5,
      excludeExpired: false,
    });
    expect(all[0]).toMatchObject({ title: 'ISO 27001 (alt)', validity: 'expired' });
    const current = await hybridSearch(db, deps.embedder, {
      query: 'ISO 27001 Zertifikat',
      limit: 5,
      excludeExpired: true,
    });
    expect(current.find((h) => h.title === 'ISO 27001 (alt)')).toBeUndefined();
  });

  it('ersetzt eine Fassung und behält die alte als Version', async () => {
    const old = (await listDocuments(db)).find((d) => d.title === 'ISO 27001 (alt)')!;
    const neu = await upload(
      'iso-neu.txt',
      'Zertifikat ISO 27001:2022 für den Betrieb der Rechenzentren, gültig bis 2027.',
      {
        title: 'ISO 27001',
        category: 'certificate',
        validUntil: '2999-12-31',
        replacesDocumentId: old.id,
      },
    );
    expect(neu.document).toMatchObject({ version: 2, familyId: old.familyId, validity: 'valid' });

    const { versions } = await getDocument(db, neu.document.id);
    expect(versions.map((v) => [v.version, v.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);

    const hits = await hybridSearch(db, deps.embedder, {
      query: 'ISO 27001',
      limit: 10,
      excludeExpired: false,
    });
    expect(hits.map((h) => h.title)).not.toContain('ISO 27001 (alt)');
    expect(hits[0]).toMatchObject({ title: 'ISO 27001', version: 2 });
  });

  it('stellt beim Löschen der aktuellen Fassung die vorherige wieder her', async () => {
    const cur = (await listDocuments(db)).find((d) => d.title === 'ISO 27001')!;
    await deleteDocument(db, cur.id);
    const { document } = await getDocument(
      db,
      (await listDocuments(db)).find((d) => d.title === 'ISO 27001 (alt)')!.id,
    );
    expect(document).toMatchObject({ version: 1, isCurrent: true });
  });

  it('ändert Metadaten und weist leere Änderungen ab', async () => {
    const d = (await listDocuments(db)).find((x) => x.title === 'R760 Datenblatt')!;
    const u = await updateDocumentMeta(db, d.id, {
      validUntil: '2999-01-01',
      tags: ['server', 'dell'],
    });
    expect(u).toMatchObject({ validUntil: '2999-01-01', tags: ['server', 'dell'] });
    await expect(updateDocumentMeta(db, d.id, {})).rejects.toThrow(/Keine Änderungen/);
  });

  it('bettet nach einem Modellwechsel neu ein und findet weiter', async () => {
    const other = new HashEmbedder();
    Object.defineProperty(other, 'name', { value: 'hash-v2' });
    const before = await hybridSearch(db, other, {
      query: 'Datenbanken',
      limit: 5,
      excludeExpired: false,
    });
    const result = await reindex({ db, embedder: other });
    expect(result.reindexed).toBeGreaterThan(0);
    const after = await hybridSearch(db, other, {
      query: 'Datenbanken',
      limit: 5,
      excludeExpired: false,
    });
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(after[0]?.title).toBe('R760 Datenblatt');
  });

  it('nimmt Office-Dateien auf und findet Tabellenzeilen', async () => {
    const xlsx = await makeXlsx(
      [
        ['Artikel', 'Bezeichnung', 'Preis'],
        ['210-BGQR', 'PowerEdge R660 Basis', '3.499,00'],
        ['400-BLLL', 'SSD 1,92 TB', '389,00'],
      ],
      'Dell 06-2026',
    );
    const r = await ingestDocument(deps, {
      buffer: xlsx,
      filename: 'dell.xlsx',
      mime: '',
      meta: { title: 'Dell Preisliste 06/2026', category: 'pricelist', vendor: 'Dell', tags: [] },
    });
    expect(r.document.chunkCount).toBeGreaterThan(0);
    const hits = await hybridSearch(db, deps.embedder, {
      query: '400-BLLL',
      limit: 3,
      excludeExpired: false,
    });
    expect(hits[0]?.content).toContain('SSD 1,92 TB');
    expect(hits[0]?.content.startsWith('Artikel | Bezeichnung | Preis')).toBe(true);
  });
});
