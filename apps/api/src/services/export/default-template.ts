import { AlignmentType, Document, Footer, Header, HeadingLevel, Packer, PageBreak, PageNumber, Paragraph, TextRun } from 'docx';
import { CONTENT_MARKER } from './template.js';

/**
 * Neutrale Standardvorlage, solange keine Firmenvorlage hinterlegt ist. Sie enthält Deckblatt, Kopf- und
 * Fußzeile mit Platzhaltern und die Formatvorlagen, die der Export verwendet. Als Ausgangspunkt für die
 * eigene Vorlage herunterladbar: in Word Logo, Farben und Schriften anpassen und wieder hochladen.
 */
export async function buildDefaultTemplate(): Promise<Buffer> {
  const ink = '1F2937';
  const doc = new Document({
    creator: 'bid-hub',
    title: '{{TITEL}}',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 120, line: 276 } } },
        title: { run: { font: 'Calibri', size: 56, bold: true, color: ink }, paragraph: { spacing: { before: 3200, after: 240 } } },
        heading1: { run: { font: 'Calibri', size: 32, bold: true, color: ink }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: 'Calibri', size: 28, bold: true, color: ink }, paragraph: { spacing: { before: 280, after: 100 } } },
        heading3: { run: { font: 'Calibri', size: 24, bold: true, color: ink }, paragraph: { spacing: { before: 200, after: 80 } } },
        heading4: { run: { font: 'Calibri', size: 22, bold: true, italics: true, color: ink }, paragraph: { spacing: { before: 160, after: 60 } } },
      },
      paragraphStyles: [
        {
          id: 'Quote', name: 'Quote', basedOn: 'Normal', quickFormat: true,
          run: { italics: true, color: '555555' }, paragraph: { indent: { left: 567 } },
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1418, bottom: 1418, left: 1418, right: 1418 } } },
        headers: {
          default: new Header({
            children: [new Paragraph({ children: [new TextRun({ text: '{{KUNDE}} · {{TITEL}}', size: 18, color: '666666' })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ children: ['Seite ', PageNumber.CURRENT, ' von ', PageNumber.TOTAL_PAGES], size: 18, color: '666666' })],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ text: '{{TITEL}}', heading: HeadingLevel.TITLE }),
          new Paragraph({ children: [new TextRun({ text: '{{AUSSCHREIBUNG}}', size: 32, color: ink })] }),
          new Paragraph({ children: [new TextRun({ text: '{{KUNDE}}', size: 28, color: '555555' })] }),
          new Paragraph({ children: [new TextRun({ text: '{{DATUM}}', size: 24, color: '555555' })] }),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ text: CONTENT_MARKER }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
