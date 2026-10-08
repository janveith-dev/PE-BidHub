import { XMLValidator } from 'fast-xml-parser';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultTemplate } from './default-template.js';
import { buildDocx, type ExportInput } from './docx-export.js';
import { insertBody, loadTemplate, replacePlaceholders } from './template.js';

const fact = (id: string, statement: string) => ({
  id,
  statement,
  sourceType: 'kb' as const,
  sourceRef: 'doc',
  sourceTitle: 'Betriebskonzept',
  quoteVerified: true,
});

const input = (over: Partial<ExportInput> = {}): ExportInput => ({
  title: 'Servicekonzept',
  customer: 'Stadt Beispielstadt',
  bidName: 'RZ-Betrieb',
  date: '8. Oktober 2026',
  author: 'public edge GmbH',
  includeSources: false,
  sections: [
    {
      number: '1',
      title: 'Incident Management',
      level: 1,
      facts: [fact('F1', 'Priorität 1 in 30 Minuten.')],
      content:
        'Wir reagieren in 30 Minuten [F1].\n\n### Eskalation\n\n- Stufe 1\n- Stufe 2\n  - Teamleitung',
    },
    {
      number: '1.1',
      title: 'Monitoring',
      level: 2,
      facts: [],
      content: '[OFFEN: Werkzeuge nennen]',
    },
  ],
  ...over,
});

let template: Buffer;
beforeAll(async () => {
  template = await buildDefaultTemplate();
});

async function parts(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const read = (n: string) => zip.file(n)!.async('string');
  return { zip, read };
}

