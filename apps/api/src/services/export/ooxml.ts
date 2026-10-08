import { marked, type Token, type Tokens } from 'marked';

/** Zuordnung von Stilnamen („heading 1", „List Bullet") der Vorlage zu ihren IDs. */
export class StyleResolver {
  private readonly byName = new Map<string, string>();
  private readonly numbered = new Set<string>();

  constructor(stylesXml: string) {
    for (const m of stylesXml.matchAll(/<w:style\b[^>]*?w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
      const id = m[1]!;
      const name = /<w:name w:val="([^"]+)"/.exec(m[2]!)?.[1];
      if (name) this.byName.set(name.toLowerCase(), id);
      if (/<w:numPr>/.test(m[2]!)) this.numbered.add(id);
    }
  }

  id(name: string): string | undefined {
    return this.byName.get(name.toLowerCase());
  }
  /** Ist die Nummerierung dieses Stils in der Vorlage hinterlegt (dann darf der Export keine Nummern davorsetzen)? */
  isAutoNumbered(name: string): boolean {
    const id = this.id(name);
    return id !== undefined && this.numbered.has(id);
  }
}

export interface RenderOptions {
  styles: StyleResolver;
  /** Quellenmarken [F3] als hochgestellten Verweis erhalten statt entfernen. */
  keepFactMarkers: boolean;
}

interface Fmt {
  b?: boolean;
  i?: boolean;
  code?: boolean;
  strike?: boolean;
  sup?: boolean;
  highlight?: boolean;
}

// XML 1.0 erlaubt keine Steuerzeichen; sie stammen gelegentlich aus PDF-Text.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
export const escapeXml = (s: string): string =>
  s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** marked liefert Text HTML-maskiert; für Word brauchen wir den Klartext. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function run(text: string, f: Fmt = {}): string {
  const rpr = [
    f.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '',
    f.b ? '<w:b/>' : '',
    f.i ? '<w:i/>' : '',
    f.strike ? '<w:strike/>' : '',
    f.highlight ? '<w:highlight w:val="yellow"/>' : '',
    f.sup ? '<w:vertAlign w:val="superscript"/>' : '',
  ].join('');
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

interface ParaProps {
  style?: string | undefined;
  keepNext?: boolean;
  ind?: { left: number; hanging?: number };
  italic?: boolean;
}

export function para(runs: string, p: ParaProps = {}): string {
  const ppr = [
    p.style ? `<w:pStyle w:val="${p.style}"/>` : '',
    p.keepNext ? '<w:keepNext/>' : '',
    p.ind ? `<w:ind w:left="${p.ind.left}"${p.ind.hanging ? ` w:hanging="${p.ind.hanging}"` : ''}/>` : '',
  ].join('');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs}</w:p>`;
}

const HEADING_SIZES = [32, 28, 26, 24, 22, 22, 22, 22, 22];

/** Überschrift in der Stilvorlage; fehlt der Stil, wird sie direkt formatiert. */
export function heading(level: number, text: string, opts: RenderOptions): string {
  const l = Math.min(9, Math.max(1, level));
  const style = opts.styles.id(`heading ${l}`);
  if (style) return para(run(text), { style, keepNext: true });
  const size = HEADING_SIZES[l - 1]!;
  return `<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

const MARKER = /(\[OFFEN:[^\]]*\]|\[F\d+\])/;

function textRuns(text: string, f: Fmt, o: RenderOptions): string {
  return text
    .split(MARKER)
    .filter((part) => part !== '')
    .map((part) => {
      // Offene Punkte bleiben im Export sichtbar markiert: Niemand soll sie versehentlich abgeben.
      if (part.startsWith('[OFFEN:')) return run(part, { ...f, b: true, highlight: true });
      if (/^\[F\d+\]$/.test(part)) return o.keepFactMarkers ? run(part, { ...f, sup: true }) : '';
      return run(part, f);
    })
    .join('');
}

function inline(tokens: Token[] | undefined, f: Fmt, o: RenderOptions): string {
  if (!tokens) return '';
  return tokens
    .map((t): string => {
      switch (t.type) {
        case 'text': {
          const tt = t as Tokens.Text;
          return tt.tokens?.length ? inline(tt.tokens, f, o) : textRuns(unescapeHtml(tt.text), f, o);
        }
        case 'escape':
          return textRuns(unescapeHtml((t as Tokens.Escape).text), f, o);
        case 'strong':
          return inline((t as Tokens.Strong).tokens, { ...f, b: true }, o);
        case 'em':
          return inline((t as Tokens.Em).tokens, { ...f, i: true }, o);
        case 'del':
          return inline((t as Tokens.Del).tokens, { ...f, strike: true }, o);
        case 'codespan':
          return run(unescapeHtml((t as Tokens.Codespan).text), { ...f, code: true });
        case 'br':
          return '<w:r><w:br/></w:r>';
        case 'link': {
          const l = t as Tokens.Link;
          const label = inline(l.tokens, f, o);
          const plain = unescapeHtml(l.text);
          return l.href && l.href !== plain && !l.href.startsWith('#') ? `${label}${run(` (${l.href})`, f)}` : label;
        }
        case 'image':
          return run(unescapeHtml((t as Tokens.Image).text), f);
        case 'html':
          return run(unescapeHtml((t as Tokens.HTML).text.replace(/<[^>]+>/g, '')), f);
        default:
          return 'raw' in t ? run(String(t.raw), f) : '';
      }
    })
    .join('');
}

