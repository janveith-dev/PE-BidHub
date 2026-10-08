import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type DocumentSummary,
} from '@bid/shared';
import { api } from '../api';
import {
  ErrorNotice,
  Loading,
  Notice,
  PageHead,
  ValidityBadge,
  categoryLabel,
  downloadFile,
  formatDate,
  formatDateTime,
  formatSize,
} from '../components/ui';
import { canEditKnowledge, useRole } from '../role';
import { navigate } from '../router';

export function DocumentPage({ id }: { id: string }) {
  const role = useRole();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['document', id],
    queryFn: () =>
      api.get<{ document: DocumentSummary; versions: DocumentSummary[] }>(`/api/documents/${id}`),
  });
  const [showText, setShowText] = useState(false);
  const text = useQuery({
    queryKey: ['document-text', id],
    queryFn: () => api.get<{ text: string }>(`/api/documents/${id}/text`),
    enabled: showText,
  });

  const doc = detail.data?.document;
  const [form, setForm] = useState({
    title: '',
    category: 'product' as DocumentCategory,
    vendor: '',
    tags: '',
    validFrom: '',
    validUntil: '',
  });
  useEffect(() => {
    if (doc)
      setForm({
        title: doc.title,
        category: doc.category,
        vendor: doc.vendor ?? '',
        tags: doc.tags.join(', '),
        validFrom: doc.validFrom ?? '',
        validUntil: doc.validUntil ?? '',
      });
  }, [doc]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<DocumentSummary>(`/api/documents/${id}`, {
        title: form.title,
        category: form.category,
        vendor: form.vendor.trim() || null,
        tags: form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        validFrom: form.validFrom || null,
        validUntil: form.validUntil || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['document', id] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/documents/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      navigate('/wissen');
    },
  });
  const download = useMutation({
    mutationFn: () => downloadFile(`/api/documents/${id}/file`, doc?.filename ?? 'dokument', role),
  });

  if (detail.isLoading) return <Loading what="Dokument laden" />;
  if (detail.error || !doc)
    return (
      <>
        <a href="#/wissen">← Zurück</a>
        <ErrorNotice error={detail.error} />
      </>
    );
  const editable = canEditKnowledge(role);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <p>
        <a href="#/wissen">← Wissensbasis</a>
      </p>
      <PageHead
        title={doc.title}
        sub={`${categoryLabel(doc.category)}${doc.vendor ? ` · ${doc.vendor}` : ''} · ${doc.filename}`}
      >
        <ValidityBadge validity={doc.validity} until={doc.validUntil} />
        <button onClick={() => download.mutate()}>Original herunterladen</button>
      </PageHead>
      {!doc.isCurrent && (
        <Notice kind="warn">
          Das ist eine ältere Version. In Suche, Chat und Bid-Studio wird nur die aktuelle Fassung
          verwendet.
        </Notice>
      )}
      <ErrorNotice error={download.error} />

      <div className="grid-2">
        <section className="card">
          <h2>Angaben</h2>
          <dl className="kv">
            <dt>Version</dt>
            <dd>
              v{doc.version}
              {doc.isCurrent ? ' (aktuell)' : ''}
            </dd>
            <dt>Gültig</dt>
            <dd>
              {formatDate(doc.validFrom)} bis{' '}
              {doc.validUntil ? formatDate(doc.validUntil) : 'unbefristet'}
            </dd>
            <dt>Größe</dt>
            <dd>
              {formatSize(doc.sizeBytes)} · {doc.chunkCount} Abschnitte
            </dd>
            <dt>Gelesen per</dt>
            <dd>
              {doc.extractionMethod === 'ocr'
                ? 'Texterkennung (eingescannt)'
                : doc.extractionMethod === 'text'
                  ? 'Klartext'
                  : 'Dateiinhalt'}
            </dd>
            <dt>Sprache</dt>
            <dd>
              {doc.language === 'de' ? 'Deutsch' : doc.language === 'en' ? 'Englisch' : 'unbekannt'}
            </dd>
            <dt>Hochgeladen</dt>
            <dd>
              {formatDateTime(doc.createdAt)}
              {doc.uploadedByRole ? ` (${doc.uploadedByRole})` : ''}
            </dd>
            <dt>Schlagworte</dt>
            <dd>{doc.tags.length ? doc.tags.join(', ') : '–'}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Versionen</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Datei</th>
                  <th>Gültig bis</th>
                  <th>Hochgeladen</th>
                </tr>
              </thead>
              <tbody>
                {detail.data!.versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {v.id === doc.id ? (
                        <strong>v{v.version}</strong>
                      ) : (
                        <a href={`#/wissen/${v.id}`}>v{v.version}</a>
                      )}
                      {v.isCurrent ? ' · aktuell' : ''}
                    </td>
                    <td>{v.filename}</td>
                    <td>{formatDate(v.validUntil)}</td>
                    <td>{formatDate(v.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {editable && (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h2>Bearbeiten</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid-3">
              <div>
                <label htmlFor="e-title">Titel</label>
                <input id="e-title" value={form.title} onChange={set('title')} />
              </div>
              <div>
                <label htmlFor="e-cat">Kategorie</label>
                <select id="e-cat" value={form.category} onChange={set('category')}>
                  {DOCUMENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="e-vendor">Hersteller</label>
                <input id="e-vendor" value={form.vendor} onChange={set('vendor')} />
              </div>
              <div>
                <label htmlFor="e-from">Gültig ab</label>
                <input id="e-from" type="date" value={form.validFrom} onChange={set('validFrom')} />
              </div>
              <div>
                <label htmlFor="e-until">Gültig bis</label>
                <input
                  id="e-until"
                  type="date"
                  value={form.validUntil}
                  onChange={set('validUntil')}
                />
              </div>
              <div>
                <label htmlFor="e-tags">Schlagworte</label>
                <input id="e-tags" value={form.tags} onChange={set('tags')} />
              </div>
            </div>
            <div className="row" style={{ marginTop: '.9rem' }}>
              <button className="primary" disabled={save.isPending}>
                Speichern
              </button>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  window.confirm(`„${doc.title}" (v${doc.version}) wirklich löschen?`) &&
                  remove.mutate()
                }
              >
                Diese Version löschen
              </button>
              {save.isSuccess && <span className="muted small">Gespeichert.</span>}
            </div>
            <ErrorNotice error={save.error ?? remove.error} />
          </form>
        </section>
      )}

      <section className="card" style={{ marginTop: '1rem' }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Gelesener Text</h2>
          <button onClick={() => setShowText((s) => !s)}>
            {showText ? 'Ausblenden' : 'Anzeigen'}
          </button>
        </div>
        {showText &&
          (text.isLoading ? (
            <Loading />
          ) : (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                maxHeight: '28rem',
                overflow: 'auto',
                fontSize: '.85rem',
              }}
            >
              {text.data?.text}
            </pre>
          ))}
      </section>
    </>
  );
}
