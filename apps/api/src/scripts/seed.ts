import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentMetaSchema } from '@bid/shared';
import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { createBid, createBidDocument, listBids } from '../services/bid/store.js';
import { createEmbedder } from '../services/embeddings.js';
import { ingestDocument } from '../services/knowledge.js';

/**
 * Spielt frei erfundene Demodaten ein: Beispieldokumente für die Wissensbasis und eine
 * Beispiel-Ausschreibung samt Kundenvorgabe für das Bid-Studio. Mehrfaches Ausführen ist unschädlich:
 * Dateien mit gleichem Inhalt werden erkannt und nicht doppelt aufgenommen.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = process.env.DEMO_DATA_DIR ?? path.resolve(here, '../../../../demo-data');

interface Entry {
  file: string;
  title: string;
  category: string;
  vendor?: string;
  tags?: string[];
  validUntil?: string;
}

const config = loadConfig();
const db = await openDb(config.databaseUrl);
await migrate(db);
const embedder = createEmbedder(config);

const entries = JSON.parse(await readFile(path.join(demoDir, 'index.json'), 'utf8')) as Entry[];
let added = 0;
for (const e of entries) {
  const result = await ingestDocument(
    { db, embedder, config },
    {
      buffer: await readFile(path.join(demoDir, e.file)),
      filename: e.file,
      mime: 'text/markdown',
      meta: DocumentMetaSchema.parse({
        title: e.title,
        category: e.category,
        vendor: e.vendor,
        tags: e.tags ?? [],
        validUntil: e.validUntil,
      }),
      role: 'presales',
    },
  );
  if (!result.duplicate) added++;
  console.log(
    `${result.duplicate ? 'vorhanden' : 'neu      '}  ${e.title} (${result.document.validity})`,
  );
}

const BID_NAME = 'Beispielausschreibung Musterstadt';
if ((await listBids(db)).some((b) => b.name === BID_NAME)) {
  console.log(`vorhanden  Ausschreibung „${BID_NAME}"`);
} else {
  const bid = await createBid(db, {
    name: BID_NAME,
    customer: 'Stadt Musterstadt',
    language: 'de',
  });
  const specText = await readFile(path.join(demoDir, 'kundenvorgabe-servicekonzept.md'), 'utf8');
  await createBidDocument(db, { bidId: bid.id, title: 'Servicekonzept', specText });
  console.log(`neu        Ausschreibung „${BID_NAME}" mit Dokument „Servicekonzept"`);
}

console.log(`\nFertig: ${added} Dokumente neu aufgenommen. Embedding-Modell: ${embedder.name}.`);
await db.close();
