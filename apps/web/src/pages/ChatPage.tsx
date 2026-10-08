import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CapabilitiesDto, ChatMessageDto, ChatSessionDto, ChatSource } from '@bid/shared';
import { api, streamChat } from '../api';
import { Markdown } from '../components/Markdown';
import { ErrorNotice, Notice, Spinner, ValidityBadge } from '../components/ui';
import { navigate } from '../router';
import { useDictation, useVoiceDialog, type DialogState } from '../voice/useVoice';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSource[];
  error?: boolean;
  pending?: boolean;
  status?: string;
}

const SUGGESTIONS = [
  'Welche Zertifikate haben wir und wie lange sind sie gültig?',
  'Welche Referenzen gibt es zu Servicekonzepten für öffentliche Auftraggeber?',
  'Welche Server passen für Virtualisierung und was sagt die Preisliste?',
];

const DIALOG_TEXT: Record<DialogState, string> = {
  off: '',
  listening: 'Ich höre zu – stelle deine Frage.',
  hearing: 'Ich höre dich …',
  transcribing: 'Ich verstehe dich …',
  thinking: 'Ich suche in der Wissensbasis …',
  speaking: 'Ich antworte …',
};

let nextId = 0;
const localId = (): string => `local-${++nextId}`;

export function ChatPage({ sessionId: routeSession }: { sessionId: string | undefined }) {
  const qc = useQueryClient();
  const caps = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api.get<CapabilitiesDto>('/api/capabilities'),
  });
  const sessions = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => api.get<ChatSessionDto[]>('/api/chat/sessions'),
  });

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Die Sitzung, deren Nachrichten gerade im Zustand liegen. Verhindert, dass das Laden aus der Adresse den
  // laufenden Strom überschreibt, wenn die Sitzung während der ersten Antwort angelegt wird.
  const held = useRef<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (routeSession === held.current) return;
    held.current = routeSession;
    setLoadError(null);
    if (!routeSession) return setMessages([]);
    api
      .get<{ messages: ChatMessageDto[] }>(`/api/chat/sessions/${routeSession}`)
      .then((s) =>
        setMessages(
          s.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            sources: m.sources,
          })),
        ),
      )
      .catch((e: unknown) => setLoadError(e));
  }, [routeSession]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const patchLast = (fn: (m: Msg) => Msg) =>
    setMessages((all) => (all.length ? [...all.slice(0, -1), fn(all[all.length - 1]!)] : all));

  /** Schickt eine Frage und streamt die Antwort. Gibt den Antworttext zurück (für die Sprachausgabe). */
  const send = useCallback(
    async (text: string, spoken: boolean): Promise<string> => {
      setBusy(true);
      setMessages((all) => [
        ...all,
        { id: localId(), role: 'user', content: text, sources: [] },
        { id: localId(), role: 'assistant', content: '', sources: [], pending: true },
      ]);
      let answer = '';
      try {
        for await (const ev of streamChat({ sessionId: held.current, message: text, spoken })) {
          if (ev.type === 'session' && held.current !== ev.id) {
            held.current = ev.id;
            navigate(`/chat/${ev.id}`);
          } else if (ev.type === 'text') {
            answer += ev.delta;
            patchLast((m) => ({ ...m, content: answer, status: undefined }));
          } else if (ev.type === 'status') patchLast((m) => ({ ...m, status: ev.message }));
          else if (ev.type === 'sources') patchLast((m) => ({ ...m, sources: ev.sources }));
          else if (ev.type === 'error') {
            patchLast((m) => ({
              ...m,
              content: ev.message,
              error: true,
              pending: false,
              status: undefined,
            }));
            return '';
          }
        }
        patchLast((m) => ({ ...m, pending: false, status: undefined }));
        void qc.invalidateQueries({ queryKey: ['chat-sessions'] });
        return answer;
      } catch (e) {
        patchLast((m) => ({
          ...m,
          content: e instanceof Error ? e.message : String(e),
          error: true,
          pending: false,
        }));
        return '';
      } finally {
        setBusy(false);
      }
    },
    [qc],
  );

  const dialog = useVoiceDialog({
    language: 'de',
    speakReplies: caps.data?.textToSpeech ?? false,
    onUserText: (text) => send(text, true),
  });
  const dictation = useDictation(
    (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)),
    'de',
  );

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void send(text, false);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const newChat = () => {
    held.current = undefined;
    setMessages([]);
    navigate('/chat');
  };
  const removeSession = async (id: string) => {
    if (!window.confirm('Diese Unterhaltung löschen?')) return;
    await api.del(`/api/chat/sessions/${id}`);
    await qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    if (id === held.current) newChat();
  };

  const stt = caps.data?.speechToText ?? false;

  return (
    <div className="chat">
      <aside className="chat-side">
        <button className="primary" onClick={newChat}>
          Neue Unterhaltung
        </button>
        <nav className="sessions" aria-label="Unterhaltungen">
          {sessions.data?.map((s) => (
            <div className="session" key={s.id}>
              <a
                href={`#/chat/${s.id}`}
                aria-current={s.id === routeSession ? 'page' : undefined}
                title={s.title}
              >
                {s.title}
              </a>
              <button
                className="ghost small"
                aria-label={`„${s.title}" löschen`}
                onClick={() => void removeSession(s.id)}
              >
                ×
              </button>
            </div>
          ))}
          {sessions.data?.length === 0 && <p className="muted small">Noch keine Unterhaltungen.</p>}
        </nav>
      </aside>

      <section className="card chat-main" aria-label="Chat">
        <div className="messages" aria-live="polite">
          <ErrorNotice error={loadError} />
          {messages.length === 0 && !loadError && (
            <div className="empty">
              <p>
                <strong>Frag die Wissensbasis.</strong>
              </p>
              <p className="small">
                Antworten stammen ausschließlich aus den hochgeladenen Unterlagen und nennen ihre
                Quellen.
              </p>
              <div className="chips" style={{ justifyContent: 'center' }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => void send(s, false)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          <div ref={bottom} />
        </div>

        {dialog.active && (
          <div className="dialog-bar" role="status">
            <span
              className={`pulse ${dialog.state === 'hearing' ? 'hearing' : dialog.state === 'speaking' ? 'speaking' : ['transcribing', 'thinking'].includes(dialog.state) ? 'busy' : ''}`}
            />
            <span className="grow">{DIALOG_TEXT[dialog.state]}</span>
            <span className="level" aria-hidden>
              <span style={{ width: `${Math.round(dialog.level * 100)}%` }} />
            </span>
            {dialog.state === 'speaking' && (
              <button className="small" onClick={dialog.interrupt}>
                Unterbrechen
              </button>
            )}
            <button className="small danger" onClick={dialog.stop}>
              Gespräch beenden
            </button>
          </div>
        )}
        {(dialog.error || dictation.error) && (
          <div style={{ padding: '0 .75rem' }}>
            <Notice kind="error">{dialog.error ?? dictation.error}</Notice>
          </div>
        )}
        {caps.data && !caps.data.textToSpeech && dialog.active && (
          <div style={{ padding: '0 .75rem' }}>
            <Notice kind="warn">
              Sprachausgabe ist nicht eingerichtet – Antworten erscheinen nur als Text.
            </Notice>
          </div>
        )}

        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              dictation.recording
                ? 'Ich höre zu – sprich jetzt …'
                : 'Frage eingeben (Enter sendet, Umschalt+Enter = neue Zeile)'
            }
            aria-label="Nachricht"
            rows={1}
          />
          <button
            className={`mic${dictation.recording ? ' on' : ''}`}
            onClick={dictation.toggle}
            disabled={!stt || dialog.active || dictation.busy}
            title={
              stt
                ? 'Diktieren: sprechen, der Text erscheint zur Kontrolle im Eingabefeld'
                : 'Spracherkennung ist nicht eingerichtet'
            }
            aria-pressed={dictation.recording}
          >
            {dictation.busy ? <Spinner /> : '🎤'} {dictation.recording ? 'Hört zu' : 'Diktieren'}
          </button>
          <button
            className={dialog.active ? 'danger' : ''}
            onClick={() => (dialog.active ? dialog.stop() : void dialog.start())}
            disabled={!stt || busy}
            title={
              stt
                ? 'Freihändiges Gespräch: sprechen und die Antwort vorlesen lassen'
                : 'Spracherkennung ist nicht eingerichtet'
            }
          >
            {dialog.active ? '■ Gespräch beenden' : '🗣 Sprachdialog'}
          </button>
          <button className="primary" onClick={submit} disabled={busy || !input.trim()}>
            {busy ? <Spinner /> : 'Senden'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  if (m.role === 'user') return <div className="bubble user">{m.content}</div>;
  const citeLinks = Object.fromEntries(m.sources.map((s) => [s.ref, `#/wissen/${s.documentId}`]));
  return (
    <div className={`bubble assistant${m.error ? ' error' : ''}`}>
      {m.content ? (
        <Markdown text={m.content} citeLinks={citeLinks} />
      ) : (
        m.pending && (
          <>
            <Spinner /> <span className="muted">{m.status ?? 'Denke nach …'}</span>
          </>
        )
      )}
      {m.pending && m.content && m.status && (
        <p className="muted small">
          <Spinner /> {m.status}
        </p>
      )}
      {m.sources.length > 0 && (
        <div className="sources" aria-label="Quellen">
          {m.sources.map((s) => (
            <div className="source" key={s.ref}>
              <a className="cite" href={`#/wissen/${s.documentId}`}>
                {s.ref}
              </a>
              <a href={`#/wissen/${s.documentId}`}>{s.title}</a>
              {s.heading && <span className="muted">· {s.heading}</span>}
              {s.page && <span className="muted">· Seite {s.page}</span>}
              <ValidityBadge validity={s.validity} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
