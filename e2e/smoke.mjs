import { chromium } from 'playwright-core';
/**
 * Oberflächentest im echten Browser (Playwright/Chromium) gegen den Testserver aus smoke-server.mts.
 * Start über `pnpm e2e`. Der Sprachdialog wird nur geprüft, wenn E2E_MIC_WAV auf eine Aufnahme zeigt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.E2E_SHOTS ?? path.resolve('e2e/shots');
const TMP = os.tmpdir();
const MIC = process.env.E2E_MIC_WAV;
mkdirSync(SHOTS, { recursive: true });
const results = [];
let page;

async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('✓', name);
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    results.push(['FAIL', name, msg]);
    console.log('✗', name, '→', msg);
    try {
      await page.screenshot({ path: `${SHOTS}/fail-${results.length}.png`, fullPage: true });
    } catch {}
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
/** Wartet, bis fn einen wahren Wert liefert (Daten laden asynchron; sofortiges Lesen wäre ein Zeitfehler im Test). */
const until = async (fn, what, timeout = 15000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`Zeitüberschreitung: ${what}`);
};
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const setRole = async (r) => {
  await page.getByLabel('Rolle wählen').selectOption(r);
  await page.waitForTimeout(250);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(MIC ? [`--use-file-for-fake-audio-capture=${MIC}%noloop`] : []),
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
  acceptDownloads: true,
  locale: 'de-DE',
});
page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(BASE);

await step('Sales: landet im Chat, ohne Bid-Studio und ohne Upload', async () => {
  await page.getByLabel('Rolle wählen').selectOption('sales');
  await page.waitForSelector('.composer');
  const nav = (await page.locator('nav.nav a').allTextContents()).join('|');
  expect(nav === 'Chat|Wissensbasis', `Navigation war: ${nav}`);
  await page.goto(`${BASE}/#/bids`);
  await page.waitForTimeout(400);
  expect(page.url().endsWith('#/chat'), `URL: ${page.url()}`);
});

await step('Chat: Textfrage liefert gestreamte Antwort mit klickbarer Quelle', async () => {
  await page.getByLabel('Nachricht').fill('Welche Zertifikate gibt es für das Rechenzentrum?');
  await page.getByRole('button', { name: 'Senden' }).click();
  const bubble = page.locator('.bubble.assistant').last();
  await bubble.locator('.cite').first().waitFor({ timeout: 20000 });
  const text = await bubble.innerText();
  expect(/ISO 27001/.test(text), `Antwort: ${text.slice(0, 120)}`);
  expect((await bubble.locator('.sources .source').count()) >= 1, 'keine Quellenzeile');
  expect(/ISO 27001 Zertifikat/.test(await bubble.locator('.sources').innerText()), 'Quelle fehlt');
  await shot('01-chat-antwort');
});

await step('Chat: abgelaufene Preisliste wird als „abgelaufen“ gekennzeichnet', async () => {
  await page.getByLabel('Nachricht').fill('Was kostet die SSD 1,92 TB laut Preisliste?');
  await page.getByRole('button', { name: 'Senden' }).click();
  const bubble = page.locator('.bubble.assistant').last();
  await bubble.locator('.sources').waitFor({ timeout: 20000 });
  const src = await bubble.locator('.sources').innerText();
  expect(/Dell Preisliste/.test(src) && /abgelaufen/.test(src), `Quellen: ${src}`);
});

await step('Chat: Unterhaltung erscheint in der Liste und lässt sich wieder öffnen', async () => {
  await page.waitForSelector('.session a');
  expect((await page.locator('.session a').count()) >= 1, 'keine Sitzung');
  await page.getByRole('button', { name: 'Neue Unterhaltung' }).click();
  await page.waitForTimeout(300);
  expect((await page.locator('.bubble').count()) === 0, 'neuer Chat nicht leer');
  await page.locator('.session a').first().click();
  await page.locator('.bubble.assistant').first().waitFor({ timeout: 10000 });
  expect((await page.locator('.bubble').count()) >= 2, 'Verlauf nicht geladen');
});

