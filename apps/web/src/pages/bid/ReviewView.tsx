import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BidDocumentDetailDto } from '@bid/shared';
import { api } from '../../api';
import { ErrorNotice, Notice, Spinner } from '../../components/ui';
import { COVERAGE_LABEL, FINDING_KIND_LABEL, KIND_LABEL, SEVERITY_LABEL } from './labels';

export function ReviewView({
  doc,
  onOpenSection,
}: {
  doc: BidDocumentDetailDto;
  onOpenSection: (sectionId: string) => void;
}) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bid-doc', doc.id] });
    void qc.invalidateQueries({ queryKey: ['bid-events', doc.id] });
  };
  const ready = ['written', 'reviewed'].includes(doc.status) && !doc.running;
  const review = useMutation({
    mutationFn: (force: boolean) => api.post(`/api/bid-documents/${doc.id}/review`, { force }),
    onSuccess: refresh,
  });
  const fix = useMutation({
    mutationFn: (v: { sectionId: string; message: string }) =>
      api.post(`/api/bid-sections/${v.sectionId}/revise`, {
        instruction: `Behebe diesen Prüfbefund, ohne Zahlen oder Quellenmarken zu verfälschen: ${v.message}`,
      }),
    onSuccess: refresh,
  });

  const incomplete = doc.sections.filter((s) => s.status !== 'written');
  const startReview = () => {
    if (incomplete.length) {
      if (
        !window.confirm(
          `Kapitel ${incomplete.map((s) => s.number).join(', ')} sind noch nicht fertig. Trotzdem prüfen?`,
        )
      )
        return;
      review.mutate(true);
    } else review.mutate(false);
  };

  const sectionByOutline = (id?: string) => doc.sections.find((s) => s.outlineId === id);
  const reqs = new Map((doc.analysis?.requirements ?? []).map((r) => [r.id, r]));
  const cov = doc.coverage ?? [];
  const count = (st: string) => cov.filter((c) => c.status === st).length;

  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <div>
            <h2 style={{ margin: 0 }}>Unabhängige Prüfung</h2>
            <p className="muted small" style={{ margin: 0 }}>
              Ein eigener Agent liest den fertigen Text ohne Kenntnis der Recherche und prüft ihn
              gegen die Vorgabe. Dazu kommen maschinelle Kontrollen: Länge, Quellenmarken, offene
              Punkte und die Gültigkeit der Quellen.
            </p>
          </div>
          <button className="primary" disabled={!ready || review.isPending} onClick={startReview}>
            {review.isPending || doc.status === 'reviewing' ? <Spinner /> : null}{' '}
            {doc.coverage ? 'Prüfung wiederholen' : 'Prüfung starten'}
          </button>
        </div>
        <ErrorNotice error={review.error ?? fix.error} />
      </section>

      {doc.coverage && doc.status === 'written' && (
        <Notice kind="warn">
          Seit der letzten Prüfung wurde der Text geändert. Die Ergebnisse unten gelten für den
          früheren Stand.
        </Notice>
      )}
      {!doc.coverage && <Notice>Noch nicht geprüft.</Notice>}

      {doc.coverage && (
        <>
          <section className="card">
            <h2>Ergebnis</h2>
            <div className="row" style={{ marginBottom: '.6rem' }}>
              <span className="badge covered">{count('covered')} erfüllt</span>
              <span className="badge partial">{count('partial')} teilweise</span>
              <span className="badge missing">{count('missing')} fehlen</span>
              <span className="muted small">von {cov.length} Anforderungen</span>
            </div>
            {doc.reviewSummary && <p>{doc.reviewSummary}</p>}
          </section>

          <section className="card">
            <h2>Befunde ({doc.findings?.length ?? 0})</h2>
            {!doc.findings?.length ? (
              <p className="muted">Keine Befunde.</p>
            ) : (
              <div className="stack-sm">
                {doc.findings.map((f) => {
                  const s = sectionByOutline(f.sectionId);
                  return (
                    <div key={f.id} className="fact">
                      <div className="row">
                        <span className={`badge ${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                        <span className="badge">{FINDING_KIND_LABEL[f.kind]}</span>
                        {s && (
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenSection(s.id);
                            }}
                          >
                            Kapitel {s.number}
                          </a>
                        )}
                        {f.requirementId && <span className="mono muted">{f.requirementId}</span>}
                      </div>
                      <p style={{ margin: '.35rem 0 0' }}>{f.message}</p>
                      {s && f.kind !== 'stale_source' && f.kind !== 'length' && (
                        <div style={{ marginTop: '.4rem' }}>
                          <button
                            className="small"
                            disabled={!ready || fix.isPending}
                            onClick={() => fix.mutate({ sectionId: s.id, message: f.message })}
                            title="Der Lektor überarbeitet das Kapitel gezielt zu diesem Befund; danach die Prüfung wiederholen"
                          >
                            Gezielt beheben lassen
                          </button>
                        </div>
                      )}
                      {s && f.kind === 'length' && (
                        <p className="muted small" style={{ margin: '.3rem 0 0' }}>
                          Im Kapitel mit „Text überarbeiten“ und der Anweisung „Kürzer fassen“
                          beheben.
                        </p>
                      )}
                      {f.kind === 'stale_source' && (
                        <p className="muted small" style={{ margin: '.3rem 0 0' }}>
                          Aktualisierte Unterlage in der Wissensbasis hochladen, dann das Kapitel
                          neu schreiben lassen.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card">
            <h2>Anforderungsmatrix</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Art</th>
                    <th style={{ minWidth: '16rem' }}>Anforderung</th>
                    <th>Bewertung</th>
                    <th>Kapitel</th>
                    <th style={{ minWidth: '14rem' }}>Begründung</th>
                  </tr>
                </thead>
                <tbody>
                  {cov.map((c) => {
                    const r = reqs.get(c.requirementId);
                    return (
                      <tr key={c.requirementId}>
                        <td className="mono">{c.requirementId}</td>
                        <td>
                          {r ? (
                            <span className={`badge ${r.kind === 'must' ? 'major' : ''}`}>
                              {KIND_LABEL[r.kind]}
                            </span>
                          ) : (
                            '–'
                          )}
                        </td>
                        <td>{r?.text ?? '–'}</td>
                        <td>
                          <span className={`badge ${c.status}`}>{COVERAGE_LABEL[c.status]}</span>
                        </td>
                        <td>
                          {c.sectionIds.map((id) => {
                            const s = sectionByOutline(id);
                            return s ? (
                              <a
                                key={id}
                                className="tag"
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  onOpenSection(s.id);
                                }}
                              >
                                {s.number}
                              </a>
                            ) : null;
                          })}
                        </td>
                        <td className="small">{c.comment}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