/** Passt eine Datei der Vorlage an und gibt die neue Vorlage zurück. */
async function modify(
  buf: Buffer,
  edits: Record<string, (xml: string) => string>,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  for (const [name, fn] of Object.entries(edits))
    zip.file(name, fn(await zip.file(name)!.async('string')));
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('Standardvorlage', () => {
  it('enthält Formatvorlagen, Deckblatt-Platzhalter und die Inhaltsmarke', async () => {
    const { read } = await parts(template);
    const styles = await read('word/styles.xml');
    for (const name of ['heading 1', 'heading 2', 'heading 3', 'Title', 'Quote']) {
      expect(styles.toLowerCase()).toContain(`w:val="${name.toLowerCase()}"`);
    }
    const doc = await read('word/document.xml');
    for (const ph of ['{{TITEL}}', '{{KUNDE}}', '{{AUSSCHREIBUNG}}', '{{DATUM}}', '{{INHALT}}'])
      expect(doc).toContain(ph);
  });
});

describe('DOCX-Export', () => {
  it('erzeugt wohlgeformtes XML in allen Teilen', async () => {
    const out = await buildDocx(input({ includeSources: true }), template);
    const { zip, read } = await parts(out.buffer);
    for (const name of Object.keys(zip.files).filter((n) =>
      /^(word\/(document|styles|header\d*|footer\d*|numbering)|docProps\/core)\.xml$/.test(n),
    )) {
      expect(XMLValidator.validate(await read(name)), name).toBe(true);
    }
  });

  it('ersetzt Platzhalter in Deckblatt, Kopfzeile und Dokumenteigenschaften', async () => {
    const { buffer } = await buildDocx(input(), template);
    const { zip, read } = await parts(buffer);
    const doc = await read('word/document.xml');
    expect(doc).not.toMatch(/\{\{[A-ZÄÖÜ_]+\}\}/);
    const header = Object.keys(zip.files).find((n) => /^word\/header\d*\.xml$/.test(n))!;
    expect(await read(header)).toContain('Stadt Beispielstadt · Servicekonzept');
    expect(await read('docProps/core.xml')).toContain('<dc:title>Servicekonzept</dc:title>');
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain('8. Oktober 2026');
  });

  it('ordnet Überschriften den Formatvorlagen zu und nummeriert von Hand, wenn die Vorlage es nicht tut', async () => {
    const { buffer } = await buildDocx(input(), template);
    const doc = await (await parts(buffer)).read('word/document.xml');
    expect(doc).toMatch(/<w:pStyle w:val="Heading1"\/>[\s\S]*?1 Incident Management/);
    expect(doc).toMatch(/<w:pStyle w:val="Heading2"\/>[\s\S]*?1\.1 Monitoring/);
    // „###" im Text steht eine Ebene unter dem Kapitel: unter Kapitel 1 also Überschrift 2.
    expect(doc).toMatch(/<w:pStyle w:val="Heading2"\/>[\s\S]*?Eskalation/);
  });

  it('lässt die Nummern weg, wenn der Überschriftenstil der Vorlage selbst nummeriert', async () => {
    const numbered = await modify(template, {
      'word/styles.xml': (xml) =>
        xml.replace(
          /(<w:style [^>]*w:styleId="Heading1"[^>]*>[\s\S]*?<w:pPr>)/,
          '$1<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>',
        ),
    });
    const { buffer } = await buildDocx(input(), numbered);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain('Incident Management');
    expect(text).not.toContain('1 Incident Management');
  });

  it('entfernt Quellenmarken ohne Leerzeichenrest — oder behält sie mit Quellenverzeichnis', async () => {
    const plain = await buildDocx(input(), template);
    const plainText = (await mammoth.extractRawText({ buffer: plain.buffer })).value;
    expect(plainText).toContain('in 30 Minuten.');
    expect(plainText).not.toMatch(/\[F\d+\]|Quellenverzeichnis/);

    const withSources = await buildDocx(input({ includeSources: true }), template);
    const doc = await (await parts(withSources.buffer)).read('word/document.xml');
    expect(doc).toContain('<w:vertAlign w:val="superscript"/>');
    const text = (await mammoth.extractRawText({ buffer: withSources.buffer })).value;
    expect(text).toContain('Quellenverzeichnis');
    expect(text).toContain('[F1] Priorität 1 in 30 Minuten. — Betriebskonzept (interne Unterlage)');
  });

  it('hebt offene Punkte hervor und meldet sie, auch bei leeren Kapiteln', async () => {
    const out = await buildDocx(
      input({
        sections: [
          ...input().sections,
          { number: '2', title: 'Leer', level: 1, facts: [], content: '' },
        ],
      }),
      template,
    );
    expect(out.openPoints).toEqual(['Werkzeuge nennen']);
    const doc = await (await parts(out.buffer)).read('word/document.xml');
    expect(doc.match(/<w:highlight w:val="yellow"\/>/g)).toHaveLength(2); // [OFFEN] + Platzhalter für das leere Kapitel
    expect(doc).toContain('Für dieses Kapitel liegt noch kein Text vor');
  });

  it('maskiert Sonderzeichen in Text, Titel und Kundennamen', async () => {
    const out = await buildDocx(
      input({
        title: 'Konzept <A & B>',
        customer: 'Müller & Söhne <GmbH>',
        sections: [
          {
            number: '1',
            title: 'Soll & Haben',
            level: 1,
            facts: [],
            content: 'Preis: 5 < 6 & 7 > 6, „Anführungszeichen" und "gerade".\n\n`a<b>&c`',
          },
        ],
      }),
      template,
    );
    const { zip, read } = await parts(out.buffer);
    for (const n of Object.keys(zip.files).filter((x) =>
      /^word\/(document|header\d*)\.xml$/.test(x),
    ))
      expect(XMLValidator.validate(await read(n)), n).toBe(true);
    const text = (await mammoth.extractRawText({ buffer: out.buffer })).value;
    expect(text).toContain('Konzept <A & B>');
    expect(text).toContain('Müller & Söhne <GmbH>');
    expect(text).toContain('Preis: 5 < 6 & 7 > 6');
    expect(text).toContain('a<b>&c');
  });

  it('entfernt Steuerzeichen, die XML nicht verträgt', async () => {
    const out = await buildDocx(
      input({
        sections: [
          {
            number: '1',
            title: 'T',
            level: 1,
            facts: [],
            content: 'Text\u0000mit\u0008Steuerzeichen und \u000Bmehr.',
          },
        ],
      }),
      template,
    );
    expect(XMLValidator.validate(await (await parts(out.buffer)).read('word/document.xml'))).toBe(
      true,
    );
  });

  it('wandelt Tabellen mit Kopfzeile', async () => {
    const out = await buildDocx(
      input({
        sections: [
          {
            number: '1',
            title: 'SLA',
            level: 1,
            facts: [],
            content: '| Prio | Zeit |\n|---|---|\n| 1 | 30 min |\n| 2 | 2 h |',
          },
        ],
      }),
      template,
    );
    const doc = await (await parts(out.buffer)).read('word/document.xml');
    expect(doc.match(/<w:tr>/g)).toHaveLength(3);
    expect(doc).toContain('<w:tblHeader/>');
    expect(doc.match(/<w:gridCol /g)).toHaveLength(2);
  });
});

describe('Firmenvorlagen', () => {
  it('macht aus einer .dotx ein Dokument', async () => {
    const dotx = await modify(template, {
      '[Content_Types].xml': (xml) =>
        xml.replace('wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml'),
    });
    expect(await (await parts(dotx)).read('[Content_Types].xml')).toContain('template.main+xml');
    const out = await buildDocx(input(), dotx);
    const types = await (await parts(out.buffer)).read('[Content_Types].xml');
    expect(types).toContain('wordprocessingml.document.main+xml');
    expect(types).not.toContain('template.main+xml');
  });

  it('ersetzt Platzhalter, die Word auf mehrere Textläufe verteilt hat', async () => {
    const split = await modify(template, {
      'word/document.xml': (xml) =>
        xml.replace(/<w:t[^>]*>\{\{KUNDE\}\}<\/w:t>/, '<w:t>{{KU</w:t></w:r><w:r><w:t>NDE}}</w:t>'),
    });
    expect(await (await parts(split)).read('word/document.xml')).toContain('{{KU</w:t>');
    const out = await buildDocx(input(), split);
    const text = (await mammoth.extractRawText({ buffer: out.buffer })).value;
    expect(text).toContain('Stadt Beispielstadt');
    expect(text).not.toContain('{{');
  });

  it('hängt den Inhalt an, wenn die Vorlage keine Inhaltsmarke hat, und behält den Vorlagentext', async () => {
    const noMarker = await modify(template, {
      'word/document.xml': (xml) =>
        xml.replace(/<w:p[ >](?:(?!<\/w:p>)[\s\S])*\{\{INHALT\}\}[\s\S]*?<\/w:p>/, ''),
    });
    const out = await buildDocx(input(), noMarker);
    expect(out.usedContentMarker).toBe(false);
    const doc = await (await parts(out.buffer)).read('word/document.xml');
    expect(XMLValidator.validate(doc)).toBe(true);
    // Der Inhalt steht hinter dem Deckblatt und vor den Seiteneinstellungen.
    expect(doc.indexOf('Incident Management')).toBeGreaterThan(doc.indexOf('Servicekonzept'));
    expect(doc.indexOf('Incident Management')).toBeLessThan(doc.lastIndexOf('<w:sectPr'));
  });

  it('nutzt Listenstile der Vorlage und fällt sonst auf Aufzählungszeichen zurück', async () => {
    const without = await buildDocx(input(), template);
    expect(await (await parts(without.buffer)).read('word/document.xml')).toContain('•');

    const withStyles = await modify(template, {
      'word/styles.xml': (xml) =>
        xml.replace(
          '</w:styles>',
          '<w:style w:type="paragraph" w:styleId="Aufzaehlung"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/></w:style></w:styles>',
        ),
    });
    const out = await buildDocx(input(), withStyles);
    const doc = await (await parts(out.buffer)).read('word/document.xml');
    expect(doc).toContain('<w:pStyle w:val="Aufzaehlung"/>');
    expect(doc).not.toContain('•');
  });

  it('weist Dateien ab, die keine Word-Vorlage sind', async () => {
    await expect(loadTemplate(Buffer.from('kein zip'))).rejects.toMatchObject({ status: 422 });
    const zip = new JSZip();
    zip.file('hallo.txt', 'x');
    await expect(
      loadTemplate(Buffer.from(await zip.generateAsync({ type: 'uint8array' }))),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('Platzhalter', () => {
  it('lässt unbekannte Platzhalter stehen und maskiert Werte', () => {
    const xml = '<w:p><w:r><w:t>{{KUNDE}} und {{UNBEKANNT}}</w:t></w:r></w:p>';
    expect(replacePlaceholders(xml, { KUNDE: 'A & B' })).toBe(
      '<w:p><w:r><w:t xml:space="preserve">A &amp; B und {{UNBEKANNT}}</w:t></w:r></w:p>',
    );
  });

  it('füllt nur den ersten Marken-Absatz', () => {
    const xml =
      '<w:body><w:p><w:r><w:t>{{INHALT}}</w:t></w:r></w:p><w:p><w:r><w:t>{{INHALT}}</w:t></w:r></w:p></w:body>';
    const { xml: out } = insertBody(xml, '<w:p>X</w:p>');
    expect(out).toBe('<w:body><w:p>X</w:p><w:p><w:r><w:t>{{INHALT}}</w:t></w:r></w:p></w:body>');
  });
});
