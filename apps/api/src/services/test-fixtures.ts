import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import JSZip from 'jszip';

/** Minimale, gültige PDF mit einer Textzeile je Seite (nur ASCII, damit die xref-Offsets stimmen). */
export function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  out += offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

export async function makeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Servicekonzept Rechenzentrum', heading: HeadingLevel.HEADING_1 }),
          new Paragraph('Wir betreiben Ihre Systeme im Rechenzentrum mit 24x7-Überwachung.'),
          new Paragraph({ text: 'Reaktionszeiten', heading: HeadingLevel.HEADING_2 }),
          new Paragraph('Störungen der Priorität 1 werden innerhalb von 30 Minuten bearbeitet.'),
          new Table({
            rows: [
              new TableRow({ children: ['Priorität', 'Reaktionszeit'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
              new TableRow({ children: ['1', '30 Minuten'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
            ],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function makeXlsx(rows: string[][], sheetName = 'Preise'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function makePptx(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((paragraphs, i) => {
    const body = paragraphs.map((t) => `<a:p><a:r><a:t>${t.replace(/&/g, '&amp;')}</a:t></a:r></a:p>`).join('');
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld xmlns:a="a" xmlns:p="p"><p:txBody>${body}</p:txBody></p:sld>`);
  });
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}
