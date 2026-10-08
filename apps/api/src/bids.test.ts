import JSZip from 'jszip';
import mammoth from 'mammoth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultTemplate } from './services/export/default-template.js';
import { callTool } from './services/llm/index.js';
import { makeTestApp, multipart, type TestApp } from './test-app.js';

const SPEC = 'Der Auftragnehmer muss ein Incident Management beschreiben. Der Auftragnehmer soll Monitoring beschreiben.';

let t: TestApp;
let bidId: string;
let docId: string;
// Hält den Analyselauf offen, bis der Test ihn freigibt; sonst ist er bei der nächsten Anfrage schon vorbei.
let analystGate: Promise<void> = Promise.resolve();

beforeAll(async () => {
  t = await makeTestApp(async (req) => {
    const user = req.messages.at(-1)!.content;
    const system = req.system;
    if (system.includes('Anforderungsanalyst')) {
      await analystGate;
      return {
        json: {
          summary: 'Zwei Anforderungen.', language: 'de', formalRules: [], evaluationCriteria: [], customerTerms: [],
          requirements: [
            { id: 'R1', text: 'Incident Management beschreiben', kind: 'must', topic: 'Incident', sourceQuote: 'Incident Management beschreiben' },
            { id: 'R2', text: 'Monitoring beschreiben', kind: 'should', topic: 'Monitoring' },
          ],
          outline: [
            { id: 'a', number: '1', title: 'Incident Management', level: 1, purpose: 'Störungen', requirementIds: ['R1'], authorRole: 'service_manager' },
            { id: 'b', number: '2', title: 'Monitoring', level: 1, purpose: 'Überwachung', requirementIds: ['R2'], authorRole: 'solution_architect' },
          ],
        },
      };
    }
    if (system.includes('Rechercheur')) {
      await callTool(req, 'report_gaps', { gaps: [] });
      return { text: '' };
    }
    if (system.includes('schreibst ein Kapitel')) {
      const monitoring = /Dein Kapitel: 2 /.test(user);
      return { json: { content: monitoring ? 'Wir überwachen die Systeme. [OFFEN: Werkzeuge nennen]' : 'Wir bearbeiten Störungen nach ITIL 4 in einem festen Prozess.', usedFactIds: [], openPoints: [], addressedRequirementIds: [] } };
    }
    if (system.includes('unabhängiger Prüfer')) {
      return { json: { coverage: [{ requirementId: 'R-001', status: 'covered', sectionIds: ['S-01'], comment: 'ok' }], findings: [], summary: 'Solide.' } };
    }
    if (system.includes('Lektor')) {
      const current = /Aktueller Text:\n"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? '';
      return { json: { content: `${current} Ergänzt.`, summary: 'ergänzt' } };
    }
    return { text: '' };
  });
});
afterAll(async () => t.close());

const json = (res: { json: () => unknown }) => res.json() as Record<string, any>;

