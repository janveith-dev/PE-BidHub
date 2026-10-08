import { useQuery } from '@tanstack/react-query';
import { USER_ROLES, USER_ROLE_LABELS, type CapabilitiesDto, type UserRole } from '@bid/shared';
import { useEffect } from 'react';
import { api } from './api';
import { Notice } from './components/ui';
import { BidDocPage } from './pages/BidDocPage';
import { BidPage } from './pages/BidPage';
import { BidsPage } from './pages/BidsPage';
import { ChatPage } from './pages/ChatPage';
import { DocumentPage } from './pages/DocumentPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { setRole, useRole } from './role';
import { navigate, useRoute } from './router';

const NAV: Record<UserRole, { to: string; key: string; label: string }[]> = {
  presales: [
    { to: '/wissen', key: 'wissen', label: 'Wissensbasis' },
    { to: '/chat', key: 'chat', label: 'Chat' },
    { to: '/bids', key: 'bids', label: 'Bid-Studio' },
  ],
  sales: [
    { to: '/chat', key: 'chat', label: 'Chat' },
    { to: '/wissen', key: 'wissen', label: 'Wissensbasis' },
  ],
  bid_management: [
    { to: '/bids', key: 'bids', label: 'Bid-Studio' },
    { to: '/chat', key: 'chat', label: 'Chat' },
    { to: '/wissen', key: 'wissen', label: 'Wissensbasis' },
  ],
};

export function App() {
  const role = useRole();
  const [section = '', a, b] = useRoute();
  const caps = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api.get<CapabilitiesDto>('/api/capabilities'),
    staleTime: 60_000,
  });

  const nav = NAV[role];
  // Wer eine Seite aufruft, die seine Rolle nicht hat (oder keine Adresse), landet auf der ersten Seite der Rolle.
  const allowed = nav.some((n) => n.key === section) || section === 'doc';
  useEffect(() => {
    if (!allowed) navigate(nav[0]!.to);
  }, [allowed, nav]);

  const missing: string[] = [];
  if (caps.data && !caps.data.llm)
    missing.push('KI (ANTHROPIC_API_KEY): Chat und Bid-Studio können nicht antworten');
  if (caps.data && !caps.data.speechToText) missing.push('Spracherkennung (ML-Dienst)');
  if (caps.data && !caps.data.textToSpeech) missing.push('Sprachausgabe (ELEVENLABS_API_KEY)');

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/">
            <span className="brand-mark" aria-hidden>
              b
            </span>
            <span>
              bid-hub <small>public edge</small>
            </span>
          </a>
          <nav className="nav" aria-label="Hauptnavigation">
            {nav.map((n) => (
              <a
                key={n.key}
                href={`#${n.to}`}
                aria-current={
                  section === n.key || (n.key === 'bids' && section === 'doc') ? 'page' : undefined
                }
              >
                {n.label}
              </a>
            ))}
          </nav>
          <label className="role">
            Rolle
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              aria-label="Rolle wählen"
            >
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {USER_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main>
        {missing.length > 0 && (
          <Notice kind="warn">
            <strong>Nicht eingerichtet:</strong> {missing.join(' · ')}. Siehe{' '}
            <span className="mono">.env.example</span>.
          </Notice>
        )}
        {section === 'wissen' && (a ? <DocumentPage id={a} /> : <KnowledgePage />)}
        {section === 'chat' && <ChatPage sessionId={a} />}
        {section === 'bids' && (a ? <BidPage id={a} /> : <BidsPage />)}
        {section === 'doc' && a && <BidDocPage id={a} tab={b} />}
      </main>
    </>
  );
}
