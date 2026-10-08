import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { BidDocumentDetailDto, SectionDto, SectionVersionDto } from '@bid/shared';
import { api } from '../../api';
import { Markdown } from '../../components/Markdown';
import { ErrorNotice, Loading, Notice, Spinner, formatDateTime } from '../../components/ui';
import { roleLabel, SECTION_STATUS_LABEL } from './labels';

const OPEN_POINTS = /\[OFFEN:/g;

export function SectionsView({
  doc,
  selectedId,
  onSelect,
}: {
  doc: BidDocumentDetailDto;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const sections = doc.sections;
  const selected = sections.find((s) => s.id === selectedId) ?? sections[0];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [instruction, setInstruction] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [activeFact, setActiveFact] = useState<string>();

  const busy = doc.running || !['written', 'reviewed'].includes(doc.status);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bid-doc', doc.id] });
    void qc.invalidateQueries({ queryKey: ['bid-events', doc.id] });
  };

  const save = useMutation({
    mutationFn: (v: { id: string; content: string }) =>
      api.put<SectionDto>(`/api/bid-sections/${v.id}`, { content: v.content }),
    onSuccess: (_s, v) => {
      setDrafts((d) => {
        const { [v.id]: _drop, ...rest } = d;
        return rest;
      });
      refresh();
      void qc.invalidateQueries({ queryKey: ['section-versions', v.id] });
    },
  });
  const ai = useMutation({
    mutationFn: (v: { id: string; kind: 'rewrite' | 'revise'; instruction: string }) =>
      api.post(`/api/bid-sections/${v.id}/${v.kind}`, { instruction: v.instruction }),
    onSuccess: () => {
      setInstruction('');
      refresh();
    },
  });
  const retry = useMutation({
    mutationFn: () => api.post(`/api/bid-documents/${doc.id}/retry-failed`),
    onSuccess: refresh,
  });

  if (!sections.length)
    return (
      <Notice>Es gibt noch keine Kapitel. Sie entstehen mit der Freigabe der Gliederung.</Notice>
    );
  const sel = selected!;
  const content = drafts[sel.id] ?? sel.content;
  const dirty = drafts[sel.id] !== undefined && drafts[sel.id] !== sel.content;
  const failed = sections.filter((s) => s.status === 'failed').length;
  const open = (sel.content.match(OPEN_POINTS) ?? []).length;
  const words = content.trim()
    ? content
        .replace(/\[F\d+\]/g, '')
        .trim()
        .split(/\s+/).length
    : 0;
  const overLimit = sel.maxWords !== null && words > sel.maxWords;

  const choose = (id: string) => {
    if (dirty && !window.confirm('Ungespeicherte Änderungen an diesem Kapitel verwerfen?')) return;
    setDrafts((d) => {
      const { [sel.id]: _drop, ...rest } = d;
      return rest;
    });
    setActiveFact(undefined);
    setShowVersions(false);
    onSelect(id);
  };

  return (
    <div
      className="grid-2"
      style={{ gridTemplateColumns: 'minmax(14rem, 18rem) minmax(0, 1fr)', alignItems: 'start' }}
    >
      <div className="stack-sm">
        {failed > 0 && !busy && (
          <button
            className="primary"
            style={{ width: '100%' }}
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            {failed} fehlgeschlagene Kapitel nachholen
          </button>
        )}
        <ErrorNotice error={retry.error} />
        <div className="section-list" role="list">
          {sections.map((s) => (
            <button
              key={s.id}
              className="section-item"
              aria-current={s.id === sel.id}
              onClick={() => choose(s.id)}
              style={{ paddingLeft: `${0.7 + (s.level - 1) * 0.8}rem` }}
            >
              <span className="mono">{s.number}</span>
              <span
                className="grow"
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {s.title}
              </span>
              <span
                className={`badge ${s.status === 'written' ? 'written' : s.status === 'failed' ? 'failed' : 'running'}`}
              >
                {SECTION_STATUS_LABEL[s.status]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="stack">
        <section className="card">
          <div className="row between">
            <div>
              <h2 style={{ margin: 0 }}>
                {sel.number} {sel.title}
              </h2>
              <p className="muted small" style={{ margin: 0 }}>
                {roleLabel(sel.authorRole)} · {words} Wörter
                {sel.maxWords
                  ? ` von höchstens ${sel.maxWords}`
                  : sel.targetWords
                    ? ` (Richtwert ${sel.targetWords})`
                    : ''}{' '}
                · Fassung {sel.version}
                {sel.lastAuthor
                  ? ` von ${sel.lastAuthor.replace('agent:', 'KI ').replace('user:', '')}`
                  : ''}
              </p>
            </div>
            <span
              className={`badge ${sel.status === 'written' ? 'written' : sel.status === 'failed' ? 'failed' : 'running'}`}
            >
              {SECTION_STATUS_LABEL[sel.status]}
            </span>
          </div>
          {sel.purpose && (
            <p className="muted small" style={{ marginTop: '.5rem' }}>
              Zweck: {sel.purpose}
            </p>
          )}
          {sel.status === 'failed' && (
            <Notice kind="error">
              {sel.notes || 'Das Kapitel konnte nicht geschrieben werden.'}
            </Notice>
          )}
          {sel.status !== 'failed' && sel.notes && (
            <Notice kind="warn">
              <strong>Hinweise zum Kapitel</strong>
              <br />
              {sel.notes.split('\n').map((n) => (
                <div key={n}>{n}</div>
              ))}
            </Notice>
          )}
          {overLimit && (
            <Notice kind="error">
              Über der Längengrenze des Auftraggebers: {words} von höchstens {sel.maxWords} Wörtern.
            </Notice>
          )}
          {open > 0 && (
            <p className="small">
              <mark className="open-point">
                {open} offene{open === 1 ? 'r Punkt' : ' Punkte'}
              </mark>{' '}
              im Text: Hier fehlen Belege in der Wissensbasis.
            </p>
          )}
        </section>

        <div className="split">
          <div>
            <label htmlFor="sec-text">Text (Markdown)</label>
            <textarea
              id="sec-text"
              className="editor"
              value={content}
              disabled={busy || sel.status === 'failed'}
              onChange={(e) => setDrafts((d) => ({ ...d, [sel.id]: e.target.value }))}
            />
            <div className="row" style={{ marginTop: '.5rem' }}>
              <button
                className="primary"
                disabled={!dirty || save.isPending || busy}
                onClick={() => save.mutate({ id: sel.id, content })}
              >
                {save.isPending ? <Spinner /> : null} Speichern
              </button>
              <button
                disabled={!dirty}
                onClick={() =>
                  setDrafts((d) => {
                    const { [sel.id]: _drop, ...rest } = d;
                    return rest;
                  })
                }
              >
                Verwerfen
              </button>
              <button onClick={() => setShowVersions((v) => !v)}>Versionen</button>
              {dirty && <span className="muted small">Ungespeichert</span>}
            </div>
            <ErrorNotice error={save.error} />
          </div>
          <div>
            <label>Vorschau</label>
            <div className="preview">
              {content.trim() ? (
                <Markdown
                  text={content}
                  factTitles={Object.fromEntries(sel.facts.map((f) => [f.id, f.statement]))}
                  activeFact={activeFact}
                  onFactClick={setActiveFact}
                />
              ) : (
                <p className="muted">Noch kein Text.</p>
              )}
            </div>
          </div>
        </div>

        <section className="card">
          <h2>Mit KI nacharbeiten</h2>
          <label htmlFor="sec-instr">
            Anweisung (z. B. „Kürzer fassen“, „Reaktionszeiten als Tabelle darstellen“)
          </label>
          <textarea
            id="sec-instr"
            rows={2}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={busy}
          />
          <div className="row" style={{ marginTop: '.5rem' }}>
            <button
              disabled={busy || instruction.trim().length < 3 || ai.isPending || dirty}
              onClick={() => ai.mutate({ id: sel.id, kind: 'revise', instruction })}
              title="Überarbeitet den vorhandenen Text nach der Anweisung, ohne neu zu recherchieren"
            >
              Text überarbeiten
            </button>
            <button
              disabled={busy || ai.isPending || dirty}
              onClick={() => ai.mutate({ id: sel.id, kind: 'rewrite', instruction })}
              title="Recherchiert neu und schreibt das Kapitel komplett neu (die Anweisung ist optional)"
            >
              Neu recherchieren und schreiben
            </button>
            {dirty && <span className="muted small">Erst speichern oder verwerfen.</span>}
            {doc.running && (
              <span className="muted small">
                <Spinner /> Ein Vorgang läuft …
              </span>
            )}
          </div>
          <ErrorNotice error={ai.error} />
        </section>

        {showVersions && <Versions section={sel} disabled={busy} onRestored={refresh} />}

        <section className="card">
          <h2>Belege ({sel.facts.length})</h2>
          {sel.facts.length === 0 ? (
            <p className="muted small">
              Für dieses Kapitel liegen keine Fakten vor. Firmenspezifische Aussagen erscheinen dann
              als offene Punkte.
            </p>
          ) : (
            <div className="stack-sm">
              {sel.facts.map((f) => (
                <div
                  key={f.id}
                  className={`fact${activeFact === f.id ? ' hl' : ''}`}
                  onClick={() => setActiveFact(f.id)}
                >
                  <div className="row">
                    <span className="cite">{f.id}</span>
                    <span>{f.statement}</span>
                  </div>
                  <div className="muted small" style={{ marginTop: '.2rem' }}>
                    {f.sourceType === 'kb' ? (
                      <a href={`#/wissen/${f.sourceRef}`}>{f.sourceTitle}</a>
                    ) : (
                      <a href={f.sourceRef} target="_blank" rel="noreferrer noopener">
                        {f.sourceTitle} (Web)
                      </a>
                    )}
                    {f.validUntil ? ` · gültig bis ${f.validUntil}` : ''}
                    {' · '}
                    {f.quoteVerified ? (
                      <span className="badge ok">Zitat in der Quelle geprüft</span>
                    ) : (
                      <span className="badge major">Zitat nicht maschinell geprüft</span>
                    )}
                  </div>
                  {f.quote && (
                    <div className="small muted" style={{ marginTop: '.2rem' }}>
                      „{f.quote}“
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Versions({
  section,
  disabled,
  onRestored,
}: {
  section: SectionDto;
  disabled: boolean;
  onRestored: () => void;
}) {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ['section-versions', section.id, section.version],
    queryFn: () => api.get<SectionVersionDto[]>(`/api/bid-sections/${section.id}/versions`),
  });
  const restore = useMutation({
    mutationFn: (version: number) =>
      api.post(`/api/bid-sections/${section.id}/restore`, { version }),
    onSuccess: () => {
      onRestored();
      void qc.invalidateQueries({ queryKey: ['section-versions', section.id] });
    },
  });
  const who = useMemo(
    () => (a: string) =>
      a
        .replace('agent:writer:', 'Autor · ')
        .replace('agent:lektor', 'Lektor (KI)')
        .replace('user:', 'Bearbeitet von '),
    [],
  );
  return (
    <section className="card">
      <h2>Frühere Fassungen</h2>
      {versions.isLoading ? (
        <Loading />
      ) : !versions.data?.length ? (
        <p className="muted small">Es gibt keine früheren Fassungen.</p>
      ) : (
        <div className="stack-sm">
          {versions.data.map((v) => (
            <details key={v.id} className="fact">
              <summary>
                Fassung {v.version} · {who(v.author)} · {formatDateTime(v.created_at)}
              </summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  maxHeight: '14rem',
                  overflow: 'auto',
                  fontSize: '.85rem',
                }}
              >
                {v.content}
              </pre>
              <button
                className="small"
                disabled={disabled || restore.isPending}
                onClick={() =>
                  window.confirm(`Fassung ${v.version} als neue Fassung übernehmen?`) &&
                  restore.mutate(v.version)
                }
              >
                Wiederherstellen
              </button>
            </details>
          ))}
        </div>
      )}
      <ErrorNotice error={restore.error} />
    </section>
  );
}
