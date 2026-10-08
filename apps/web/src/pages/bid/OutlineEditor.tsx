import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  AUTHOR_ROLES,
  type BidDocumentDetailDto,
  type OutlineSection,
  type Requirement,
  type SpecAnalysis,
} from '@bid/shared';
import { api, ApiError } from '../../api';
import { ErrorNotice, Notice, Spinner, formatDateTime } from '../../components/ui';
import { KIND_LABEL, roleLabel } from './labels';

const lines = (t: string): string[] =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Hierarchische Nummern (1, 1.1, 1.2, 2 …) aus den Ebenen der Kapitel. */
export function renumber(outline: OutlineSection[]): OutlineSection[] {
  const counters: number[] = [];
  return outline.map((s) => {
    const level = Math.min(Math.max(s.level, 1), 3);
    counters.length = level;
    for (let i = 0; i < level; i++) {
      const current = counters[i] ?? 0;
      // Die eigene Ebene zählt hoch; fehlende übergeordnete Ebenen beginnen bei 1.
      counters[i] = i === level - 1 ? current + 1 : Math.max(current, 1);
    }
    return { ...s, number: counters.join('.') };
  });
}

export function unassignedMust(a: SpecAnalysis): Requirement[] {
  const assigned = new Set(a.outline.flatMap((s) => s.requirementIds));
  return a.requirements.filter((r) => r.kind === 'must' && !assigned.has(r.id));
}

