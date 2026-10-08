import type { Fact } from '@bid/shared';
import { openPoints } from '../bid/checks.js';
import {
  escapeXml,
  heading,
  markdownToBody,
  para,
  run,
  StyleResolver,
  type RenderOptions,
} from './ooxml.js';
import { insertBody, loadTemplate, replacePlaceholders } from './template.js';

export interface ExportSection {
  number: string;
  title: string;
  level: number;
  content: string;
  facts: Fact[];
}

export interface ExportInput {
  title: string;
  customer: string;
  bidName: string;
  /** Bereits formatiert, z. B. „8. Oktober 2026". */
  date: string;
  author: string;
  sections: ExportSection[];
  /** Quellenmarken im Text erhalten und ein Quellenverzeichnis anhängen. */
  includeSources: boolean;
}

export interface ExportResult {
  buffer: Buffer;
  /** Alle [OFFEN: …]-Platzhalter, die im Dokument stehen. */
  openPoints: string[];
  /** false: Die Vorlage hatte keinen {{INHALT}}-Absatz, der Inhalt wurde hinter den Vorlagentext gesetzt. */
  usedContentMarker: boolean;
}

function sourcesAppendix(sections: ExportSection[], o: RenderOptions): string {
  const withFacts = sections.filter((s) => s.facts.length);
  if (!withFacts.length) return '';
  const parts = [heading(1, 'Quellenverzeichnis', o)];
  for (const s of withFacts) {
    parts.push(para(run(`Kapitel ${s.number} ${s.title}`, { b: true }), { keepNext: true }));
    for (const f of s.facts) {
      const where = f.sourceType === 'web' ? f.sourceRef : 'interne Unterlage';
      parts.push(
        para(run(`[${f.id}] ${f.statement} — ${f.sourceTitle} (${where})`), {
          ind: { left: 360, hanging: 360 },
        }),
      );
    }
  }
  return parts.join('');
}

export async function buildDocx(input: ExportInput, templateBuffer: Buffer): Promise<ExportResult> {
  const tpl = await loadTemplate(templateBuffer);
  const styles = new StyleResolver(tpl.stylesXml);
  const o: RenderOptions = { styles, keepFactMarkers: input.includeSources };
  // Enthält der Überschriftenstil bereits eine Nummerierung, würde eine zweite von Hand doppelt erscheinen.
  const autoNumbered = styles.isAutoNumbered('heading 1');

  const body =
    input.sections
      .map((s) => {
        const head = heading(s.level, autoNumbered ? s.title : `${s.number} ${s.title}`, o);
        const text = s.content.trim()
          ? markdownToBody(s.content, s.level, o)
          : para(
              run('[OFFEN: Für dieses Kapitel liegt noch kein Text vor.]', {
                b: true,
                highlight: true,
              }),
            );
        return head + text;
      })
      .join('') + (input.includeSources ? sourcesAppendix(input.sections, o) : '');

  const vars = {
    TITEL: input.title,
    KUNDE: input.customer,
    AUSSCHREIBUNG: input.bidName,
    DATUM: input.date,
    AUTOR: input.author,
  };
  const withVars = replacePlaceholders(tpl.documentXml, vars);
  const { xml, usedMarker } = insertBody(withVars, body);
  tpl.zip.file('word/document.xml', xml);

  for (const name of Object.keys(tpl.zip.files)) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(name)) continue;
    tpl.zip.file(name, replacePlaceholders(await tpl.zip.files[name]!.async('string'), vars));
  }

  const core = tpl.zip.file('docProps/core.xml');
  if (core) {
    const coreXml = await core.async('string');
    const titled = /<dc:title>[\s\S]*?<\/dc:title>|<dc:title\/>/.test(coreXml)
      ? coreXml.replace(
          /<dc:title>[\s\S]*?<\/dc:title>|<dc:title\/>/,
          `<dc:title>${escapeXml(input.title)}</dc:title>`,
        )
      : coreXml.replace(
          '</cp:coreProperties>',
          `<dc:title>${escapeXml(input.title)}</dc:title></cp:coreProperties>`,
        );
    tpl.zip.file('docProps/core.xml', titled);
  }

  const buffer = await tpl.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer,
    openPoints: input.sections.flatMap((s) => openPoints(s.content)),
    usedContentMarker: usedMarker,
  };
}
