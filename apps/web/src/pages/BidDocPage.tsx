import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AgentEventDto, BidDocumentDetailDto, BidDto } from '@bid/shared';
import { api } from '../api';
import { ErrorNotice, Loading, Notice, PageHead, Spinner } from '../components/ui';
import { navigate } from '../router';
import { ActivityLog } from './bid/ActivityLog';
import { ExportView } from './bid/ExportView';
import { OutlineEditor } from './bid/OutlineEditor';
import { ReviewView } from './bid/ReviewView';
import { SectionsView } from './bid/SectionsView';
import { statusLabel } from './bid/labels';

const TABS = [
  { key: 'vorgabe', label: 'Vorgabe' },
  { key: 'gliederung', label: 'Anforderungen & Gliederung' },
  { key: 'kapitel', label: 'Kapitel' },
  { key: 'pruefung', label: 'Prüfung' },
  { key: 'export', label: 'Export' },
  { key: 'protokoll', label: 'Protokoll' },
] as const;

function defaultTab(status: BidDocumentDetailDto['status']): string {
  if (status === 'draft' || status === 'failed') return 'vorgabe';
  if (status === 'analyzing' || status === 'outline_review') return 'gliederung';
  if (status === 'writing' || status === 'written') return 'kapitel';
  return 'pruefung';
}

function Steps({ doc }: { doc: BidDocumentDetailDto }) {
  const s = doc.status;
  const allWritten = doc.sections.length > 0 && doc.sections.every((x) => x.status === 'written');
  const steps = [
    { label: 'Vorgabe', done: s !== 'draft', current: s === 'draft' || s === 'failed' },
    {
      label: 'Gliederung freigeben',
      done: Boolean(doc.outlineApprovedAt),
      current: s === 'analyzing' || s === 'outline_review',
    },
    {
      label: 'Entwurf',
      done: allWritten && !['writing', 'outline_review', 'analyzing', 'draft'].includes(s),
      current: s === 'writing' || s === 'written',
    },
    { label: 'Prüfung', done: s === 'reviewed', current: s === 'reviewing' },
    { label: 'Export', done: false, current: s === 'reviewed' },
  ];
  return (
    <ol className="steps" style={{ listStyle: 'none', padding: 0 }} aria-label="Fortschritt">
      {steps.map((st, i) => (
        <li
          key={st.label}
          className={`step${st.done ? ' done' : ''}${st.current ? ' current' : ''}`}
          aria-current={st.current ? 'step' : undefined}
        >
          <span className="n">{st.done ? '✓' : i + 1}</span>
          {st.label}
        </li>
      ))}
    </ol>
  );
}