describe('Ausschreibung und Vorgabe', () => {
  it('legt eine Ausschreibung an und prüft die Eingaben', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/bids', payload: { name: 'RZ-Betrieb', customer: 'Stadt Beispielstadt', deadline: '2026-12-01' } });
    expect(res.statusCode).toBe(201);
    bidId = json(res).id;
    expect((await t.app.inject({ method: 'POST', url: '/api/bids', payload: { name: '', customer: 'x' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/bids', payload: { name: 'a', customer: 'b', deadline: '01.12.2026' } })).statusCode).toBe(400);
  });

  it('nimmt die Vorgabe als Datei oder als Text an', async () => {
    const m = multipart({ title: 'Servicekonzept' }, { name: 'vorgabe.txt', type: 'text/plain', content: Buffer.from(SPEC) });
    const res = await t.app.inject({ method: 'POST', url: `/api/bids/${bidId}/documents`, payload: m.payload, headers: m.headers });
    expect(res.statusCode).toBe(201);
    docId = json(res).id;
    expect(json(res)).toMatchObject({ status: 'draft', title: 'Servicekonzept', options: { allowWeb: true } });

    const viaText = await t.app.inject({ method: 'POST', url: `/api/bids/${bidId}/documents`, payload: { title: 'Per Text', specText: SPEC, allowWeb: false } });
    expect(viaText.statusCode).toBe(201);
    expect(json(viaText).options.allowWeb).toBe(false);
  });

  it('weist unvollständige Eingaben ab', async () => {
    expect((await t.app.inject({ method: 'POST', url: `/api/bids/${bidId}/documents`, payload: { title: 'Ohne Vorgabe' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: `/api/bids/${bidId}/documents`, payload: { specText: SPEC } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/bids/6f0a6c1e-0000-4000-8000-000000000000/documents', payload: { title: 'x', specText: SPEC } })).statusCode).toBe(404);
  });
});

describe('Etappen mit Freigabe', () => {
  it('analysiert im Hintergrund und wartet danach auf die Freigabe', async () => {
    let release!: () => void;
    analystGate = new Promise<void>((resolve) => (release = resolve));

    const res = await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/analyze` });
    expect(res.statusCode).toBe(202);
    expect(json(res).status).toBe('analyzing');
    // Während des Laufs sind weitere Schritte gesperrt, und die Oberfläche erfährt, dass etwas läuft.
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/analyze` })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/bid-documents/${docId}` })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/approve-outline`, payload: {} })).statusCode).toBe(409);
    expect(json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` }))).toMatchObject({ status: 'analyzing', running: true });

    release();
    await t.app.pipeline.idle(docId);
    const doc = json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` }));
    expect(doc).toMatchObject({ status: 'outline_review', running: false });
    expect(doc.analysis.requirements).toHaveLength(2);
    expect(doc.sections.map((s: any) => [s.number, s.status, s.content])).toEqual([['1', 'pending', ''], ['2', 'pending', '']]);
  });

  it('zeigt das Protokoll der Agenten und erlaubt inkrementelles Abfragen', async () => {
    const all = (await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}/events` })).json() as { id: number; agent: string; kind: string }[];
    expect(all.some((e) => e.agent === 'analyst' && e.kind === 'result')).toBe(true);
    const last = all.at(-1)!.id;
    expect((await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}/events?after=${last}` })).json()).toEqual([]);
  });

  it('speichert die bearbeitete Gliederung und weist inkonsistente ab', async () => {
    const doc = json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` }));
    const edited = structuredClone(doc.analysis);
    edited.outline[0].title = 'Störungsmanagement (Incident)';
    const ok = await t.app.inject({ method: 'PUT', url: `/api/bid-documents/${docId}/analysis`, payload: edited });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).issues.unassignedMust).toEqual([]);

    edited.outline[1].requirementIds = ['R-404'];
    const bad = await t.app.inject({ method: 'PUT', url: `/api/bid-documents/${docId}/analysis`, payload: edited });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toContain('R-404');
    expect(json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).sections[0].title).toBe('Störungsmanagement (Incident)');
  });

  it('verweigert Export, Prüfung und Bearbeitung vor der Freigabe', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}/export.docx` })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/review` })).statusCode).toBe(409);
    const [s] = json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).sections;
    expect((await t.app.inject({ method: 'PUT', url: `/api/bid-sections/${s.id}`, payload: { content: 'x' } })).statusCode).toBe(409);
  });

  it('schreibt nach der Freigabe alle Kapitel', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/approve-outline`, payload: {} });
    expect(res.statusCode).toBe(202);
    await t.app.pipeline.idle(docId);
    const doc = json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` }));
    expect(doc.status).toBe('written');
    expect(doc.outlineApprovedAt).not.toBeNull();
    expect(doc.sections.map((s: any) => s.status)).toEqual(['written', 'written']);
    expect(doc.sections[0]).toMatchObject({ lastAuthor: 'agent:writer:service_manager', wordCount: 10 });
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/approve-outline`, payload: {} })).statusCode).toBe(409);
  });
});