export function OutlineEditor({ doc }: { doc: BidDocumentDetailDto }) {
  const qc = useQueryClient();
  const editable = doc.status === 'outline_review' && !doc.running;
  const [draft, setDraft] = useState<SpecAnalysis | null>(doc.analysis);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(doc.analysis);
  }, [doc.analysis, dirty]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bid-doc', doc.id] });
    void qc.invalidateQueries({ queryKey: ['bid-events', doc.id] });
  };
  const save = useMutation({
    mutationFn: (a: SpecAnalysis) => api.put(`/api/bid-documents/${doc.id}/analysis`, a),
    onSuccess: () => {
      setDirty(false);
      refresh();
    },
  });
  const approve = useMutation({
    mutationFn: async (force: boolean) => {
      if (dirty && draft) await api.put(`/api/bid-documents/${doc.id}/analysis`, draft);
      return api.post(`/api/bid-documents/${doc.id}/approve-outline`, { force });
    },
    onSuccess: () => {
      setDirty(false);
      refresh();
    },
  });

  if (!draft)
    return (
      <Notice>Noch keine Analyse vorhanden. Starte zuerst die Analyse der Kundenvorgabe.</Notice>
    );
  const a = draft;
  const missing = unassignedMust(a);

  const update = (fn: (d: SpecAnalysis) => SpecAnalysis) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
    save.reset();
  };
  const setReq = (id: string, patch: Partial<Requirement>) =>
    update((d) => ({
      ...d,
      requirements: d.requirements.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  const setSec = (id: string, patch: Partial<OutlineSection>) =>
    update((d) => ({
      ...d,
      outline: d.outline.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  const move = (i: number, dir: -1 | 1) =>
    update((d) => {
      const o = [...d.outline];
      const j = i + dir;
      if (j < 0 || j >= o.length) return d;
      [o[i], o[j]] = [o[j]!, o[i]!];
      return { ...d, outline: renumber(o) };
    });

  const onApprove = () => {
    if (missing.length) {
      const ok = window.confirm(
        `${missing.length} Muss-Anforderung(en) sind keinem Kapitel zugeordnet (${missing.map((m) => m.id).join(', ')}). Sie würden im Dokument nicht beantwortet.\n\nTrotzdem freigeben und schreiben lassen?`,
      );
      if (!ok) return;
      approve.mutate(true);
    } else approve.mutate(false);
  };

  return (
    <div className="stack">
      {doc.outlineApprovedAt ? (
        <Notice kind="ok">
          Gliederung freigegeben am {formatDateTime(doc.outlineApprovedAt)}. Änderungen an
          Anforderungen und Gliederung sind jetzt gesperrt; Texte lassen sich im Reiter „Kapitel“
          bearbeiten.
        </Notice>
      ) : editable ? (
        <Notice kind="warn">
          <strong>Zur Freigabe.</strong> Prüfe Anforderungen und Gliederung. Erst nach deiner
          Freigabe schreiben die Autoren.
        </Notice>
      ) : doc.running ? (
        <Notice>
          <Spinner /> Die Analyse läuft …
        </Notice>
      ) : null}

      <section className="card">
        <h2>Zusammenfassung des Analysten</h2>
        <p>{a.summary}</p>
        <div className="grid-3">
          <div>
            <label htmlFor="o-rules">Formvorgaben (je Zeile eine)</label>
            <textarea
              id="o-rules"
              rows={4}
              disabled={!editable}
              value={a.formalRules.join('\n')}
              onChange={(e) => update((d) => ({ ...d, formalRules: lines(e.target.value) }))}
            />
          </div>
          <div>
            <label htmlFor="o-crit">Bewertungskriterien</label>
            <textarea
              id="o-crit"
              rows={4}
              disabled={!editable}
              value={a.evaluationCriteria.join('\n')}
              onChange={(e) => update((d) => ({ ...d, evaluationCriteria: lines(e.target.value) }))}
            />
          </div>
          <div>
            <label htmlFor="o-terms">Begriffe des Auftraggebers (Begriff | Hinweis)</label>
            <textarea
              id="o-terms"
              rows={4}
              disabled={!editable}
              value={a.customerTerms.map((t) => `${t.term} | ${t.note}`).join('\n')}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  customerTerms: lines(e.target.value).map((l) => {
                    const [term = '', ...rest] = l.split('|');
                    return { term: term.trim(), note: rest.join('|').trim() };
                  }),
                }))
              }
            />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Anforderungen ({a.requirements.length})</h2>
          {editable && (
            <button
              className="small"
              onClick={() =>
                update((d) => ({
                  ...d,
                  requirements: [
                    ...d.requirements,
                    {
                      id: `R-${String(Math.max(0, ...d.requirements.map((r) => Number(r.id.slice(2)) || 0)) + 1).padStart(3, '0')}`,
                      text: '',
                      kind: 'should',
                      topic: '',
                    },
                  ],
                }))
              }
            >
              + Anforderung
            </button>
          )}
        </div>
        {missing.length > 0 && (
          <Notice kind="warn">
            Keinem Kapitel zugeordnete Muss-Anforderungen:{' '}
            <strong>{missing.map((m) => m.id).join(', ')}</strong>
          </Notice>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Art</th>
                <th style={{ minWidth: '18rem' }}>Anforderung</th>
                <th>Zitat aus der Vorgabe</th>
                <th>Kapitel</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {a.requirements.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>
                    <select
                      disabled={!editable}
                      value={r.kind}
                      onChange={(e) =>
                        setReq(r.id, { kind: e.target.value as Requirement['kind'] })
                      }
                      aria-label={`Art von ${r.id}`}
                    >
                      {(['must', 'should', 'info'] as const).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <textarea
                      className="req-input"
                      rows={2}
                      disabled={!editable}
                      value={r.text}
                      onChange={(e) => setReq(r.id, { text: e.target.value })}
                      aria-label={`Text von ${r.id}`}
                    />
                  </td>
                  <td className="small">
                    {r.sourceQuote ? (
                      <>
                        „{r.sourceQuote}“{' '}
                        {r.quoteVerified === false ? (
                          <span
                            className="badge major"
                            title="Das Zitat steht nicht wörtlich in der Vorgabe"
                          >
                            nicht wiedergefunden
                          </span>
                        ) : r.quoteVerified ? (
                          <span className="badge ok">belegt</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td>
                    {a.outline
                      .filter((s) => s.requirementIds.includes(r.id))
                      .map((s) => (
                        <span className="tag" key={s.id}>
                          {s.number}
                        </span>
                      ))}
                  </td>
                  <td>
                    {editable && (
                      <button
                        className="ghost small danger"
                        aria-label={`${r.id} entfernen`}
                        onClick={() =>
                          update((d) => ({
                            ...d,
                            requirements: d.requirements.filter((x) => x.id !== r.id),
                            outline: d.outline.map((s) => ({
                              ...s,
                              requirementIds: s.requirementIds.filter((x) => x !== r.id),
                            })),
                          }))
                        }
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Gliederung ({a.outline.length} Kapitel)</h2>
          {editable && (
            <div className="row">
              <button
                className="small"
                onClick={() => update((d) => ({ ...d, outline: renumber(d.outline) }))}
              >
                Nummern neu vergeben
              </button>
              <button
                className="small"
                onClick={() =>
                  update((d) => ({
                    ...d,
                    outline: renumber([
                      ...d.outline,
                      {
                        id: `S-${Date.now().toString(36)}`,
                        number: '',
                        title: 'Neues Kapitel',
                        level: 1,
                        purpose: '',
                        requirementIds: [],
                        authorRole: 'solution_architect',
                      },
                    ]),
                  }))
                }
              >
                + Kapitel
              </button>
            </div>
          )}
        </div>
        <div className="stack-sm" style={{ marginTop: '.75rem' }}>
          {a.outline.map((s, i) => (
            <div
              className="card"
              key={s.id}
              style={{
                boxShadow: 'none',
                marginTop: '.5rem',
                paddingLeft: `${0.9 + (s.level - 1) * 1.2}rem`,
              }}
            >
              <div className="row">
                <input
                  style={{ width: '4.5rem' }}
                  disabled={!editable}
                  value={s.number}
                  onChange={(e) => setSec(s.id, { number: e.target.value })}
                  aria-label="Nummer"
                />
                <input
                  className="grow"
                  disabled={!editable}
                  value={s.title}
                  onChange={(e) => setSec(s.id, { title: e.target.value })}
                  aria-label="Kapitelüberschrift"
                />
                <select
                  style={{ width: 'auto' }}
                  disabled={!editable}
                  value={s.level}
                  onChange={(e) =>
                    update((d) => ({
                      ...d,
                      outline: renumber(
                        d.outline.map((x) =>
                          x.id === s.id ? { ...x, level: Number(e.target.value) } : x,
                        ),
                      ),
                    }))
                  }
                  aria-label="Ebene"
                >
                  {[1, 2, 3].map((l) => (
                    <option key={l} value={l}>
                      Ebene {l}
                    </option>
                  ))}
                </select>
                <select
                  style={{ width: 'auto' }}
                  disabled={!editable}
                  value={s.authorRole}
                  onChange={(e) =>
                    setSec(s.id, { authorRole: e.target.value as OutlineSection['authorRole'] })
                  }
                  aria-label="Autor"
                >
                  {AUTHOR_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
                {editable && (
                  <>
                    <button
                      className="ghost small"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label="nach oben"
                    >
                      ↑
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => move(i, 1)}
                      disabled={i === a.outline.length - 1}
                      aria-label="nach unten"
                    >
                      ↓
                    </button>
                    <button
                      className="ghost small danger"
                      aria-label="Kapitel entfernen"
                      onClick={() =>
                        update((d) => ({
                          ...d,
                          outline: renumber(d.outline.filter((x) => x.id !== s.id)),
                        }))
                      }
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
              <div className="grid-3" style={{ marginTop: '.5rem' }}>
                <div style={{ gridColumn: 'span 2' }}>
                  <label>Zweck</label>
                  <textarea
                    rows={2}
                    disabled={!editable}
                    value={s.purpose}
                    onChange={(e) => setSec(s.id, { purpose: e.target.value })}
                  />
                </div>
                <div className="row">
                  <div style={{ flex: 1 }}>
                    <label>Richtwert (Wörter)</label>
                    <input
                      type="number"
                      min={0}
                      disabled={!editable}
                      value={s.targetWords ?? ''}
                      onChange={(e) =>
                        setSec(s.id, {
                          targetWords: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Höchstens</label>
                    <input
                      type="number"
                      min={0}
                      disabled={!editable}
                      value={s.maxWords ?? ''}
                      onChange={(e) =>
                        setSec(s.id, {
                          maxWords: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                </div>
              </div>
              <details style={{ marginTop: '.4rem' }}>
                <summary className="small">
                  {s.requirementIds.length} zugeordnete Anforderung(en):{' '}
                  {s.requirementIds.join(', ') || 'keine'}
                </summary>
                <div
                  className="stack-sm"
                  style={{ maxHeight: '12rem', overflowY: 'auto', marginTop: '.4rem' }}
                >
                  {a.requirements.map((r) => (
                    <label className="check" key={r.id}>
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={s.requirementIds.includes(r.id)}
                        onChange={(e) =>
                          setSec(s.id, {
                            requirementIds: e.target.checked
                              ? [...s.requirementIds, r.id]
                              : s.requirementIds.filter((x) => x !== r.id),
                          })
                        }
                      />
                      <span>
                        <span className="mono">{r.id}</span>{' '}
                        <span className={`badge ${r.kind === 'must' ? 'major' : ''}`}>
                          {KIND_LABEL[r.kind]}
                        </span>{' '}
                        {r.text.slice(0, 110)}
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            </div>
          ))}
        </div>
      </section>

      {editable && (
        <div className="card">
          <div className="row">
            <button onClick={() => save.mutate(a)} disabled={!dirty || save.isPending}>
              {save.isPending ? <Spinner /> : null} Änderungen speichern
            </button>
            <button
              className="primary"
              onClick={onApprove}
              disabled={approve.isPending || a.outline.length === 0}
            >
              {approve.isPending ? <Spinner /> : null} Gliederung freigeben und schreiben lassen
            </button>
            {dirty && (
              <span className="muted small">
                Ungespeicherte Änderungen werden bei der Freigabe mitgespeichert.
              </span>
            )}
          </div>
          <ErrorNotice error={save.error ?? approve.error} />
          {approve.error instanceof ApiError && approve.error.status === 409 && (
            <p className="muted small">
              Hinweis: Ein anderer Vorgang läuft oder der Stand hat sich geändert. Seite neu laden.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