await step(
  MIC
    ? 'Sprachdialog: Mikrofon → Whisper → Antwort → Vorlesen → wieder zuhören'
    : 'Sprachdialog (übersprungen: E2E_MIC_WAV nicht gesetzt)',
  async () => {
    if (!MIC) return;
    await page.getByRole('button', { name: 'Neue Unterhaltung' }).click();
    const seen = [];
    const sampler = setInterval(async () => {
      try {
        const t = await page.locator('.dialog-bar .grow').first().textContent({ timeout: 80 });
        if (t && seen.at(-1) !== t) seen.push(t);
      } catch {}
    }, 100);
    await page.getByRole('button', { name: /Sprachdialog/ }).click();
    try {
      await page
        .locator('.bubble.assistant', { hasText: '30 Minuten' })
        .waitFor({ timeout: 60000 });
      // Vorlesen abwarten und prüfen, dass wieder zugehört wird
      await page.waitForFunction(
        () => document.querySelector('.dialog-bar .grow')?.textContent?.includes('Ich höre zu'),
        null,
        { timeout: 20000 },
      );
    } finally {
      clearInterval(sampler);
    }
    console.log('   Zustände:', seen.map((s) => s.replace(/ …$/, '')).join(' → '));
    const user = await page.locator('.bubble.user').last().innerText();
    expect(
      new RegExp(process.env.E2E_MIC_EXPECT ?? 'Priorität', 'i').test(user),
      `erkannter Text: ${user}`,
    );
    console.log('   erkannt:', JSON.stringify(user));
    for (const need of [
      'Einen Moment',
      'Ich höre zu',
      'Ich verstehe dich',
      'Ich suche',
      'Ich antworte',
    ])
      expect(
        seen.some((s) => s.includes(need)),
        `Zustand fehlt: ${need}`,
      );
    const spoken = await (await fetch(`${BASE}/api/_debug/spoken`)).json();
    expect(
      spoken.length >= 1 && /30 Minuten/.test(spoken.join(' ')),
      `vorgelesen: ${JSON.stringify(spoken)}`,
    );
    expect(!/\[Q\d+\]/.test(spoken.join(' ')), 'Quellenmarke wurde mitgesprochen');
    await shot('02-sprachdialog');
    await page
      .getByRole('button', { name: /Gespräch beenden/ })
      .first()
      .click();
    await page.waitForTimeout(300);
    expect((await page.locator('.dialog-bar').count()) === 0, 'Dialog nicht beendet');
  },
);

await step('Presales: Wissensbasis zeigt Upload und Gültigkeitsmarken', async () => {
  await setRole('presales');
  await page.goto(`${BASE}/#/wissen`);
  await page.getByRole('heading', { name: 'Dokument hochladen' }).waitFor();
  await until(async () => (await page.locator('tbody tr').count()) >= 4, 'Dokumentliste');
  const rows = await page.locator('tbody tr').allInnerTexts();
  expect(
    rows.some((r) => /Dell Preisliste/.test(r) && /abgelaufen/.test(r)),
    `abgelaufene Preisliste nicht markiert: ${rows.join(' || ')}`,
  );
  expect(
    rows.some((r) => /ISO 27001/.test(r) && /gültig/.test(r)),
    'ISO nicht als gültig markiert',
  );
  await shot('03-wissensbasis');
});

await step('Upload: Dokument mit Metadaten aufnehmen, finden, bearbeiten', async () => {
  writeFileSync(
    `${TMP}/bidhub-e2e-itil.txt`,
    'ITIL Leitfaden. Der Change-Prozess des Beispielbetriebs erfordert für jede Änderung eine Freigabe durch das Change Advisory Board. Notfalländerungen werden nachträglich dokumentiert.',
  );
  await page.locator('input[type=file]').first().setInputFiles(`${TMP}/bidhub-e2e-itil.txt`);
  await page.getByLabel('Kategorie', { exact: true }).first().selectOption('concept');
  await page.getByLabel('Gültig bis').first().fill('2027-03-31');
  await page.getByLabel('Schlagworte').first().fill('itil, change');
  await page.getByRole('button', { name: 'Hochladen' }).click();
  await page.getByText(/aufgenommen: \d+ Abschnitte/).waitFor({ timeout: 30000 });
  await page.getByPlaceholder(/ISO 27001 Zertifikat, R760/).fill('Wer muss Änderungen freigeben?');
  await page.getByRole('button', { name: 'Suchen' }).click();
  await page.locator('.hit').first().waitFor({ timeout: 15000 });
  const hits = await page.locator('.hit').allInnerTexts();
  expect(
    hits.some((h) => /itil/i.test(h)),
    `Treffer: ${hits.map((h) => h.split('\n')[0]).join(' | ')}`,
  );
  await page.locator('.hit a').filter({ hasText: /itil/i }).first().click();
  await page.getByRole('heading', { level: 1, name: 'itil' }).waitFor();
  await page.getByLabel('Titel').fill('ITIL Change-Leitfaden');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByText('Gespeichert.').waitFor();
  await shot('04-dokument');
});