const TABLE_BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') +
  '</w:tblBorders>';

function table(t: Tokens.Table, o: RenderOptions): string {
  const cols = Math.max(1, t.header.length);
  const width = Math.floor(9000 / cols);
  const style = o.styles.id('table grid');
  const cell = (tokens: Token[], header: boolean): string =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header && !style ? '<w:shd w:val="clear" w:color="auto" w:fill="E8E8E8"/>' : ''}</w:tcPr>${para(inline(tokens, header ? { b: true } : {}, o))}</w:tc>`;
  const row = (cells: Tokens.TableCell[], header: boolean): string =>
    `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((c) => cell(c.tokens, header)).join('')}</w:tr>`;

  return (
    `<w:tbl><w:tblPr>${style ? `<w:tblStyle w:val="${style}"/>` : ''}<w:tblW w:w="0" w:type="auto"/>${style ? '' : TABLE_BORDERS}</w:tblPr>` +
    `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>` +
    row(t.header, true) +
    t.rows.map((r) => row(r, false)).join('') +
    // Nach einer Tabelle verlangt Word einen Absatz; er schafft zugleich Abstand.
    `</w:tbl>${para('')}`
  );
}

function list(l: Tokens.List, depth: number, sectionLevel: number, o: RenderOptions): string[] {
  const out: string[] = [];
  const base = l.ordered ? 'list number' : 'list bullet';
  const styleName = depth === 0 ? base : `${base} ${Math.min(depth + 1, 5)}`;
  const style = o.styles.id(styleName) ?? (depth > 0 ? o.styles.id(base) : undefined);
  let n = typeof l.start === 'number' ? l.start : 1;

  for (const item of l.items) {
    let first = true;
    for (const child of item.tokens) {
      if (child.type === 'list') {
        out.push(...list(child as Tokens.List, depth + 1, sectionLevel, o));
        continue;
      }
      const runs = child.type === 'text' || child.type === 'paragraph' ? inline((child as Tokens.Text).tokens ?? [child], {}, o) : '';
      if (!runs && !first) {
        out.push(...blocks([child], sectionLevel, o));
        continue;
      }
      if (first) {
        // Ohne Listenstil in der Vorlage: Aufzählungszeichen von Hand, mit hängendem Einzug.
        const marker = style ? '' : `${run(l.ordered ? `${n}.` : '•')}<w:r><w:tab/></w:r>`;
        out.push(para(marker + runs, { style, ...(style ? {} : { ind: { left: 360 * (depth + 1), hanging: 360 } }) }));
        first = false;
      } else {
        out.push(para(runs, { ind: { left: 360 * (depth + 1) } }));
      }
    }
    n++;
  }
  return out;
}

/**
 * Wandelt Markdown in OOXML-Absätze. `sectionLevel` ist die Überschriftenebene des Kapitels;
 * `###` im Text wird eine Ebene unter dem Kapitel eingeordnet.
 */
export function blocks(tokens: Token[], sectionLevel: number, o: RenderOptions): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push(heading(sectionLevel + (h.depth - 2), stripToText(h.text), o));
        break;
      }
      case 'paragraph':
      case 'text':
        out.push(para(inline((t as Tokens.Paragraph).tokens ?? [t], {}, o)));
        break;
      case 'list':
        out.push(...list(t as Tokens.List, 0, sectionLevel, o));
        break;
      case 'table':
        out.push(table(t as Tokens.Table, o));
        break;
      case 'code': {
        const lines = unescapeHtml((t as Tokens.Code).text).split('\n');
        out.push(para(lines.map((l, i) => (i ? '<w:r><w:br/></w:r>' : '') + run(l, { code: true })).join(''), { ind: { left: 360 } }));
        break;
      }
      case 'blockquote': {
        const style = o.styles.id('quote');
        for (const b of blocks((t as Tokens.Blockquote).tokens, sectionLevel, o)) {
          out.push(style ? b.replace('<w:p>', `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>`) : b.replace('<w:p>', '<w:p><w:pPr><w:ind w:left="567"/></w:pPr>'));
        }
        break;
      }
      case 'html':
        out.push(para(run(unescapeHtml((t as Tokens.HTML).text.replace(/<[^>]+>/g, '')))));
        break;
      default:
        break; // space, hr
    }
  }
  return out;
}

const stripToText = (s: string): string => unescapeHtml(s.replace(/[*_`]/g, ''));

/** Entfernt Quellenmarken samt vorangehendem Leerzeichen, damit kein „ ." zurückbleibt. */
export const stripFactMarkers = (markdown: string): string => markdown.replace(/\s*\[F\d+\]/g, '');

export function markdownToBody(markdown: string, sectionLevel: number, o: RenderOptions): string {
  const source = o.keepFactMarkers ? markdown : stripFactMarkers(markdown);
  return blocks(marked.lexer(source), sectionLevel, o).join('');
}