describe('Kapitel bearbeiten', () => {
  let sectionId: string;
  beforeAll(async () => {
    sectionId = json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).sections[0].id;
  });

  it('übernimmt manuelle Änderungen mit Rolle und führt Versionen', async () => {
    const res = await t.app.inject({ method: 'PUT', url: `/api/bid-sections/${sectionId}`, headers: { 'x-role': 'bid_management' }, payload: { content: 'Manuell überarbeitet.' } });
    expect(json(res)).toMatchObject({ content: 'Manuell überarbeitet.', lastAuthor: 'user:bid_management', version: 2 });
    const versions = (await t.app.inject({ method: 'GET', url: `/api/bid-sections/${sectionId}/versions` })).json() as { version: number; author: string }[];
    expect(versions[0]).toMatchObject({ version: 1, author: 'agent:writer:service_manager' });
  });

  it('überarbeitet nach Anweisung im Hintergrund', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/bid-sections/${sectionId}/revise`, payload: { instruction: 'Etwas ergänzen' } });
    expect(res.statusCode).toBe(202);
    await t.app.pipeline.idle(docId);
    expect(json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).sections[0].content).toBe('Manuell überarbeitet. Ergänzt.');
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-sections/${sectionId}/revise`, payload: { instruction: 'x' } })).statusCode).toBe(400);
  });

  it('stellt eine frühere Fassung als neue Version wieder her', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/bid-sections/${sectionId}/restore`, payload: { version: 1 } });
    expect(json(res).content).toBe('Wir bearbeiten Störungen nach ITIL 4 in einem festen Prozess.');
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-sections/${sectionId}/restore`, payload: { version: 99 } })).statusCode).toBe(404);
  });

  it('schreibt ein Kapitel auf Wunsch komplett neu', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/bid-sections/${sectionId}/rewrite`, payload: { instruction: 'Kürzer fassen' } });
    expect(res.statusCode).toBe(202);
    await t.app.pipeline.idle(docId);
    expect(json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).sections[0].lastAuthor).toBe('agent:writer:service_manager');
  });
});

describe('Prüfung', () => {
  it('liefert Abdeckung, Befunde und Zusammenfassung', async () => {
    expect((await t.app.inject({ method: 'POST', url: `/api/bid-documents/${docId}/review`, payload: {} })).statusCode).toBe(202);
    await t.app.pipeline.idle(docId);
    const doc = json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` }));
    expect(doc.status).toBe('reviewed');
    expect(doc.coverage.map((c: any) => [c.requirementId, c.status])).toEqual([['R-001', 'covered'], ['R-002', 'missing']]);
    expect(doc.findings.some((f: any) => f.message.includes('offener Punkt'))).toBe(true);
    expect(doc.reviewSummary).toBe('Solide.');
    expect(doc.usage.inputTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('Export und Vorlagen', () => {
  const exportDoc = (query = '') => t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}/export.docx${query}` });

  it('liefert ein gültiges Word-Dokument mit Standardvorlage und meldet offene Punkte', async () => {
    const res = await exportDoc();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml.document');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''Servicekonzept.docx");
    expect(res.headers['x-open-points']).toBe('1');
    expect(decodeURIComponent(String(res.headers['x-template']))).toBe('Standardvorlage');
    const text = (await mammoth.extractRawText({ buffer: res.rawPayload })).value;
    expect(text).toContain('Stadt Beispielstadt');
    expect(text).toContain('1 Störungsmanagement (Incident)');
    expect(text).toContain('[OFFEN: Werkzeuge nennen]');
  });

  it('lehnt ungültige Vorlagen ab und meldet fehlende Inhaltsmarken', async () => {
    const bad = multipart({ name: 'Kaputt' }, { name: 'x.docx', type: 'application/octet-stream', content: Buffer.from('kein zip') });
    expect((await t.app.inject({ method: 'POST', url: '/api/templates', payload: bad.payload, headers: bad.headers })).statusCode).toBe(422);
    const wrongType = multipart({}, { name: 'x.pdf', type: 'application/pdf', content: Buffer.from('x') });
    expect((await t.app.inject({ method: 'POST', url: '/api/templates', payload: wrongType.payload, headers: wrongType.headers })).statusCode).toBe(422);

    const zip = await JSZip.loadAsync(await buildDefaultTemplate());
    zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('{{INHALT}}', ''));
    const noMarker = multipart({ name: 'Ohne Marke' }, { name: 'ohne.docx', type: 'application/octet-stream', content: Buffer.from(await zip.generateAsync({ type: 'uint8array' })) });
    const res = await t.app.inject({ method: 'POST', url: '/api/templates', payload: noMarker.payload, headers: noMarker.headers });
    expect(res.statusCode).toBe(201);
    expect(json(res).warnings[0]).toContain('{{INHALT}}');
    await t.app.inject({ method: 'DELETE', url: `/api/templates/${json(res).id}` });
  });

  it('verwendet eine hochgeladene Firmenvorlage als Standard und erlaubt Überschreiben je Export', async () => {
    const zip = await JSZip.loadAsync(await buildDefaultTemplate());
    zip.file('word/header1.xml', (await zip.file('word/header1.xml')?.async('string') ?? '').replace('·', '|'));
    const up = multipart({ name: 'Firmenvorlage', isDefault: 'true' }, { name: 'firma.dotx', type: 'application/octet-stream', content: Buffer.from(await zip.generateAsync({ type: 'uint8array' })) });
    const created = await t.app.inject({ method: 'POST', url: '/api/templates', payload: up.payload, headers: up.headers });
    expect(created.statusCode).toBe(201);
    expect(json(created).warnings).toEqual([]);

    const list = (await t.app.inject({ method: 'GET', url: '/api/templates' })).json() as { id: string; isDefault: boolean; builtin: boolean }[];
    expect(list.find((x) => x.builtin)!.isDefault).toBe(false);
    expect(list.find((x) => x.id === json(created).id)!.isDefault).toBe(true);

    expect(decodeURIComponent(String((await exportDoc()).headers['x-template']))).toBe('Firmenvorlage');
    expect(decodeURIComponent(String((await exportDoc('?templateId=standard')).headers['x-template']))).toBe('Standardvorlage');
    expect((await exportDoc('?templateId=6f0a6c1e-0000-4000-8000-000000000000')).statusCode).toBe(404);

    // Die Vorlage lässt sich je Dokument festlegen und wieder löschen.
    expect(json(await t.app.inject({ method: 'PATCH', url: `/api/bid-documents/${docId}`, payload: { templateId: json(created).id } })).templateId).toBe(json(created).id);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/templates/${json(created).id}` })).statusCode).toBe(204);
    expect(json(await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).templateId).toBeNull();
    expect(decodeURIComponent(String((await exportDoc()).headers['x-template']))).toBe('Standardvorlage');
  });

  it('bietet die Standardvorlage zum Herunterladen an', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/templates/standard/file' });
    expect(res.statusCode).toBe(200);
    expect((await JSZip.loadAsync(res.rawPayload)).file('word/document.xml')).toBeTruthy();
  });

  it('exportiert auf Wunsch mit Quellenverzeichnis', async () => {
    const res = await exportDoc('?sources=1');
    expect(res.statusCode).toBe(200);
  });
});

describe('Aufräumen', () => {
  it('löscht Dokument und Ausschreibung samt Kapiteln', async () => {
    expect((await t.app.inject({ method: 'DELETE', url: `/api/bid-documents/${docId}` })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/bid-documents/${docId}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/bids/${bidId}` })).statusCode).toBe(204);
    expect((await t.ctx.db.query('SELECT 1 FROM bid_sections')).length).toBe(0);
  });
});
