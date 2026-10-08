import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import type { BidDocumentDto, BidDto } from '@bid/shared';
import { api } from '../api';
import {
  Empty,
  ErrorNotice,
  Loading,
  PageHead,
  Spinner,
  formatDate,
  formatSize,
} from '../components/ui';
import { navigate } from '../router';
import { statusLabel } from './bid/labels';

interface BidDetail {
  bid: BidDto;
  documents: (BidDocumentDto & { sectionCount: number; writtenCount: number })[];
}

export function BidPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['bid', id],
    queryFn: () => api.get<BidDetail>(`/api/bids/${id}`),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [form, setForm] = useState({ title: 'Servicekonzept', specText: '', allowWeb: true });

  const create = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('title', form.title);
      fd.set('allowWeb', String(form.allowWeb));
      if (form.specText.trim()) fd.set('specText', form.specText);
      files.forEach((f) => fd.append('file', f));
      return api.upload<BidDocumentDto>(`/api/bids/${id}/documents`, fd);
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['bid', id] });
      navigate(`/doc/${d.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/bids/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bids'] });
      navigate('/bids');
    },
  });

  if (detail.isLoading) return <Loading />;
  if (!detail.data)
    return (
      <>
        <a href="#/bids">← Zurück</a>
        <ErrorNotice error={detail.error} />
      </>
    );
  const { bid, documents } = detail.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <p>
        <a href="#/bids">← Ausschreibungen</a>
      </p>
      <PageHead
        title={bid.name}
        sub={`${bid.customer} · Abgabefrist ${formatDate(bid.deadline)} · ${bid.language === 'en' ? 'Englisch' : 'Deutsch'}`}
      >
        <button
          className="danger"
          onClick={() =>
            window.confirm(`„${bid.name}" mit allen Dokumenten löschen?`) && remove.mutate()
          }
        >
          Löschen
        </button>
      </PageHead>
      <ErrorNotice error={remove.error} />

      <section className="card" aria-labelledby="docs-h">
        <h2 id="docs-h">Dokumente</h2>
        {documents.length === 0 ? (
          <Empty>Noch kein Dokument. Lade unten die Vorgabe des Kunden hoch.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dokument</th>
                  <th>Stand</th>
                  <th>Kapitel</th>
                  <th>Zuletzt geändert</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={`#/doc/${d.id}`}>
                        <strong>{d.title}</strong>
                      </a>
                    </td>
                    <td>
                      <span
                        className={`badge ${d.status === 'failed' ? 'failed' : d.status === 'reviewed' ? 'ok' : d.status === 'outline_review' ? 'major' : ''}`}
                      >
                        {statusLabel(d.status)}
                      </span>
                    </td>
                    <td className="num">
                      {d.sectionCount ? `${d.writtenCount} / ${d.sectionCount} fertig` : '–'}
                    </td>
                    <td>{formatDate(d.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: '1rem' }} aria-labelledby="new-doc">
        <h2 id="new-doc">Neues Dokument nach Vorgabe des Kunden</h2>
        <p className="muted small">
          Beschreibt der Kunde, wie z. B. ein Servicekonzept aufgebaut sein soll, lade die
          Beschreibung hier hoch (PDF, DOCX, XLSX, Text, auch gescannt). Der Analyst zerlegt sie in
          Anforderungen und eine Gliederung, die du prüfst, bevor geschrieben wird.
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="d-title">Dokument</label>
            <input
              id="d-title"
              required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="z. B. Servicekonzept, Sicherheitskonzept, Migrationskonzept"
            />
          </div>
          <div className="field">
            <label>Vorgabe des Kunden (eine oder mehrere Dateien)</label>
            <div className="row">
              <button type="button" onClick={() => fileInput.current?.click()}>
                Dateien wählen …
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => setFiles([...(e.target.files ?? [])])}
              />
              <span className="muted small">
                {files.length
                  ? files.map((f) => `${f.name} (${formatSize(f.size)})`).join(', ')
                  : 'Keine Datei gewählt'}
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="d-text">… und/oder Text einfügen</label>
            <textarea
              id="d-text"
              rows={5}
              value={form.specText}
              onChange={(e) => setForm((f) => ({ ...f, specText: e.target.value }))}
              placeholder="Anforderungstext des Kunden hier einfügen"
            />
          </div>
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={form.allowWeb}
                onChange={(e) => setForm((f) => ({ ...f, allowWeb: e.target.checked }))}
              />{' '}
              Websuche für die Recherche erlauben (Herstellerangaben, Normen, Informationen zum
              Auftraggeber)
            </label>
          </div>
          <div className="row" style={{ marginTop: '.9rem' }}>
            <button
              className="primary"
              disabled={
                create.isPending ||
                (!files.length && form.specText.trim().length < 20) ||
                !form.title.trim()
              }
            >
              {create.isPending ? (
                <>
                  <Spinner /> Wird gelesen …
                </>
              ) : (
                'Dokument anlegen'
              )}
            </button>
          </div>
          <ErrorNotice error={create.error} />
        </form>
      </section>
    </>
  );
}
