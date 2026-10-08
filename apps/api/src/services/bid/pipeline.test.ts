import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpecAnalysis } from '@bid/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../context.js';
import { loadConfig } from '../../config.js';
import { openTestDb } from '../../test-db.js';
import { HashEmbedder } from '../embeddings.js';
import { callTool, FakeLlm, type AgentRequest } from '../llm/index.js';
import { ingestDocument } from '../knowledge.js';
import { BidPipeline, validateAnalysis } from './pipeline.js';
import {
  createBid,
  createBidDocument,
  getBidDocument,
  listEvents,
  listSections,
  listSectionVersions,
  usageTotals,
} from './store.js';

const SPEC = `Anforderungen an das Servicekonzept.
Der Auftragnehmer muss ein Incident Management mit Reaktionszeiten für Priorität 1 nachweisen.
Der Auftragnehmer soll das Monitoring der Systeme beschreiben.
Das Kapitel Sicherheit darf höchstens 40 Wörter umfassen.`;

const analysisFromModel = (): SpecAnalysis => ({
  summary: 'Servicekonzept mit Betriebs- und Sicherheitsanforderungen.',
  language: 'de',
  formalRules: ['Kapitel Sicherheit höchstens 40 Wörter'],
  evaluationCriteria: ['Qualität des Servicemodells (60 %)'],
  customerTerms: [{ term: 'Auftragnehmer', note: 'statt Dienstleister' }],
  requirements: [
    {
      id: 'A',
      text: 'Incident Management mit Reaktionszeiten für Priorität 1',
      kind: 'must',
      topic: 'Incident',
      sourceQuote: 'Reaktionszeiten für Priorität 1 nachweisen',
    },
    {
      id: 'B',
      text: 'Monitoring beschreiben',
      kind: 'should',
      topic: 'Monitoring',
      sourceQuote: 'Monitoring der Systeme beschreiben',
    },
    {
      id: 'C',
      text: 'Sicherheitsnachweise',
      kind: 'must',
      topic: 'Sicherheit',
      sourceQuote: 'das steht so nicht in der Vorgabe',
    },
    { id: 'D', text: 'Muss ohne Kapitel', kind: 'must', topic: 'Sonstiges' },
  ],
  outline: [
    {
      id: 'x1',
      number: '1',
      title: 'Incident Management',
      level: 1,
      purpose: 'Störungsbearbeitung',
      requirementIds: ['A', 'ZZ'],
      authorRole: 'service_manager',
      targetWords: 150,
    },
    {
      id: 'x2',
      number: '2',
      title: 'Monitoring',
      level: 1,
      purpose: 'Überwachung',
      requirementIds: ['B'],
      authorRole: 'solution_architect',
    },
    {
      id: 'x3',
      number: '3',
      title: 'Sicherheit',
      level: 1,
      purpose: 'Informationssicherheit',
      requirementIds: ['C'],
      authorRole: 'security',
      maxWords: 40,
    },
  ],
});

let ctx: AppContext;
let llm: FakeLlm;
let dataDir: string;
const calls: { role: string; req: AgentRequest<never> }[] = [];
let failSecurityWriter = false;
let reviserOutput: ((content: string) => string) | undefined;