await step('Upload: dieselbe Datei erneut → Duplikatshinweis', async () => {
  await page.goto(`${BASE}/#/wissen`);
  await page.locator('input[type=file]').first().setInputFiles(`${TMP}/bidhub-e2e-itil.txt`);
  await page.getByRole('button', { name: 'Hochladen' }).click();
  await page.getByText(/bereits vorhanden/).waitFor({ timeout: 20000 });
});

let docUrl;
await step('Bid-Studio: Ausschreibung und Dokument aus Vorgabetext anlegen', async () => {
  await setRole('bid_management');
  await page.goto(`${BASE}/#/bids`);
  await page.getByLabel('Bezeichnung').fill('Rechenzentrumsbetrieb 2026');
  await page.getByLabel('Auftraggeber').fill('Stadt Beispielstadt');
  await page.getByLabel('Abgabefrist').fill('2026-12-01');
  await page.getByRole('button', { name: 'Ausschreibung anlegen' }).click();
  await page.getByRole('heading', { name: 'Neues Dokument nach Vorgabe des Kunden' }).waitFor();
  await page
    .getByLabel('… und/oder Text einfügen')
    .fill(
      'Der Auftragnehmer muss ein Incident Management mit Reaktionszeiten beschreiben. Der Auftragnehmer soll das Monitoring der Systeme darstellen. Zertifizierungen sind nachzuweisen. Das Kapitel Sicherheit darf höchstens 60 Wörter umfassen.',
    );
  await page.getByRole('button', { name: 'Dokument anlegen' }).click();
  await page.getByRole('button', { name: 'Analyse starten' }).waitFor();
  docUrl = page.url();
});

await step('Analyse läuft im Hintergrund; Gliederung liegt zur Freigabe vor', async () => {
  await page.getByRole('button', { name: 'Analyse starten' }).click();
  await page.getByText('Zur Freigabe.').waitFor({ timeout: 30000 });
  expect((await page.locator('table tbody tr').count()) >= 3, 'Anforderungen fehlen');
  const reqs = await page.locator('table').first().innerText();
  expect(/R-001/.test(reqs) && /belegt/.test(reqs), 'Zitat nicht als belegt markiert');
  await shot('05-gliederung');
});

await step('Vor der Freigabe wurde noch nichts geschrieben', async () => {
  await page.getByRole('tab', { name: 'Kapitel' }).click();
  await page
    .getByText(/Seiten|Es gibt noch keine Kapitel|wartet/)
    .first()
    .waitFor();
  await until(
    async () => (await page.locator('.section-item').count()) === 3,
    'Kapitelliste vor der Freigabe',
  );
  const text = await page.locator('.section-item').allInnerTexts();
  expect(
    text.every((t) => /wartet/.test(t)),
    `Kapitel: ${text.join(' | ')}`,
  );
  await page.getByRole('tab', { name: 'Anforderungen & Gliederung' }).click();
});

await step('Freigabe: Autoren recherchieren und schreiben alle Kapitel', async () => {
  await page.getByRole('button', { name: 'Gliederung freigeben und schreiben lassen' }).click();
  await page.locator('.badge', { hasText: 'Entwurf fertig' }).first().waitFor({ timeout: 90000 });
  await page.getByRole('tab', { name: 'Kapitel' }).click();
  await until(async () => (await page.locator('.section-item').count()) === 3, 'Kapitelliste');
  const items = await page.locator('.section-item').allInnerTexts();
  expect(
    items.every((t) => /fertig/.test(t)),
    `Kapitel: ${items.join(' | ')}`,
  );
  await shot('06-kapitel');
});

