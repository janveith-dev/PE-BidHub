import {
  AUTHOR_ROLE_LABELS,
  BID_DOCUMENT_STATUS_LABELS,
  USER_ROLE_LABELS,
  type AuthorRole,
  type BidDocumentStatus,
  type UserRole,
} from '@bid/shared';

export const statusLabel = (s: BidDocumentStatus): string => BID_DOCUMENT_STATUS_LABELS[s];
export const roleLabel = (r: string): string => AUTHOR_ROLE_LABELS[r as AuthorRole] ?? r;

/** „agent:writer:service_manager" → „KI-Autor (Service Manager)"; „user:bid_management" → „Bid Management". */
export function authorLabel(author: string): string {
  if (author.startsWith('agent:writer:')) return `KI-Autor (${roleLabel(author.slice(13))})`;
  if (author === 'agent:lektor') return 'KI-Lektor';
  if (author.startsWith('user:')) {
    const r = author.slice(5);
    return USER_ROLE_LABELS[r as UserRole] ?? r;
  }
  return author || 'unbekannt';
}

export const AGENT_LABEL: Record<string, string> = {
  system: 'System',
  analyst: 'Anforderungsanalyst',
  researcher: 'Rechercheur',
  reviewer: 'Prüfer',
  lektor: 'Lektor',
};

export function agentLabel(agent: string): string {
  if (agent.startsWith('writer:')) return `Autor · ${roleLabel(agent.slice(7))}`;
  return AGENT_LABEL[agent] ?? agent;
}

export const KIND_LABEL = { must: 'Muss', should: 'Soll', info: 'Info' } as const;
export const COVERAGE_LABEL = {
  covered: 'erfüllt',
  partial: 'teilweise',
  missing: 'fehlt',
} as const;
export const SEVERITY_LABEL = { blocker: 'Blocker', major: 'Wichtig', minor: 'Gering' } as const;
export const FINDING_KIND_LABEL = {
  coverage: 'Abdeckung',
  open_point: 'Offener Punkt',
  unsupported_claim: 'Beleg fehlt',
  length: 'Länge',
  stale_source: 'Quelle veraltet',
  consistency: 'Widerspruch',
  style: 'Stil',
} as const;
export const SECTION_STATUS_LABEL = {
  pending: 'wartet',
  researching: 'recherchiert',
  writing: 'schreibt',
  written: 'fertig',
  failed: 'fehlgeschlagen',
} as const;
