import JSZip from 'jszip';
import { HttpError } from '../errors.js';
import { escapeXml } from './ooxml.js';

const TEMPLATE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml';
const DOCUMENT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const MACRO_TEMPLATE_CONTENT_TYPE = 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml';

export const CONTENT_MARKER = '{{INHALT}}';

// `<w:p>` oder `<w:p …>` — nicht `<w:pPr>`, `<w:pict>` und Verwandte.
const PARAGRAPH = /<w:p[ >][\s\S]*?<\/w:p>/g;
const TEXT_RUN = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g;

export interface TemplateParts {
  zip: JSZip;
  documentXml: string;
  stylesXml: string;
}

/**
 * Öffnet eine Vorlage (.docx oder .dotx). Eine .dotx unterscheidet sich von einer .docx im
 * Inhaltstyp der Hauptdatei; ohne Anpassung öffnet Word das Ergebnis als Vorlage statt als Dokument.
 */
export async function loadTemplate(buffer: Buffer): Promise<TemplateParts> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new HttpError(422, 'Die Vorlage ist keine gültige Word-Datei (.docx oder .dotx).');
  }
  const doc = zip.file('word/document.xml');
  const types = zip.file('[Content_Types].xml');
  if (!doc || !types) throw new HttpError(422, 'Die Vorlage ist keine gültige Word-Datei (word/document.xml fehlt).');

  const typesXml = await types.async('string');
  zip.file(
    '[Content_Types].xml',
    typesXml.replaceAll(TEMPLATE_CONTENT_TYPE, DOCUMENT_CONTENT_TYPE).replaceAll(MACRO_TEMPLATE_CONTENT_TYPE, DOCUMENT_CONTENT_TYPE),
  );

  return {
    zip,
    documentXml: await doc.async('string'),
    stylesXml: (await zip.file('word/styles.xml')?.async('string')) ?? '',
  };
}

const paragraphText = (p: string): string => [...p.matchAll(TEXT_RUN)].map((m) => m[1]).join('');

/**
 * Ersetzt {{PLATZHALTER}}. Word zerlegt Text beliebig in Läufe („{{KU" + "NDE}}"); deshalb wird je
 * Absatz der zusammengesetzte Text ersetzt und im ersten Lauf abgelegt, die übrigen Läufe werden geleert.
 */
export function replacePlaceholders(xml: string, vars: Record<string, string>): string {
  return xml.replace(PARAGRAPH, (p) => {
    const full = paragraphText(p);
    if (!full.includes('{{')) return p;
    const next = full.replace(/\{\{([A-ZÄÖÜ_]+)\}\}/g, (match, key: string) => (key in vars ? escapeXml(vars[key]!) : match));
    if (next === full) return p;
    let first = true;
    return p.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, () => {
      if (first) {
        first = false;
        return `<w:t xml:space="preserve">${next}</w:t>`;
      }
      return '<w:t></w:t>';
    });
  });
}

/**
 * Setzt den Inhalt an die Stelle des Platzhalter-Absatzes {{INHALT}}. Gibt es ihn nicht, kommt der
 * Inhalt hinter den vorhandenen Vorlagentext (z. B. ein Deckblatt) und vor die Seiteneinstellungen.
 */
export function insertBody(documentXml: string, bodyXml: string): { xml: string; usedMarker: boolean } {
  let used = false;
  const replaced = documentXml.replace(PARAGRAPH, (p) => {
    if (used || !paragraphText(p).includes(CONTENT_MARKER)) return p;
    used = true;
    return bodyXml;
  });
  if (used) return { xml: replaced, usedMarker: true };

  const sect = documentXml.lastIndexOf('<w:sectPr');
  const end = documentXml.lastIndexOf('</w:body>');
  const at = sect !== -1 && sect < end ? sect : end;
  if (at === -1) throw new HttpError(422, 'Die Vorlage hat keinen Dokumentinhalt (w:body fehlt).');
  return { xml: documentXml.slice(0, at) + bodyXml + documentXml.slice(at), usedMarker: false };
}
