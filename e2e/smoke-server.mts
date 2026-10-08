import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../apps/api/src/config.ts';
import { openDb } from '../apps/api/src/db/client.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { buildServer } from '../apps/api/src/server.ts';
import { ingestDocument } from '../apps/api/src/services/knowledge.ts';
import { HashEmbedder, MlEmbedder } from '../apps/api/src/services/embeddings.ts';
import { callTool, FakeLlm } from '../apps/api/src/services/llm/index.ts';
import { MlOcr, MlSpeechToText } from '../apps/api/src/services/voice.ts';

/**
 * Testserver für die Oberflächentests: die echte API mit echter Datenbank-Schicht und befüllter Wissensbasis.
 * Sprachmodell und Sprachausgabe sind skriptiert (kein API-Schlüssel nötig); Spracherkennung, OCR und Embeddings
 * kommen vom ML-Dienst, wenn ML_SERVICE_URL gesetzt ist, sonst gibt es Hash-Embeddings und keine Spracherkennung.
 * Die Antworten des „Modells" prüfen die Verdrahtung, nicht die Qualität echter Claude-Antworten.
 */
const ML = process.env.ML_SERVICE_URL;
const PORT = Number(process.env.PORT ?? 3100);
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bidhub-smoke-'));
const db = await openDb('memory');
await migrate(db);
const spoken: string[] = [];
// 0,4 Sekunden Stille als gültige MP3-Datei: Der Browser kann sie wirklich abspielen.
const mp3 = Buffer.from(
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NwwAAAAAAAAAAAAEluZm8AAAAPAAAAEgAACA8AIyMjIyMwMDAwMDA9PT09PUpKSkpKSldXV1dXZGRkZGRkcXFxcXF+fn5+fn6Li4uLi5iYmJiYmKWlpaWlpbKysrKyv7+/v7+/zMzMzMzZ2dnZ2dnm5ubm5vLy8vLy8v//////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQDzAAAAAAAAAgPPhJtKQAAAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=',
  'base64',
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const llm = new FakeLlm(async (req) => {
  const system = req.system;
  const user = req.messages.at(-1)!.content;
  if (system.includes('Presales-Assistent')) {
    await sleep(250);
    const found = await callTool(req, 'search_knowledge', { query: user });
    const m = /\[Q(\d+)\][^\n]*\n(?:Abschnitt:[^\n]*\n)?"""\n([\s\S]*?)\n"""/.exec(found);
    if (!m) return { text: 'Dazu enthält die Wissensbasis nichts.' };
    return {
      text: `Laut Wissensbasis gilt: ${m[2]!.replace(/\s+/g, ' ').slice(0, 170)} [Q${m[1]}]`,
    };
  }
  if (system.includes('Anforderungsanalyst')) {
    await sleep(500);
    return {
      json: {
        summary: 'Servicekonzept mit Anforderungen an Incident Management und Monitoring.',
        language: 'de',
        formalRules: ['Kapitel Sicherheit höchstens 60 Wörter'],
        evaluationCriteria: ['Qualität des Servicemodells'],
        customerTerms: [{ term: 'Auftragnehmer', note: 'statt Dienstleister' }],
        requirements: [
          {
            id: 'A',
            text: 'Incident Management mit Reaktionszeiten beschreiben',
            kind: 'must',
            topic: 'Incident',
            sourceQuote: 'Incident Management',
          },
          {
            id: 'B',
            text: 'Monitoring der Systeme beschreiben',
            kind: 'should',
            topic: 'Monitoring',
          },
          { id: 'C', text: 'Zertifizierungen nachweisen', kind: 'must', topic: 'Sicherheit' },
        ],
        outline: [
          {
            id: 'a',
            number: '1',
            title: 'Incident Management',
            level: 1,
            purpose: 'Störungsbearbeitung',
            requirementIds: ['A'],
            authorRole: 'service_manager',
            targetWords: 120,
          },
          {
            id: 'b',
            number: '2',
            title: 'Monitoring',
            level: 1,
            purpose: 'Überwachung',
            requirementIds: ['B'],
            authorRole: 'solution_architect',
          },
          {
            id: 'c',
            number: '3',
            title: 'Sicherheit',
            level: 1,
            purpose: 'Zertifikate',
            requirementIds: ['C'],
            authorRole: 'security',
            maxWords: 60,
          },
        ],
      },
    };
  }
  if (system.includes('Rechercheur')) {
    await sleep(300);
    const found = await callTool(req, 'search_knowledge', {
      query: /Kapitel \d+ „([^"”]+)/.exec(user)?.[1] ?? 'Betrieb',
    });
    const m = /\[(K\d+)\][^\n]*\n(?:Abschnitt:[^\n]*\n)?"""\n([\s\S]*?)\n"""/.exec(found);
    if (m) {
      const quote = m[2]!
        .split(/[.\n]/)
        .find((x) => x.trim().length > 25)
        ?.trim();
      if (quote)
        await callTool(req, 'record_fact', { statement: quote.slice(0, 200), quote, ref: m[1] });
    }
    await callTool(req, 'report_gaps', { gaps: [] });
    return { text: '' };
  }
  if (system.includes('schreibst ein Kapitel')) {
    await sleep(400);
    const chapter = /Dein Kapitel: (\d+) /.exec(user)?.[1];
    const fact = /\[F1\]/.test(user) ? ' Das belegen unsere Unterlagen [F1].' : '';
    if (chapter === '2')
      return {
        json: {
          content: `Wir überwachen alle Systeme rund um die Uhr.${fact} [OFFEN: eingesetzte Monitoring-Werkzeuge nennen]`,
          usedFactIds: [],
          openPoints: [],
          addressedRequirementIds: [],
        },
      };
    return {
      json: {
        content: `Der Auftragnehmer beschreibt hier den Prozess für Kapitel ${chapter}.${fact}\n\n### Vorgehen\n\n- Aufnahme\n- Bearbeitung\n- Abschluss`,
        usedFactIds: [],
        openPoints: [],
        addressedRequirementIds: [],
      },
    };
  }
  if (system.includes('unabhängiger Prüfer')) {
    await sleep(400);
    return {
      json: {
        coverage: [
          {
            requirementId: 'R-001',
            status: 'covered',
            sectionIds: ['S-01'],
            comment: 'Prozess beschrieben.',
          },
          {
            requirementId: 'R-002',
            status: 'partial',
            sectionIds: ['S-02'],
            comment: 'Werkzeuge fehlen.',
          },
          {
            requirementId: 'R-003',
            status: 'covered',
            sectionIds: ['S-03'],
            comment: 'ISO 27001 genannt.',
          },
        ],
        findings: [
          {
            severity: 'major',
            kind: 'style',
            sectionId: 'S-01',
            requirementId: 'R-001',
            message: 'Der Text ist zu allgemein; Reaktionszeiten konkret nennen.',
          },
        ],
        summary: 'Weitgehend belastbar, bei Monitoring fehlen Belege.',
      },
    };
  }
  if (system.includes('Lektor')) {
    await sleep(300);
    const current = /Aktueller Text:\n"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? '';
    return {
      json: {
        content: `${current}\n\nDie Reaktionszeit beträgt je nach Priorität zwischen 30 Minuten und 8 Stunden.`,
        summary: 'Reaktionszeiten ergänzt',
      },
    };
  }
  return { text: '' };
});

const embedder = ML ? new MlEmbedder(ML) : new HashEmbedder();
const config = {
  ...loadConfig({
    DATA_DIR: dataDir,
    ANTHROPIC_API_KEY: 'smoke',
    ...(ML ? { ML_SERVICE_URL: ML } : {}),
  }),
  dataDir,
};
const ctx = {
  config,
  db,
  embedder,
  llm,
  ocr: ML ? new MlOcr(ML) : undefined,
  stt: new MlSpeechToText(ML),
  tts: {
    available: true,
    async speak(text: string) {
      spoken.push(text);
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(mp3));
          c.close();
        },
      });
    },
  },
};

