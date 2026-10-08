import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool } from './services/llm/index.js';
import { fakeStt, fakeTts, makeTestApp, multipart, ndjson, type TestApp } from './test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await makeTestApp(async (req, i) => {
    if (req.system.includes('Presales-Assistent')) {
      // Wie das Modell: erst suchen, dann mit Quellenmarke antworten.
      const found = await callTool(req, 'search_knowledge', {
        query: req.messages.at(-1)!.content,
      });
      const n = /\[Q(\d+)\]/.exec(found)?.[1];
      return {
        text: n
          ? `Wir sind nach ISO 27001 zertifiziert [Q${n}].`
          : 'Dazu enthält die Wissensbasis nichts.',
      };
    }
    return { text: `Antwort ${i}` };
  });
});
afterAll(async () => t.close());

const upload = (
  fields: Record<string, string>,
  name: string,
  content: string,
  type = 'text/plain',
) =>
  t.app.inject({
    method: 'POST',
    url: '/api/documents',
    ...multipart(fields, { name, type, content: Buffer.from(content) }),
  });

describe('Dokumente', () => {
  it('nimmt eine Datei mit Metadaten an und listet sie', async () => {
    const res = await upload(
      {
        title: 'ISO 27001 Zertifikat',
        category: 'certificate',
        vendor: 'public edge',
        tags: 'iso, sicherheit',
        validUntil: '2999-12-31',
      },
      'iso.txt',
      'Zertifikat ISO 27001 für den Betrieb der Rechenzentren der public edge GmbH.',
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({
      title: 'ISO 27001 Zertifikat',
      tags: ['iso', 'sicherheit'],
      validity: 'valid',
      version: 1,
    });

    const list = await t.app.inject({ method: 'GET', url: '/api/documents?category=certificate' });
    expect(list.json()).toHaveLength(1);
  });

  it('antwortet auf ein Duplikat mit 200 statt zu verdoppeln', async () => {
    const res = await upload(
      { category: 'certificate' },
      'kopie.txt',
      'Zertifikat ISO 27001 für den Betrieb der Rechenzentren der public edge GmbH.',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
  });

  it('übernimmt den Dateinamen als Titel und die Rolle ins Protokoll', async () => {
    const body = multipart(
      { category: 'config' },
      {
        name: 'switch-core.cfg',
        type: 'text/plain',
        content: Buffer.from('hostname core-sw-01\ninterface vlan 10\n'),
      },
    );
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: body.payload,
      // Die Header müssen zusammengeführt werden: multipart() bringt den Content-Type mit.
      headers: { ...body.headers, 'x-role': 'presales' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({ title: 'switch-core', uploadedByRole: 'presales' });

    // Eine unbekannte Rolle wird nicht übernommen.
    const other = multipart(
      { category: 'config' },
      { name: 'zwei.cfg', type: 'text/plain', content: Buffer.from('hostname core-sw-02\n') },
    );
    const res2 = await t.app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: other.payload,
      headers: { ...other.headers, 'x-role': 'admin' },
    });
    expect(res2.json().document.uploadedByRole).toBeNull();
  });

  it('weist ungültige Eingaben mit verständlicher Meldung ab', async () => {
    expect((await upload({ category: 'unbekannt' }, 'a.txt', 'x'.repeat(50))).statusCode).toBe(400);
    expect((await upload({ title: 'Kategorie fehlt' }, 'a.txt', 'x'.repeat(50))).statusCode).toBe(
      400,
    );
    const range = await upload(
      { category: 'other', validFrom: '2025-05-01', validUntil: '2025-01-01' },
      'b.txt',
      'inhalt inhalt inhalt',
    );
    expect(range.statusCode).toBe(400);
    expect(range.json().error).toContain('Gültig bis');

    const exe = await upload({ category: 'other' }, 'x.exe', 'MZ', 'application/octet-stream');
    expect(exe.statusCode).toBe(422);
    expect(exe.json().error).toContain('nicht unterstützt');

    const notMultipart = await t.app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { category: 'other' },
    });
    expect(notMultipart.statusCode).toBe(400);
    const empty = await t.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ category: 'other' }),
    });
    expect(empty.json().error).toContain('keine Datei');
  });

  it('liefert Details, Text und die Originaldatei und ändert Metadaten', async () => {
    const [doc] = (
      await t.app.inject({ method: 'GET', url: '/api/documents?category=certificate' })
    ).json();
    const detail = await t.app.inject({ method: 'GET', url: `/api/documents/${doc.id}` });
    expect(detail.json().versions).toHaveLength(1);
    const text = await t.app.inject({ method: 'GET', url: `/api/documents/${doc.id}/text` });
    expect(text.json().text).toContain('ISO 27001');
    const file = await t.app.inject({ method: 'GET', url: `/api/documents/${doc.id}/file` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain("filename*=UTF-8''iso.txt");
    expect(file.body).toContain('Zertifikat ISO 27001');

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/documents/${doc.id}`,
      payload: { validUntil: '2020-01-01' },
    });
    expect(patched.json()).toMatchObject({ validUntil: '2020-01-01', validity: 'expired' });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/documents/${doc.id}`,
      payload: { validUntil: '2999-12-31' },
    });

    expect(
      (await t.app.inject({ method: 'GET', url: '/api/documents/not-a-uuid' })).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/documents/6f0a6c1e-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('Suche', () => {
  it('findet Dokumente und respektiert Filter', async () => {
    const hits = (
      await t.app.inject({ method: 'POST', url: '/api/search', payload: { query: 'ISO 27001' } })
    ).json();
    expect(hits[0]).toMatchObject({ title: 'ISO 27001 Zertifikat', category: 'certificate' });
    const filtered = (
      await t.app.inject({
        method: 'POST',
        url: '/api/search',
        payload: { query: 'ISO 27001', categories: ['config'] },
      })
    ).json();
    expect(filtered.every((h: { category: string }) => h.category === 'config')).toBe(true);
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/search', payload: { query: '' } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('Chat', () => {
  it('streamt die Antwort mit Quellen und speichert den Verlauf', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Sind wir nach ISO 27001 zertifiziert?' },
    });
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const events = ndjson(res.body);
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'sources', 'done']);
    const sources = events.find((e) => e.type === 'sources')!.sources as {
      ref: string;
      title: string;
      validity: string;
    }[];
    expect(sources).toEqual([
      expect.objectContaining({ ref: 'Q1', title: 'ISO 27001 Zertifikat', validity: 'valid' }),
    ]);

    const sessionId = events[0]!.id as string;
    const session = (
      await t.app.inject({ method: 'GET', url: `/api/chat/sessions/${sessionId}` })
    ).json();
    expect(session.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(session.messages[1].sources[0].ref).toBe('Q1');

    // Folgefrage in derselben Sitzung: der Verlauf wird mitgegeben.
    await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { sessionId, message: 'Und bis wann gilt das?' },
    });
    const second = t.llm.calls.at(-1)!;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('gibt Sprachmodus und Werkzeug an die Anfrage weiter', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Zertifikate?', spoken: true },
    });
    const req = t.llm.calls.at(-1)!;
    expect(req.system).toContain('vorgelesen');
    expect(req.tools?.map((x) => x.name)).toEqual(['search_knowledge']);
    expect(req.model).toBe('claude-sonnet-5-5');
  });

  it('meldet Fehler als Ereignis im Strom statt die Verbindung abzubrechen', async () => {
    const failing = await makeTestApp(async () => {
      throw Object.assign(new Error('Die KI-Funktionen sind nicht eingerichtet'), {
        name: 'HttpError',
        status: 503,
      });
    });
    const res = await failing.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Hallo' },
    });
    const events = ndjson(res.body);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('nicht eingerichtet'),
    });
    await failing.close();
  });

  it('verwirft zu lange Nachrichten und unbekannte Sitzungen', async () => {
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/chat',
          payload: { message: 'x'.repeat(9000) },
        })
      ).statusCode,
    ).toBe(400);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Hallo', sessionId: '6f0a6c1e-0000-4000-8000-000000000000' },
    });
    expect(ndjson(res.body).at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('nicht gefunden'),
    });
  });

  it('listet und löscht Sitzungen', async () => {
    const list = (await t.app.inject({ method: 'GET', url: '/api/chat/sessions' })).json();
    expect(list.length).toBeGreaterThan(0);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${list[0].id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${list[0].id}` }))
        .statusCode,
    ).toBe(404);
  });
});

describe('Sprache', () => {
  it('transkribiert Aufnahmen über den ML-Dienst', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/voice/transcribe?language=de',
      headers: { 'content-type': 'audio/webm;codecs=opus' },
      payload: Buffer.alloc(2000, 1),
    });
    expect(res.json()).toEqual({ text: 'Welche Zertifikate haben wir?', language: 'de' });
    expect(fakeStt.calls.at(-1)).toEqual({ mime: 'audio/webm;codecs=opus', language: 'de' });
  });

  it('weist leere Aufnahmen ab', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: { 'content-type': 'audio/webm' },
      payload: Buffer.alloc(10),
    });
    expect(res.statusCode).toBe(400);
  });

  it('liefert Sprachausgabe als MP3-Strom', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/voice/speak',
      payload: { text: 'Guten Tag.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload.length).toBe(6);
    expect(fakeTts.spoken).toContain('Guten Tag.');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/voice/speak',
          payload: { text: 'a'.repeat(2000) },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('meldet die verfügbaren Funktionen', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/capabilities' })).json()).toEqual({
      llm: true,
      speechToText: true,
      textToSpeech: true,
      ocr: false,
      embedding: 'hash-v1',
    });
  });
});
