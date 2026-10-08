import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  CATEGORY_LABELS,
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type DocumentSummary,
  type SearchHit,
} from '@bid/shared';
import { api } from '../api';
import {
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHead,
  Spinner,
  ValidityBadge,
  categoryLabel,
  formatDate,
  formatSize,
} from '../components/ui';
import { canEditKnowledge, useRole } from '../role';

interface UploadResult {
  document: DocumentSummary;
  duplicate: boolean;
  warnings: string[];
}

export function KnowledgePage() {
  const role = useRole();
  const [category, setCategory] = useState<DocumentCategory | ''>('');
  const [validity, setValidity] = useState('');
  const [filter, setFilter] = useState('');
  const [includeOld, setIncludeOld] = useState(false);

  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (validity) params.set('validity', validity);
  if (filter.trim()) params.set('q', filter.trim());
  if (includeOld) params.set('includeOld', 'true');
  const docs = useQuery({
    queryKey: ['documents', params.toString()],
    queryFn: () => api.get<DocumentSummary[]>(`/api/documents?${params}`),
  });

  return (
    <>
      <PageHead
        title="Wissensbasis"
        sub="Produkte, Konzeptbausteine, Konfigurationen, Preislisten, Zertifikate und Referenzen für Ausschreibungen."
      />
      <SearchCard />
      {canEditKnowledge(role) ? (
        <UploadCard existing={docs.data ?? []} />
      ) : (
        <Notice>
          Hochladen und Pflegen von Unterlagen ist Presales vorbehalten. Wechsle oben die Rolle, um
          Dokumente zu ergänzen.
        </Notice>
      )}

      <section className="card" style={{ marginTop: '1rem' }} aria-labelledby="doclist">
        <div className="row between" style={{ marginBottom: '.75rem' }}>
          <h2 id="doclist" style={{ margin: 0 }}>
            Dokumente {docs.data && <span className="muted">({docs.data.length})</span>}
          </h2>
          <label className="check">
            <input
              type="checkbox"
              checked={includeOld}
              onChange={(e) => setIncludeOld(e.target.checked)}
            />{' '}
            alte Versionen anzeigen
          </label>
        </div>
        <div className="row" style={{ marginBottom: '.75rem' }}>
          <div className="chips" role="group" aria-label="Kategorie">
            <button className="chip" aria-pressed={category === ''} onClick={() => setCategory('')}>
              Alle
            </button>
            {DOCUMENT_CATEGORIES.map((c) => (
              <button
                key={c}
                className="chip"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <select
            style={{ width: 'auto' }}
            value={validity}
            onChange={(e) => setValidity(e.target.value)}
            aria-label="Gültigkeit"
          >
            <option value="">Alle Gültigkeiten</option>
            <option value="valid">gültig</option>
            <option value="expiring">läuft bald ab</option>
            <option value="expired">abgelaufen</option>
          </select>
          <input
            style={{ width: '14rem' }}
            placeholder="Titel, Hersteller, Tag …"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Dokumente filtern"
          />
        </div>
        <ErrorNotice error={docs.error} />
        {docs.isLoading ? (
          <Loading what="Dokumente laden" />
        ) : !docs.data?.length ? (
          <Empty>Keine Dokumente gefunden.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Kategorie</th>
                  <th>Hersteller</th>
                  <th>Gültigkeit</th>
                  <th>Version</th>
                  <th>Größe</th>
                  <th>Hochgeladen</th>
                </tr>
              </thead>
              <tbody>
                {docs.data.map((d) => (
                  <tr key={d.id} style={d.isCurrent ? undefined : { opacity: 0.6 }}>
                    <td>
                      <a href={`#/wissen/${d.id}`}>
                        <strong>{d.title}</strong>
                      </a>
                      <div className="muted small">
                        {d.filename}
                        {d.extractionMethod === 'ocr' ? ' · per Texterkennung gelesen' : ''}
                      </div>
                    </td>
                    <td>{categoryLabel(d.category)}</td>
                    <td>{d.vendor ?? '–'}</td>
                    <td>
                      <ValidityBadge validity={d.validity} until={d.validUntil} />
                    </td>
                    <td>
                      v{d.version}
                      {d.isCurrent ? '' : ' (alt)'}
                    </td>
                    <td className="num">{formatSize(d.sizeBytes)}</td>
                    <td>{formatDate(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function SearchCard() {
  const [query, setQuery] = useState('');
  const [cats, setCats] = useState<DocumentCategory[]>([]);
  const search = useMutation({
    mutationFn: (q: string) =>
      api.post<SearchHit[]>('/api/search', {
        query: q,
        limit: 10,
        ...(cats.length ? { categories: cats } : {}),
      }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) search.mutate(query.trim());
  };

  return (
    <section className="card" aria-labelledby="search-h">
      <h2 id="search-h">Suche</h2>
      <form onSubmit={submit} className="stack-sm">
        <div className="row">
          <input
            className="grow"
            placeholder="z. B. ISO 27001 Zertifikat, R760 Konfiguration, Reaktionszeiten …"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Suchbegriff"
          />
          <button className="primary" disabled={search.isPending || !query.trim()}>
            {search.isPending ? <Spinner /> : null} Suchen
          </button>
        </div>
        <div className="chips" role="group" aria-label="Kategorien einschränken">
          {DOCUMENT_CATEGORIES.map((c) => (
            <button
              type="button"
              key={c}
              className="chip"
              aria-pressed={cats.includes(c)}
              onClick={() => setCats((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </form>
      <ErrorNotice error={search.error} />
      {search.data && (
        <div style={{ marginTop: '.75rem' }}>
          {search.data.length === 0 ? (
            <Empty>
              Keine Treffer. Andere Begriffe oder Synonyme probieren (z. B. Rechenzentrum,
              Serverraum).
            </Empty>
          ) : (
            search.data.map((h) => (
              <article className="hit" key={h.chunkId}>
                <div className="row">
                  <a href={`#/wissen/${h.documentId}`}>
                    <strong>{h.title}</strong>
                  </a>
                  <span className="badge">{categoryLabel(h.category)}</span>
                  <ValidityBadge validity={h.validity} until={h.validUntil} />
                  {h.vendor && <span className="muted small">{h.vendor}</span>}
                  {h.page && <span className="muted small">Seite {h.page}</span>}
                </div>
                {h.heading && <div className="muted small">{h.heading}</div>}
                <pre>{h.content}</pre>
              </article>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function UploadCard({ existing }: { existing: DocumentSummary[] }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [form, setForm] = useState({
    title: '',
    category: 'product' as DocumentCategory,
    vendor: '',
    tags: '',
    validFrom: '',
    validUntil: '',
    replaces: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const upload = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.set('file', file!);
      fd.set('category', form.category);
      if (form.title.trim()) fd.set('title', form.title.trim());
      if (form.vendor.trim()) fd.set('vendor', form.vendor.trim());
      if (form.tags.trim()) fd.set('tags', form.tags);
      if (form.validFrom) fd.set('validFrom', form.validFrom);
      if (form.validUntil) fd.set('validUntil', form.validUntil);
      if (form.replaces) fd.set('replacesDocumentId', form.replaces);
      return api.upload<UploadResult>('/api/documents', fd);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      if (!r.duplicate) {
        setFile(null);
        setForm((f) => ({ ...f, title: '', tags: '', replaces: '' }));
        if (fileInput.current) fileInput.current.value = '';
      }
    },
  });

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setForm((p) => ({ ...p, title: p.title || f.name.replace(/\.[^.]+$/, '') }));
    upload.reset();
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0]);
  };

  return (
    <section className="card" style={{ marginTop: '1rem' }} aria-labelledby="upload-h">
      <h2 id="upload-h">Dokument hochladen</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (file) upload.mutate();
        }}
      >
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
        >
          {file ? (
            <strong>
              {file.name} <span className="muted">({formatSize(file.size)})</span>
            </strong>
          ) : (
            'Datei hierher ziehen oder klicken – PDF, DOCX, XLSX, PPTX, Text, Konfigurationen, gescannte Dokumente'
          )}
          <input ref={fileInput} type="file" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        <div className="grid-3" style={{ marginTop: '.75rem' }}>
          <div>
            <label htmlFor="u-title">Titel</label>
            <input
              id="u-title"
              value={form.title}
              onChange={set('title')}
              placeholder="Name im Katalog"
            />
          </div>
          <div>
            <label htmlFor="u-cat">Kategorie</label>
            <select id="u-cat" value={form.category} onChange={set('category')}>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="u-vendor">Hersteller</label>
            <input
              id="u-vendor"
              value={form.vendor}
              onChange={set('vendor')}
              placeholder="z. B. Dell"
            />
          </div>
          <div>
            <label htmlFor="u-from">Gültig ab</label>
            <input id="u-from" type="date" value={form.validFrom} onChange={set('validFrom')} />
          </div>
          <div>
            <label htmlFor="u-until">Gültig bis</label>
            <input id="u-until" type="date" value={form.validUntil} onChange={set('validUntil')} />
          </div>
          <div>
            <label htmlFor="u-tags">Schlagworte</label>
            <input
              id="u-tags"
              value={form.tags}
              onChange={set('tags')}
              placeholder="kommagetrennt"
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="u-repl">Ersetzt eine bestehende Unterlage (neue Version)</label>
          <select id="u-repl" value={form.replaces} onChange={set('replaces')}>
            <option value="">Nein, neues Dokument</option>
            {existing
              .filter((d) => d.isCurrent)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} (v{d.version})
                </option>
              ))}
          </select>
        </div>
        <div className="row" style={{ marginTop: '.9rem' }}>
          <button className="primary" disabled={!file || upload.isPending}>
            {upload.isPending ? (
              <>
                <Spinner /> Wird verarbeitet …
              </>
            ) : (
              'Hochladen'
            )}
          </button>
          <span className="muted small">
            Zertifikate und Preislisten bitte mit „Gültig bis“ erfassen: abgelaufene Unterlagen
            werden markiert und im Bid-Studio nicht verwendet.
          </span>
        </div>
      </form>
      <div style={{ marginTop: '.75rem' }}>
        <ErrorNotice error={upload.error} />
        {upload.data && (
          <Notice kind={upload.data.duplicate ? 'warn' : 'ok'}>
            {upload.data.duplicate ? (
              <>
                Diese Datei ist bereits vorhanden:{' '}
                <a href={`#/wissen/${upload.data.document.id}`}>{upload.data.document.title}</a>.
              </>
            ) : (
              <>
                <a href={`#/wissen/${upload.data.document.id}`}>{upload.data.document.title}</a>{' '}
                aufgenommen: {upload.data.document.chunkCount} Abschnitte
                {upload.data.document.extractionMethod === 'ocr'
                  ? ', Text per Texterkennung gelesen'
                  : ''}
                {upload.data.document.version > 1
                  ? `, Version ${upload.data.document.version}`
                  : ''}
                .
              </>
            )}
            {upload.data.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </Notice>
        )}
      </div>
    </section>
  );
}
