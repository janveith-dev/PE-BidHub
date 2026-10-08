import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';

const config = loadConfig();
const db = await openDb(config.databaseUrl);
const ran = await migrate(db);
console.log(ran.length ? `Migrationen angewendet: ${ran.join(', ')}` : 'Datenbank ist aktuell.');
await db.close();