export function BidDocPage({ id, tab }: { id: string; tab?: string | undefined }) {
  const qc = useQueryClient();
  const doc = useQuery({
    queryKey: ['bid-doc', id],
    queryFn: () => api.get<BidDocumentDetailDto>(`/api/bid-documents/${id}`),
    // Solange Agenten arbeiten, den Stand regelmäßig abfragen.
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  const running = doc.data?.running ?? false;
  const events = useQuery({
    queryKey: ['bid-events', id],
    queryFn: () => api.get<AgentEventDto[]>(`/api/bid-documents/${id}/events`),
    refetchInterval: running ? 1500 : false,
  });
  const bid = useQuery({
    queryKey: ['bid', doc.data?.bidId],
    queryFn: () => api.get<{ bid: BidDto }>(`/api/bids/${doc.data!.bidId}`),
    enabled: Boolean(doc.data?.bidId),
  });
  const [section, setSection] = useState<string>();

  // Wenn ein Lauf endet, noch einmal Stand und Protokoll holen: das letzte Ereignis kam womöglich nach der letzten Abfrage.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: ['bid-doc', id] });
      void qc.invalidateQueries({ queryKey: ['bid-events', id] });
    }
    wasRunning.current = running;
  }, [running, id, qc]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bid-doc', id] });
    void qc.invalidateQueries({ queryKey: ['bid-events', id] });
  };
  const analyze = useMutation({
    mutationFn: () => api.post(`/api/bid-documents/${id}/analyze`),
    onSuccess: () => {
      refresh();
      navigate(`/doc/${id}/gliederung`);
    },
  });
  const polish = useMutation({
    mutationFn: () => api.post(`/api/bid-documents/${id}/polish`),
    onSuccess: refresh,
  });
  const toggleWeb = useMutation({
    mutationFn: (allowWeb: boolean) => api.patch(`/api/bid-documents/${id}`, { allowWeb }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/bid-documents/${id}`),
    onSuccess: () => navigate(`/bids/${doc.data!.bidId}`),
  });

  if (doc.isLoading) return <Loading what="Dokument laden" />;
  const d = doc.data;
  if (!d)
    return (
      <>
        <a href="#/bids">← Zurück</a>
        <ErrorNotice error={doc.error} />
      </>
    );

  const active = TABS.some((t) => t.key === tab) ? tab! : defaultTab(d.status);
  const go = (key: string) => navigate(`/doc/${id}/${key}`);
  const evs = events.data ?? [];
  const idle = !running && !['analyzing', 'writing', 'reviewing'].includes(d.status);
  const canAnalyze = idle && ['draft', 'failed', 'outline_review'].includes(d.status);
  const tokens = d.usage.inputTokens + d.usage.outputTokens;

  return (
    <>
      <p>
        <a href={`#/bids/${d.bidId}`}>← {bid.data?.bid.name ?? 'Ausschreibung'}</a>
      </p>
      <PageHead
        title={d.title}
        sub={
          bid.data
            ? `${bid.data.bid.customer}${tokens ? ` · ${tokens.toLocaleString('de-DE')} Token verbraucht` : ''}`
            : undefined
        }
      >
        <span
          className={`badge ${d.status === 'failed' ? 'failed' : d.status === 'reviewed' ? 'ok' : running ? 'running' : ''}`}
        >
          {running && <Spinner />} {statusLabel(d.status)}
        </span>
      </PageHead>
      <Steps doc={d} />
      {d.error && (
        <Notice kind="error">
          <strong>Hinweis:</strong> {d.error}
        </Notice>
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={active === t.key} onClick={() => go(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {active === 'vorgabe' && (
        <div className="stack">
          <section className="card">
            <h2>Analyse der Kundenvorgabe</h2>
            <p className="muted small">
              Der Anforderungsanalyst zerlegt die Vorgabe in Anforderungen, Formvorgaben,
              Bewertungskriterien und einen Gliederungsvorschlag. Danach prüfst und bearbeitest du
              alles, bevor die Autoren schreiben.
            </p>
            <label className="check" style={{ marginBottom: '.75rem' }}>
              <input
                type="checkbox"
                checked={d.options.allowWeb}
                disabled={!idle || toggleWeb.isPending}
                onChange={(e) => toggleWeb.mutate(e.target.checked)}
              />{' '}
              Websuche für die Recherche erlauben
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={!canAnalyze || analyze.isPending}
                onClick={() =>
                  d.status === 'outline_review' &&
                  !window.confirm(
                    'Die Gliederung wird neu erstellt; deine Änderungen daran gehen verloren. Fortfahren?',
                  )
                    ? undefined
                    : analyze.mutate()
                }
              >
                {analyze.isPending || d.status === 'analyzing' ? <Spinner /> : null}{' '}
                {d.status === 'outline_review'
                  ? 'Neu analysieren'
                  : d.status === 'failed'
                    ? 'Analyse wiederholen'
                    : 'Analyse starten'}
              </button>
              <button
                className="danger"
                disabled={!idle}
                onClick={() => window.confirm(`„${d.title}" löschen?`) && remove.mutate()}
              >
                Dokument löschen
              </button>
            </div>
            <ErrorNotice error={analyze.error ?? remove.error ?? toggleWeb.error} />
          </section>
          <section className="card">
            <h2>Text der Vorgabe</h2>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                maxHeight: '30rem',
                overflow: 'auto',
                fontSize: '.85rem',
              }}
            >
              {d.specText}
            </pre>
          </section>
        </div>
      )}
      {active === 'gliederung' && <OutlineEditor doc={d} />}
      {active === 'kapitel' && (
        <>
          {['written', 'reviewed'].includes(d.status) && !running && (
            <div className="row" style={{ marginBottom: '1rem' }}>
              <button
                onClick={() => polish.mutate()}
                disabled={polish.isPending}
                title="Glättet Stil und Begriffe in allen Kapiteln; Zahlen und Quellenmarken bleiben unverändert"
              >
                Lektorat über alle Kapitel
              </button>
              <ErrorNotice error={polish.error} />
            </div>
          )}
          <SectionsView doc={d} selectedId={section} onSelect={setSection} />
        </>
      )}
      {active === 'pruefung' && (
        <ReviewView
          doc={d}
          onOpenSection={(sid) => {
            setSection(sid);
            go('kapitel');
          }}
        />
      )}
      {active === 'export' && <ExportView doc={d} />}
      {active === 'protokoll' && (
        <section className="card">
          <h2>Protokoll der Agenten</h2>
          <ActivityLog events={evs} sections={d.sections} />
        </section>
      )}

      {active !== 'protokoll' && (running || evs.length > 0) && (
        <section className="card" style={{ marginTop: '1rem' }} aria-label="Aktivität">
          <div className="row between">
            <h3 style={{ margin: 0 }}>
              {running ? (
                <>
                  <Spinner /> Agenten arbeiten …
                </>
              ) : (
                'Letzte Aktivität'
              )}
            </h3>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                go('protokoll');
              }}
            >
              Gesamtes Protokoll
            </a>
          </div>
          <ActivityLog events={evs} sections={d.sections} limit={8} />
        </section>
      )}
    </>
  );
}
