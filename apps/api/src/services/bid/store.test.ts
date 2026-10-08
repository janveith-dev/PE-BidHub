import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client.js';
import { openTestDb } from '../../test-db.js';
import {
  createBid,
  createBidDocument,
  getBidDocument,
  listSectionVersions,
  listSections,
  recoverInterruptedJobs,
  replaceSections,
  saveSectionContent,
  setStatus,
  transition,
  usageTotals,
  logEvent,
} from './store.js';

let db: Db;
let docId: string;
beforeAll(async () => {
  db = await openTestDb();
  const bid = await createBid(db, {
    name: 'Rechenzentrumsbetrieb',
    customer: 'Stadt Beispielstadt',
    language: 'de',
  });
  docId = (
    await createBidDocument(db, { bidId: bid.id, title: 'Servicekonzept', specText: 'Vorgabe' })
  ).id;
  await replaceSections(db, docId, [
    {
      id: 'S-01',
      number: '1',
      title: 'Leistungsübersicht',
      level: 1,
      purpose: 'Überblick',
      requirementIds: ['R-001'],
      authorRole: 'solution_architect',
    },
  ]);
});
afterAll(async () => db.close());

describe('Bid-Store', () => {
  it('führt die Versionshistorie mit dem Autor der jeweils alten Fassung', async () => {
    const [section] = await listSections(db, docId);
    await saveSectionContent(db, section!.id, 'Erste Fassung', 'agent:writer');
    await saveSectionContent(db, section!.id, 'Zweite Fassung', 'user:bid_management');
    const third = await saveSectionContent(db, section!.id, 'Dritte Fassung', 'agent:lektor');

    expect(third).toMatchObject({
      content: 'Dritte Fassung',
      version: 3,
      last_author: 'agent:lektor',
    });
    const versions = await listSectionVersions(db, section!.id);
    // v1 wurde vom Autor-Agenten geschrieben, v2 vom Bid Manager — nicht vom jeweils Späteren.
    expect(versions.map((v) => [v.version, v.content, v.author])).toEqual([
      [2, 'Zweite Fassung', 'user:bid_management'],
      [1, 'Erste Fassung', 'agent:writer'],
    ]);
  });

  it('erlaubt Statuswechsel nur aus erlaubten Zuständen', async () => {
    await expect(transition(db, docId, ['outline_review'], 'writing')).rejects.toMatchObject({
      status: 409,
    });
    await setStatus(db, docId, 'outline_review');
    expect((await transition(db, docId, ['outline_review'], 'writing')).status).toBe('writing');
    // Ein zweiter, gleichzeitiger Start scheitert.
    await expect(transition(db, docId, ['outline_review'], 'writing')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('setzt unterbrochene Läufe beim Start zurück', async () => {
    expect(await recoverInterruptedJobs(db)).toBe(1);
    const doc = await getBidDocument(db, docId);
    expect(doc.status).toBe('outline_review');
    expect(doc.error).toContain('Neustart');
  });

  it('summiert den Tokenverbrauch aus dem Protokoll', async () => {
    await logEvent(db, docId, {
      agent: 'writer',
      kind: 'result',
      message: 'a',
      data: { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10 } },
    });
    await logEvent(db, docId, {
      agent: 'writer',
      kind: 'result',
      message: 'b',
      data: { usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 } },
    });
    await logEvent(db, docId, { agent: 'writer', kind: 'info', message: 'c' });
    expect(await usageTotals(db, docId)).toEqual({
      inputTokens: 150,
      outputTokens: 50,
      cacheReadTokens: 10,
    });
  });
});
