import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  text: string;
  /** Quellenmarke aus dem Chat („Q1") → Adresse des Dokuments. */
  citeLinks?: Record<string, string>;
  /** Faktenmarke aus dem Bid-Studio („F1") → Aussage, wird als Tooltip gezeigt. */
  factTitles?: Record<string, string>;
  /** Hervorgehobene Faktenmarke. */
  activeFact?: string | undefined;
  onFactClick?: ((id: string) => void) | undefined;
}

/**
 * Markdown mit Quellenmarken. [Q1], [F3] und [OFFEN: …] werden vor dem Rendern in Pseudo-Links
 * umgeschrieben und unten gezielt dargestellt; rohes HTML aus Modellantworten rendert react-markdown nicht.
 */
export function Markdown({ text, citeLinks, factTitles, activeFact, onFactClick }: Props) {
  const prepared = text
    .replace(/\[OFFEN:\s*([^\]]*)\]/g, (_m, t: string) => `[OFFEN: ${t.trim()}](#open)`)
    .replace(/\[(Q\d+)\]/g, '[$1](#cite-$1)')
    .replace(/\[(F\d+)\]/g, '[$1](#fact-$1)');

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('#') || /^(https?:|mailto:)/i.test(url) ? url : '')}
        components={{
          a({ href, children }): ReactNode {
            if (href === '#open') return <mark className="open-point">{children}</mark>;
            if (href?.startsWith('#cite-')) {
              const ref = href.slice(6);
              const target = citeLinks?.[ref];
              return (
                <a
                  className="cite"
                  href={target ?? '#'}
                  title={target ? 'Quelle öffnen' : 'Quelle unbekannt'}
                >
                  {ref}
                </a>
              );
            }
            if (href?.startsWith('#fact-')) {
              const id = href.slice(6);
              return (
                <button
                  type="button"
                  className="cite"
                  title={factTitles?.[id] ?? 'Quelle nicht gefunden'}
                  style={{
                    border: 0,
                    cursor: onFactClick ? 'pointer' : 'default',
                    outline: activeFact === id ? '2px solid var(--accent)' : undefined,
                  }}
                  onClick={() => onFactClick?.(id)}
                >
                  {id}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}