await step('Kapitel: Belege mit geprüftem Zitat, offene Punkte hervorgehoben', async () => {
  await page.locator('.section-item').nth(0).click();
  await page.getByRole('heading', { name: /Belege \(\d+\)/ }).waitFor();
  expect(
    /Zitat in der Quelle geprüft/.test(await page.locator('body').innerText()),
    'kein geprüfter Beleg im Kapitel 1',
  );
  await page.locator('.section-item').nth(1).click();
  await page.locator('.preview .open-point').waitFor();
  expect(/offene/.test(await page.locator('body').innerText()), 'offener Punkt nicht gemeldet');
});

await step('Kapitel bearbeiten: Speichern erzeugt neue Fassung', async () => {
  await page.locator('.section-item').nth(0).click();
  const ed = page.getByLabel('Text (Markdown)');
  await ed.fill((await ed.inputValue()) + ' Manuell ergänzt durch den Bid Manager.');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByText(/Fassung 2/).waitFor();
  await page.getByRole('button', { name: 'Versionen' }).click();
  await page.getByText(/Frühere Fassungen/).waitFor();
});

await step('Prüfung: Matrix, Befunde, gezielte Behebung', async () => {
  await page.getByRole('tab', { name: 'Prüfung' }).click();
  await page.getByRole('button', { name: 'Prüfung starten' }).click();
  await page.getByRole('heading', { name: 'Anforderungsmatrix' }).waitFor({ timeout: 60000 });
  const rows = await page.locator('table tbody tr').count();
  expect(rows >= 3, `Matrixzeilen: ${rows}`);
  await shot('07-pruefung');
  await page.getByRole('button', { name: 'Gezielt beheben lassen' }).first().click();
  await page.locator('.badge', { hasText: 'Entwurf fertig' }).first().waitFor({ timeout: 60000 });
  await page.getByRole('tab', { name: 'Kapitel' }).click();
  await page.locator('.section-item').nth(0).click();
  await page.waitForFunction(
    () => document.querySelector('#sec-text')?.value?.includes('Die Reaktionszeit beträgt'),
    null,
    { timeout: 10000 },
  );
});

let exported;
await step('Export: Word-Datei mit Standardvorlage, offene Punkte gemeldet', async () => {
  await page.getByRole('tab', { name: 'Export' }).click();
  await page
    .getByText(/offene Punkte/)
    .first()
    .waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Als Word herunterladen' }).click(),
  ]);
  exported = path.join(TMP, 'bidhub-e2e-export.docx');
  await download.saveAs(exported);
  expect(
    download.suggestedFilename() === 'Servicekonzept.docx',
    `Dateiname: ${download.suggestedFilename()}`,
  );
  await page.getByText(/Heruntergeladen mit Vorlage/).waitFor();
  await shot('08-export');
});

await step('Protokoll zeigt alle Agenten', async () => {
  await page.getByRole('tab', { name: 'Protokoll' }).click();
  await page.getByRole('heading', { name: 'Protokoll der Agenten' }).waitFor();
  const log = await page.locator('.log').innerText();
  for (const a of ['Anforderungsanalyst', 'Rechercheur', 'Autor', 'Prüfer', 'Lektor'])
    expect(log.includes(a), `Agent fehlt im Protokoll: ${a}`);
});

await step('Schmales Fenster (Telefon): kein horizontaler Seitenüberlauf', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const route of ['#/chat', '#/wissen', '#/bids']) {
    await page.goto(`${BASE}/${route}`);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow <= 1, `${route}: ${overflow}px Überlauf`);
  }
  const base = docUrl.split('#')[1].split('/').slice(0, 3).join('/');
  for (const tab of ['vorgabe', 'gliederung', 'kapitel', 'pruefung', 'export', 'protokoll']) {
    await page.goto(`${BASE}/#${base}/${tab}`);
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow <= 1, `Dokument/${tab}: ${overflow}px Überlauf`);
    if (tab === 'kapitel') await shot('09-schmal-kapitel');
  }
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(
  `\n${results.length - failed.length}/${results.length} Schritte bestanden. Export: ${exported ?? '–'}, Screenshots: ${SHOTS}`,
);
const relevant = consoleErrors.filter((e) => !/favicon/i.test(e));
console.log(
  relevant.length
    ? `Konsolenfehler im Browser:\n  ${relevant.slice(0, 8).join('\n  ')}`
    : 'Keine Konsolenfehler im Browser.',
);
process.exit(failed.length ? 1 : 0);
