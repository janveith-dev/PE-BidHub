import { useSyncExternalStore } from 'react';

/** Minimaler Hash-Router: #/chat, #/wissen/<id> … Genügt für sechs Seiten und braucht keine Serverkonfiguration. */
function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const snapshot = (): string => window.location.hash.replace(/^#\/?/, '');

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, snapshot);
  return hash.split('/').filter(Boolean).map(decodeURIComponent);
}

export const navigate = (to: string): void => {
  window.location.hash = to.startsWith('/') ? to : `/${to}`;
};
