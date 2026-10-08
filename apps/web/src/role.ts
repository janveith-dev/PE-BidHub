import { useSyncExternalStore } from 'react';
import { USER_ROLES, type UserRole } from '@bid/shared';

const KEY = 'bid-hub.role';
const listeners = new Set<() => void>();

function read(): UserRole {
  try {
    const stored = localStorage.getItem(KEY);
    return USER_ROLES.find((r) => r === stored) ?? 'sales';
  } catch {
    return 'sales'; // Speicher gesperrt (z. B. privates Fenster): die Oberfläche läuft trotzdem
  }
}

let current: UserRole = read();

/** Die Rolle steuert Navigation und Berechtigungen der Oberfläche und geht als Kopfzeile an die API (Protokoll). */
export const getRole = (): UserRole => current;

export function setRole(role: UserRole): void {
  current = role;
  try {
    localStorage.setItem(KEY, role);
  } catch {
    /* nur eine Bequemlichkeit */
  }
  listeners.forEach((l) => l());
}

export function useRole(): UserRole {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Wissensbasis pflegen dürfen nur Presales; Sales und Bid Management lesen und suchen. */
export const canEditKnowledge = (role: UserRole): boolean => role === 'presales';
