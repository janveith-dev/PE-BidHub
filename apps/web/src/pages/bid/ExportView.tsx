import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { BidDocumentDetailDto, TemplateDto } from '@bid/shared';
import { api } from '../../api';
import { ErrorNotice, Notice, Spinner, downloadFile } from '../../components/ui';
import { useRole } from '../../role';

export function ExportView({ doc }: { doc: BidDocumentDetailDto }) {
  const role = useRole();
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<TemplateDto[]>('/api/templates'),
  });
  const [templateId, setTemplateId] = useState<string>();
  const [sources, setSources] = useState(false);
  const [result, setResult] = useState<{ open: number; usedMarker: boolean; template: string }>();
  const file = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState({ name: '', isDefault: true });

  const effective =
    templateId ?? doc.templateId ?? templates.data?.find((t) => t.isDefault)?.id ?? 'standard';
  const open = doc.sections.reduce((n, s) => n + (s.content.match(/\[OFFEN:/g)?.length ?? 0), 0);
  const blockers = (doc.findings ?? []).filter((f) => f.severity === 'blocker').length;
  const hasText = doc.sections.some((s) => s.content.trim());

  const download = useMutation({
    mutationFn: async () => {
      const q = new URLSearchParams({ templateId: effective, sources: sources ? '1' : '0' });
      const h = await downloadFile(
        `/api/bid-documents/${doc.id}/export.docx?${q}`,
        `${doc.title}.docx`,
        role,
      );
      setResult({
        open: Number(h.get('x-open-points') ?? 0),
        usedMarker: h.get('x-content-marker') === '1',
        template: decodeURIComponent(h.get('x-template') ?? ''),
      });
    },
  });
  const addTemplate = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('file', file.current!.files![0]!);
      if (upload.name.trim()) fd.set('name', upload.name.trim());
      fd.set('isDefault', String(upload.isDefault));
      return api.upload<{ id: string; warnings: string[] }>('/api/templates', fd);
    },
    onSuccess: (r) => {
      setTemplateId(r.id);
      if (file.current) file.current.value = '';
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const removeTemplate = useMutation({
    mutationFn: (id: string) => api.del(`/api/templates/${id}`),
    onSuccess: () => {
      setTemplateId(undefined);
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  return (
    <div className="stack">
      <section className="card">
        <h2>Word-Dokument erzeugen</h2>
        {!hasText && <Notice kind="warn">Es gibt noch keinen Text zum Exportieren.</Notice>}
        {open > 0 && (
          <Notice kind="warn">
            <strong>{open} offene Punkte</strong> stehen noch im Text und erscheinen im Dokument
            gelb markiert. Bitte vor der Abgabe klären: Hier fehlen Belege.
          </Notice>
        )}
        {blockers > 0 && (
          <Notice kind="error">
            Die Prüfung meldet {blockers} Blocker. Das Angebot wäre in diesem Zustand
            ausschlussgefährdet oder fehlerhaft.
          </Notice>
        )}
        {doc.status === 'written' && doc.coverage && (
          <Notice>Die letzte Prüfung ist veraltet, weil der Text danach geändert wurde.</Notice>
        )}
        <div className="grid-2">
          <div>
            <label htmlFor="x-tpl">Vorlage</label>
            <select id="x-tpl" value={effective} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? ' (Standard)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <label className="check">
              <input
                type="checkbox"
                checked={sources}
                onChange={(e) => setSources(e.target.checked)}
              />{' '}
              Quellenmarken im Text und Quellenverzeichnis anhängen
            </label>
          </div>
        </div>
        <div className="row" style={{ marginTop: '.9rem' }}>
          <button
            className="primary"
            disabled={!hasText || download.isPending || doc.running}
            onClick={() => download.mutate()}
          >
            {download.isPending ? <Spinner /> : null} Als Word herunterladen
          </button>
          <a href="/api/templates/standard/file" download>
            Standardvorlage herunterladen
          </a>
        </div>
        <ErrorNotice error={download.error} />
        {result && (
          <Notice kind={result.open ? 'warn' : 'ok'}>
            Heruntergeladen mit Vorlage „{result.template}“.
            {result.open ? ` Enthält ${result.open} offene Punkte.` : ''}
            {!result.usedMarker && (
              <div>
                Die Vorlage hat keinen Absatz <span className="mono">{'{{INHALT}}'}</span>; der Text
                steht hinter dem vorhandenen Vorlagentext.
              </div>
            )}
          </Notice>
        )}
      </section>

      <section className="card">
        <h2>Firmenvorlage hinterlegen</h2>
        <p className="muted small">
          Lade eine Word-Vorlage (.docx oder .dotx) mit Logo, Schriften und Formatvorlagen hoch. Der
          Text kommt an die Stelle des Absatzes <span className="mono">{'{{INHALT}}'}</span>. In
          Deckblatt, Kopf- und Fußzeile werden{' '}
          <span className="mono">
            {'{{TITEL}} {{KUNDE}} {{AUSSCHREIBUNG}} {{DATUM}} {{AUTOR}}'}
          </span>{' '}
          ersetzt. Überschriften, Listen und Tabellen übernehmen die Formatvorlagen der Vorlage
          (Überschrift 1–4, Aufzählung, Tabellenraster).
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (file.current?.files?.[0]) addTemplate.mutate();
          }}
        >
          <div className="row">
            <input
              ref={file}
              type="file"
              accept=".docx,.dotx"
              style={{ width: 'auto' }}
              aria-label="Vorlagendatei"
            />
            <input
              style={{ width: '14rem' }}
              placeholder="Name der Vorlage"
              value={upload.name}
              onChange={(e) => setUpload((u) => ({ ...u, name: e.target.value }))}
              aria-label="Name der Vorlage"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={upload.isDefault}
                onChange={(e) => setUpload((u) => ({ ...u, isDefault: e.target.checked }))}
              />{' '}
              als Standard
            </label>
            <button disabled={addTemplate.isPending}>
              {addTemplate.isPending ? <Spinner /> : null} Hochladen
            </button>
          </div>
        </form>
        <ErrorNotice error={addTemplate.error ?? removeTemplate.error} />
        {addTemplate.data?.warnings.map((w) => (
          <Notice key={w} kind="warn">
            {w}
          </Notice>
        ))}
        <div className="stack-sm" style={{ marginTop: '.75rem' }}>
          {templates.data
            ?.filter((t) => !t.builtin)
            .map((t) => (
              <div className="row between fact" key={t.id}>
                <span>
                  {t.name}{' '}
                  <span className="muted small">
                    ({t.filename}){t.isDefault ? ' · Standard' : ''}
                  </span>
                </span>
                <button
                  className="small danger"
                  onClick={() =>
                    window.confirm(`Vorlage „${t.name}“ löschen?`) && removeTemplate.mutate(t.id)
                  }
                >
                  Löschen
                </button>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