const roleOf = (system: string): string =>
  system.includes('Anforderungsanalyst')
    ? 'analyst'
    : system.includes('Rechercheur')
      ? 'researcher'
      : system.includes('schreibst ein Kapitel')
        ? 'writer'
        : system.includes('unabhängiger Prüfer')
          ? 'reviewer'
          : system.includes('Lektor')
            ? 'reviser'
            : 'other';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'bidhub-pipe-'));
  const db = await openTestDb();
  llm = new FakeLlm(async (req) => {
    const role = roleOf(req.system);
    calls.push({ role, req });
    const user = req.messages.at(-1)!.content;

    if (role === 'analyst')
      return {
        json: analysisFromModel(),
        usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };

    if (role === 'researcher') {
      if (user.includes('Incident Management')) {
        const found = await callTool(req, 'search_knowledge', {
          query: 'Störungen Priorität 1 Reaktionszeit',
        });
        if (!found.includes('[K1]')) return { text: '' };
        // Erfundenes Zitat wird abgelehnt, das wörtliche angenommen.
        const bad = await callTool(req, 'record_fact', {
          statement: 'Störungen werden in 5 Minuten bearbeitet.',
          quote: 'in nur 5 Minuten erledigt',
          ref: 'K1',
        });
        const unknownRef = await callTool(req, 'record_fact', {
          statement: 'Eine Aussage aus einer unbekannten Quelle.',
          quote: 'irgendetwas Erfundenes',
          ref: 'K9',
        });
        const good = await callTool(req, 'record_fact', {
          statement: 'Störungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet.',
          quote: 'Störungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet',
          ref: 'K1',
        });
        const dup = await callTool(req, 'record_fact', {
          statement: 'Störungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet.',
          quote: 'innerhalb von 30 Minuten',
          ref: 'K1',
        });
        const gaps = await callTool(req, 'report_gaps', { gaps: [] });
        return { text: `(${[bad, unknownRef, good, dup, gaps].join(' | ')})` };
      }
      if (user.includes('Monitoring')) {
        // Websuche: nur Adressen aus den Ergebnissen dürfen zitiert werden.
        req.onEvent?.({
          type: 'web_results',
          sources: [{ url: 'https://example.org/itil4/', title: 'ITIL 4 Überblick' }],
        });
        const fake = await callTool(req, 'record_fact', {
          statement: 'Eine Aussage von einer erfundenen Seite.',
          quote: 'Erfundenes Zitat',
          url: 'https://erfunden.example/seite',
        });
        const real = await callTool(req, 'record_fact', {
          statement: 'ITIL 4 beschreibt Monitoring als Teil von Service Operations.',
          quote: 'Monitoring und Event Management',
          url: 'https://example.org/itil4',
        });
        const both = await callTool(req, 'record_fact', {
          statement: 'Beides angegeben, daher ungültig.',
          quote: 'irgendein Zitat',
          url: 'https://example.org/itil4',
          ref: 'K1',
        });
        const gaps = await callTool(req, 'report_gaps', {
          gaps: ['R-002: konkrete Monitoring-Werkzeuge von public edge nicht belegt'],
        });
        return {
          text: `(${[fake, real, both, gaps].join(' | ')})`,
          webSources: [{ url: 'https://example.org/itil4/', title: 'ITIL 4 Überblick' }],
        };
      }
      await callTool(req, 'report_gaps', { gaps: [] });
      return { text: '' };
    }

    if (role === 'writer') {
      // Der Prompt enthält die Gliederung aller Kapitel; maßgeblich ist nur die Zeile „Dein Kapitel: N".
      const chapter = /Dein Kapitel: (\d+) /.exec(user)?.[1];
      if (chapter === '3') {
        if (failSecurityWriter) throw new Error('Modell überlastet');
        // Zu lang für maxWords = 40: löst die Kürzung aus.
        return {
          json: {
            content: Array.from({ length: 70 }, (_, i) => `wort${i}`).join(' '),
            usedFactIds: [],
            openPoints: [],
            addressedRequirementIds: ['R-003'],
          },
        };
      }
      if (chapter === '2') {
        return {
          json: {
            content:
              'Wir überwachen Systeme nach ITIL 4 [F1]. Die eingesetzte Werkzeuglandschaft beschreiben wir hier: [OFFEN: Monitoring-Werkzeuge von public edge].',
            usedFactIds: ['F1'],
            openPoints: ['Monitoring-Werkzeuge von public edge'],
            addressedRequirementIds: ['R-002'],
          },
        };
      }
      return {
        json: {
          content:
            'Der Auftragnehmer bearbeitet Störungen der Priorität 1 innerhalb von 30 Minuten [F1]. Ein erfundener Beleg [F9] steht hier ebenfalls.',
          usedFactIds: ['F1', 'F9'],
          openPoints: [],
          addressedRequirementIds: ['R-001'],
        },
      };
    }

    if (role === 'reviser') {
      const current = /Aktueller Text:\n"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? '';
      if (user.includes('höchstens 40 Wörter'))
        return {
          json: {
            content: Array.from({ length: 30 }, (_, i) => `kurz${i}`).join(' '),
            summary: 'gekürzt',
          },
        };
      return { json: { content: (reviserOutput ?? ((c) => c))(current), summary: 'angepasst' } };
    }

    if (role === 'reviewer') {
      return {
        json: {
          coverage: [
            {
              requirementId: 'R-001',
              status: 'covered',
              sectionIds: ['S-01', 'S-99'],
              comment: 'Reaktionszeit konkret genannt.',
            },
            {
              requirementId: 'R-002',
              status: 'covered',
              sectionIds: [],
              comment: 'Behauptet, ohne Kapitel.',
            },
            {
              requirementId: 'R-099',
              status: 'covered',
              sectionIds: ['S-01'],
              comment: 'Unbekannt.',
            },
          ],
          findings: [
            {
              severity: 'minor',
              kind: 'style',
              sectionId: 'S-01',
              message: 'Begriff „Dienstleister" statt „Auftragnehmer".',
            },
          ],
          summary: 'Belastbar bis auf Monitoring.',
        },
        usage: { inputTokens: 5000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }
    return { text: '' };
  });

  ctx = {
    config: { ...loadConfig({ DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'x' }), dataDir },
    db,
    embedder: new HashEmbedder(),
    llm,
    stt: { available: false, transcribe: async () => ({ text: '', language: null }) },
    tts: { available: false, speak: async () => new ReadableStream() },
  };

  const kb = { db, embedder: ctx.embedder, config: { dataDir } };
  const add = (name: string, content: string, meta: object) =>
    ingestDocument(kb, {
      buffer: Buffer.from(content),
      filename: name,
      mime: 'text/plain',
      meta: { title: name, tags: [], category: 'concept', ...meta } as never,
    });
  await add(
    'Betriebskonzept.md',
    '# Incident Management\n\nStörungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet. Der Service Desk ist rund um die Uhr erreichbar.',
    { title: 'Betriebskonzept' },
  );
  await add(
    'Altes-Konzept.md',
    'Störungen der Priorität 1 werden innerhalb von 4 Stunden bearbeitet. Reaktionszeit alt.',
    { title: 'Altes Konzept', validUntil: '2020-01-01' },
  );
});
afterAll(async () => {
  await ctx.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

let docId: string;
let pipeline: BidPipeline;
const roleCalls = (r: string) => calls.filter((c) => c.role === r);

describe('Bid-Pipeline', () => {
  it('analysiert die Vorgabe, prüft Zitate und bereinigt Verweise', async () => {
    pipeline = new BidPipeline(ctx, { today: () => '2026-10-08' });
    const bid = await createBid(ctx.db, {
      name: 'RZ-Betrieb',
      customer: 'Stadt Beispielstadt',
      language: 'de',
      deadline: '2026-12-01',
    });
    docId = (
      await createBidDocument(ctx.db, { bidId: bid.id, title: 'Servicekonzept', specText: SPEC })
    ).id;

    const started = await pipeline.startAnalysis(docId);
    expect(started.status).toBe('analyzing');
    // Ein zweiter Start während des Laufs wird abgewiesen.
    await expect(pipeline.startAnalysis(docId)).rejects.toMatchObject({ status: 409 });
    await pipeline.idle(docId);

    const doc = await getBidDocument(ctx.db, docId);
    expect(doc.status).toBe('outline_review');
    const a = doc.analysis!;
    expect(a.requirements.map((r) => r.id)).toEqual(['R-001', 'R-002', 'R-003', 'R-004']);
    expect(a.requirements.map((r) => r.quoteVerified)).toEqual([true, true, false, undefined]);
    expect(a.outline.map((s) => [s.id, s.requirementIds])).toEqual([
      ['S-01', ['R-001']],
      ['S-02', ['R-002']],
      ['S-03', ['R-003']],
    ]);
    expect((await listSections(ctx.db, docId)).map((s) => s.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);

    const gates = (await listEvents(ctx.db, docId))
      .filter((e) => e.kind === 'gate')
      .map((e) => e.message);
    expect(gates.some((m) => m.includes('nicht wiedergefunden'))).toBe(true);
    expect(gates.some((m) => m.includes('R-004'))).toBe(true);
    expect(gates.some((m) => m.includes('unbekannte Anforderungen'))).toBe(true);
  });

  it('schreibt nichts, bevor die Gliederung freigegeben ist', async () => {
    expect(roleCalls('writer')).toHaveLength(0);
    expect(roleCalls('researcher')).toHaveLength(0);
    await expect(pipeline.startReview(docId)).rejects.toMatchObject({ status: 409 });
    await expect(
      pipeline.editSection(docId, (await listSections(ctx.db, docId))[0]!.id, 'x', 'sales'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('verlangt Zuordnung oder ausdrückliche Bestätigung für nicht zugeordnete Muss-Anforderungen', async () => {
    await expect(pipeline.approveOutline(docId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('R-004'),
    });
    expect(roleCalls('writer')).toHaveLength(0);
  });

  it('weist eine fehlerhafte bearbeitete Gliederung ab und speichert eine korrekte', async () => {
    const doc = await getBidDocument(ctx.db, docId);
    const broken = structuredClone(doc.analysis!);
    broken.outline[0]!.requirementIds = ['R-777'];
    await expect(pipeline.saveAnalysis(docId, broken)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('R-777'),
    });

    // Der Bid Manager ordnet die fehlende Anforderung dem ersten Kapitel zu.
    const fixed = structuredClone(doc.analysis!);
    fixed.outline[0]!.requirementIds.push('R-004');
    const { issues } = await pipeline.saveAnalysis(docId, fixed);
    expect(issues.unassignedMust).toEqual([]);
    expect(validateAnalysis(fixed).errors).toEqual([]);
  });

  it('schreibt nach der Freigabe alle Kapitel, belegt Fakten und isoliert Fehler', async () => {
    failSecurityWriter = true;
    const approved = await pipeline.approveOutline(docId);
    expect(approved.status).toBe('writing');
    await expect(pipeline.approveOutline(docId)).rejects.toMatchObject({ status: 409 });
    await pipeline.idle(docId);

    const doc = await getBidDocument(ctx.db, docId);
    expect(doc.status).toBe('written');
    expect(doc.error).toContain('1 Kapitel');
    expect(doc.outline_approved_at).not.toBeNull();

    const [s1, s2, s3] = await listSections(ctx.db, docId);
    expect([s1!.status, s2!.status, s3!.status]).toEqual(['written', 'written', 'failed']);
    expect(s3!.notes).toContain('Modell überlastet');

    // Nur das wörtliche Zitat aus der gültigen Quelle wurde als Fakt angenommen; das alte Dokument war ausgeschlossen.
    expect(s1!.facts).toHaveLength(1);
    expect(s1!.facts[0]).toMatchObject({
      id: 'F1',
      sourceType: 'kb',
      sourceTitle: 'Betriebskonzept',
      quoteVerified: true,
    });
    const research = roleCalls('researcher')[0]!.req;
    expect(research.system).toContain('Abgelaufene Dokumente werden dir nicht geliefert');

    // Web-Fakt nur mit Adresse aus den Suchergebnissen; Zitat bleibt als ungeprüft gekennzeichnet.
    expect(s2!.facts).toHaveLength(1);
    expect(s2!.facts[0]).toMatchObject({
      sourceType: 'web',
      sourceRef: 'https://example.org/itil4/',
      quoteVerified: false,
    });

    // Die erfundene Marke [F9] wurde entfernt, die echte bleibt.
    expect(s1!.content).toContain('[F1]');
    expect(s1!.content).not.toContain('[F9]');
    expect(s1!.notes).toBe('Unbekannte Quellenmarken entfernt: F9.'); // keine Lücken gemeldet, nur die entfernte Marke
    expect(s1!.last_author).toBe('agent:writer:service_manager');

    // Offener Punkt wird in den Kapitelnotizen sichtbar.
    expect(s2!.notes).toContain('Offene Punkte: Monitoring-Werkzeuge von public edge');
    expect(s2!.notes).toContain('Lücken laut Recherche: R-002: konkrete Monitoring-Werkzeuge');

    // Der Autor bekommt die Fakten, nicht die Werkzeuge, und die Begriffe des Auftraggebers.
    // Die Kapitel laufen parallel, daher den Aufruf für Kapitel 1 gezielt suchen.
    const writer = roleCalls('writer').find((c) =>
      c.req.messages[0]!.content.includes('Dein Kapitel: 1 '),
    )!.req;
    expect(writer.tools ?? []).toHaveLength(0);
    expect(writer.system).toContain('Auftragnehmer');
    expect(writer.messages[0]!.content).toContain(
      '[F1] Störungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet.',
    );
    expect(roleCalls('writer').every((c) => (c.req.tools ?? []).length === 0)).toBe(true);
  });

  it('kürzt zu lange Kapitel automatisch und holt gescheiterte Kapitel nach', async () => {
    failSecurityWriter = false;
    await pipeline.retryFailed(docId);
    await pipeline.idle(docId);

    const s3 = (await listSections(ctx.db, docId))[2]!;
    expect(s3.status).toBe('written');
    expect(s3.content.split(/\s+/)).toHaveLength(30); // nach Kürzung
    expect(roleCalls('reviser').length).toBeGreaterThan(0);
    expect((await getBidDocument(ctx.db, docId)).error).toBeNull();
  });

  it('prüft unabhängig, bewertet jede Anforderung und ergänzt maschinelle Befunde', async () => {
    await pipeline.startReview(docId);
    await pipeline.idle(docId);
    const doc = await getBidDocument(ctx.db, docId);
    expect(doc.status).toBe('reviewed');

    const cov = Object.fromEntries(doc.coverage!.map((c) => [c.requirementId, c]));
    expect(cov['R-001']).toMatchObject({ status: 'covered', sectionIds: ['S-01'] }); // unbekanntes Kapitel S-99 entfernt
    expect(cov['R-002']!.status).toBe('partial'); // „erfüllt" ohne Kapitel wird herabgestuft
    expect(cov['R-003']).toMatchObject({
      status: 'missing',
      comment: 'Vom Prüfer nicht bewertet.',
    });
    expect(Object.keys(cov)).toEqual(['R-001', 'R-002', 'R-003', 'R-004']); // R-099 des Prüfers wurde verworfen

    const kinds = doc.findings!.map((f) => `${f.severity}/${f.kind}`);
    expect(kinds).toContain('major/open_point'); // [OFFEN] im Monitoring-Kapitel
    expect(kinds).toContain('minor/style'); // Befund des Prüfers
    expect(doc.findings![0]!.id).toBe('B-001');
    expect(doc.findings!.map((f) => f.severity)).toEqual(
      [...doc.findings!.map((f) => f.severity)].sort(
        (a, b) =>
          ['blocker', 'major', 'minor'].indexOf(a) - ['blocker', 'major', 'minor'].indexOf(b),
      ),
    );
    expect(doc.review_summary).toBe('Belastbar bis auf Monitoring.');

    // Der Prüfer sieht Anforderungen und Kapitel, aber keine Werkzeuge und nicht die Recherche-Verläufe.
    const reviewer = roleCalls('reviewer')[0]!.req;
    expect(reviewer.tools ?? []).toHaveLength(0);
    expect(reviewer.messages[0]!.content).toContain('R-004 (must, Sonstiges)');
  });

  it('macht die Prüfung nach einer manuellen Änderung ungültig und führt die Versionshistorie', async () => {
    const [s1] = await listSections(ctx.db, docId);
    const edited = await pipeline.editSection(
      docId,
      s1!.id,
      'Neu formuliert durch den Bid Manager [F1].',
      'bid_management',
    );
    expect(edited).toMatchObject({ version: 2, last_author: 'user:bid_management' });
    expect((await getBidDocument(ctx.db, docId)).status).toBe('written');
    const versions = await listSectionVersions(ctx.db, s1!.id);
    expect(versions[0]).toMatchObject({ version: 1, author: 'agent:writer:service_manager' });
  });

  it('überarbeitet gezielt nach Anweisung, ohne neu zu recherchieren', async () => {
    const researcherBefore = roleCalls('researcher').length;
    const [s1] = await listSections(ctx.db, docId);
    reviserOutput = (c) => c.replace('Auftragnehmer', 'Auftragnehmer (AN)');
    await pipeline.reviseSection(docId, s1!.id, 'Kürzel einführen');
    await pipeline.idle(docId);
    expect(roleCalls('researcher')).toHaveLength(researcherBefore);
    const after = (await listSections(ctx.db, docId))[0]!;
    expect(after.version).toBe(3);
    expect(after.last_author).toBe('agent:lektor');
  });

  it('verwirft Lektorat, das Zahlen oder Quellenmarken verändert', async () => {
    // Kapitel 1 trägt die Marke [F1], Kapitel 2 die Zahl „ITIL 4": beides darf ein Stilpass nicht anfassen.
    reviserOutput = (c) => c.replace('ITIL 4', 'ITIL 5').replace('[F1]', '[F2]');
    const before = await listSections(ctx.db, docId);
    await pipeline.polish(docId);
    await pipeline.idle(docId);
    const after = await listSections(ctx.db, docId);
    expect(after[0]!.content).toBe(before[0]!.content);
    expect(after[1]!.content).toBe(before[1]!.content);
    expect(after.map((s) => s.version)).toEqual(before.map((s) => s.version));
    const events = (await listEvents(ctx.db, docId)).filter(
      (e) => e.agent === 'lektor' && e.kind === 'info',
    );
    expect(events.filter((e) => e.message.includes('verworfen'))).toHaveLength(2);
    reviserOutput = undefined;
  });

  it('zählt den Verbrauch aller Agenten', async () => {
    const usage = await usageTotals(ctx.db, docId);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(6000);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(1300);
  });
});

describe('Fehlerfälle', () => {
  it('setzt das Dokument bei fehlgeschlagener Analyse auf „failed" und erlaubt den Neustart', async () => {
    const bid = await createBid(ctx.db, { name: 'X', customer: 'Y', language: 'de' });
    const id = (
      await createBidDocument(ctx.db, { bidId: bid.id, title: 'Konzept', specText: 'Vorgabe' })
    ).id;
    const original = llm['handler' as never] as never;
    const broken = new FakeLlm(async () => {
      throw new Error('API nicht erreichbar');
    });
    const p = new BidPipeline({ ...ctx, llm: broken });
    await p.startAnalysis(id);
    await p.idle(id);
    const doc = await getBidDocument(ctx.db, id);
    expect(doc).toMatchObject({ status: 'failed', error: 'API nicht erreichbar' });
    expect((await listEvents(ctx.db, id)).at(-1)).toMatchObject({
      kind: 'error',
      agent: 'analyst',
    });
    void original;
    // Neustart aus „failed" ist erlaubt.
    expect((await new BidPipeline(ctx).startAnalysis(id)).status).toBe('analyzing');
    await new BidPipeline(ctx).idle();
  });

  it('versucht bei ungültiger strukturierter Antwort genau einmal erneut', async () => {
    const bid = await createBid(ctx.db, { name: 'Z', customer: 'Z', language: 'de' });
    const id = (
      await createBidDocument(ctx.db, { bidId: bid.id, title: 'Konzept', specText: SPEC })
    ).id;
    let n = 0;
    const flaky = new FakeLlm(async (req) => {
      n++;
      if (n === 1) {
        const { LlmOutputError } = await import('../llm/index.js');
        throw new LlmOutputError('Feld outline fehlt');
      }
      expect(req.messages.at(-1)!.content).toContain('Feld outline fehlt');
      return { json: analysisFromModel() };
    });
    const p = new BidPipeline({ ...ctx, llm: flaky });
    await p.startAnalysis(id);
    await p.idle(id);
    expect(n).toBe(2);
    expect((await getBidDocument(ctx.db, id)).status).toBe('outline_review');
  });
});
