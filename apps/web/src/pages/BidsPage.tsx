import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { BidDto } from '@bid/shared';
import { api } from '../api';
import { Empty, ErrorNotice, Loading, PageHead, formatDate } from '../components/ui';
import { navigate } from '../router';

export function BidsPage() {
  const qc = useQueryClient();
  const bids = useQuery({ queryKey: ['bids'], queryFn: () => api.get<BidDto[]>('/api/bids') });
  const [form, setForm] = useState({
    name: '',
    customer: '',
    deadline: '',
    language: 'de',
    notes: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      api.post<BidDto>('/api/bids', {
        name: form.name,
        customer: form.customer,
        language: form.language,
        ...(form.deadline ? { deadline: form.deadline } : {}),
        ...(form.notes.trim() ? { notes: form.notes } : {}),
      }),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: ['bids'] });
      navigate(`/bids/${b.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <PageHead
        title="Bid-Studio"
        sub="Dokumente nach Vorgabe des Kunden erstellen: Die Agenten schreiben auf Basis der Wissensbasis und der Websuche; du gibst jede Etappe frei."
      />
      <section className="card" aria-labelledby="new-bid">
        <h2 id="new-bid">Neue Ausschreibung</h2>
        <form onSubmit={submit}>
          <div className="grid-3">
            <div>
              <label htmlFor="b-name">Bezeichnung</label>
              <input
                id="b-name"
                required
                value={form.name}
                onChange={set('name')}
                placeholder="z. B. Rechenzentrumsbetrieb 2026"
              />
            </div>
            <div>
              <label htmlFor="b-cust">Auftraggeber</label>
              <input
                id="b-cust"
                required
                value={form.customer}
                onChange={set('customer')}
                placeholder="z. B. Stadt Beispielstadt"
              />
            </div>
            <div>
              <label htmlFor="b-dead">Abgabefrist</label>
              <input id="b-dead" type="date" value={form.deadline} onChange={set('deadline')} />
            </div>
          </div>
          <div className="grid-2" style={{ marginTop: '.75rem' }}>
            <div>
              <label htmlFor="b-lang">Sprache der Unterlagen</label>
              <select id="b-lang" value={form.language} onChange={set('language')}>
                <option value="de">Deutsch</option>
                <option value="en">Englisch</option>
              </select>
            </div>
            <div>
              <label htmlFor="b-notes">Notizen</label>
              <input id="b-notes" value={form.notes} onChange={set('notes')} />
            </div>
          </div>
          <div className="row" style={{ marginTop: '.9rem' }}>
            <button
              className="primary"
              disabled={create.isPending || !form.name.trim() || !form.customer.trim()}
            >
              Ausschreibung anlegen
            </button>
          </div>
          <ErrorNotice error={create.error} />
        </form>
      </section>

      <section className="card" style={{ marginTop: '1rem' }} aria-labelledby="bids-h">
        <h2 id="bids-h">Ausschreibungen</h2>
        {bids.isLoading ? (
          <Loading />
        ) : !bids.data?.length ? (
          <Empty>Noch keine Ausschreibung angelegt.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bezeichnung</th>
                  <th>Auftraggeber</th>
                  <th>Abgabefrist</th>
                  <th>Dokumente</th>
                  <th>Zuletzt geändert</th>
                </tr>
              </thead>
              <tbody>
                {bids.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <a href={`#/bids/${b.id}`}>
                        <strong>{b.name}</strong>
                      </a>
                    </td>
                    <td>{b.customer}</td>
                    <td>{formatDate(b.deadline)}</td>
                    <td className="num">{b.document_count ?? 0}</td>
                    <td>{formatDate(b.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorNotice error={bids.error} />
      </section>
    </>
  );
}