const kb = { db, embedder, config: { dataDir }, ocr: ctx.ocr };
const add = (title: string, category: string, content: string, meta: object = {}) =>
  ingestDocument(kb, {
    buffer: Buffer.from(content),
    filename: `${title}.md`,
    mime: 'text/markdown',
    meta: { title, category, tags: [], ...meta } as never,
  });
await add(
  'Betriebs- und Supportkonzept',
  'concept',
  '# Incident Management\n\nStörungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet, die Behebung erfolgt innerhalb von 4 Stunden. Der Service Desk ist an allen Werktagen von 7 bis 19 Uhr erreichbar.\n\n# Monitoring\n\nAlle Systeme werden rund um die Uhr überwacht, Schwellwerte lösen automatisch Tickets aus.',
  { vendor: 'Demo' },
);
await add(
  'ISO 27001 Zertifikat',
  'certificate',
  'Das Beispiel-Rechenzentrum ist nach ISO 27001 zertifiziert. Das Zertifikat gilt bis Dezember 2027 und umfasst Betrieb, Support und Datensicherung.',
  { vendor: 'Demo', validUntil: '2027-12-31' },
);
await add(
  'Dell PowerEdge R760 Datenblatt',
  'product',
  'Der Dell PowerEdge R760 ist ein 2HE-Server mit zwei Prozessoren für Virtualisierung, Datenbanken und KI-Inferenz. Er unterstützt bis zu 8 TB Arbeitsspeicher.',
  { vendor: 'Dell', validUntil: '2028-06-30' },
);
await add(
  'Dell Preisliste 06/2026',
  'pricelist',
  'Artikel | Bezeichnung | Preis\n210-BGQR | PowerEdge R660 Basis | 3.499,00 EUR\n400-BLLL | SSD 1,92 TB | 389,00 EUR',
  { vendor: 'Dell', validUntil: '2026-06-30' },
);

const app = await buildServer(ctx as never);
app.get('/api/_debug/spoken', async () => spoken);
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log('smoke server bereit');
