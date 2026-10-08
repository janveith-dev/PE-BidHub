// Gemeinsame Aufzählungen. Beschriftungen stehen hier, damit API-Antworten,
// Agenten-Prompts und Oberfläche dieselben Begriffe verwenden.

export const DOCUMENT_CATEGORIES = [
  'product',
  'concept',
  'config',
  'pricelist',
  'certificate',
  'reference',
  'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  product: 'Produktdokumentation',
  concept: 'Konzeptbaustein',
  config: 'Konfiguration',
  pricelist: 'Preisliste',
  certificate: 'Zertifikat / Nachweis',
  reference: 'Referenz',
  other: 'Sonstiges',
};

/** Nutzerrolle in der Oberfläche. Es gibt noch kein Login — die Rolle steuert nur Navigation und Protokoll. */
export const USER_ROLES = ['presales', 'sales', 'bid_management'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  presales: 'Presales',
  sales: 'Sales',
  bid_management: 'Bid Management',
};

/** Fachautoren-Rollen der Agenten. Jede hat einen eigenen Schwerpunkt im Prompt. */
export const AUTHOR_ROLES = [
  'solution_architect',
  'service_manager',
  'project_manager',
  'security',
] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];

export const AUTHOR_ROLE_LABELS: Record<AuthorRole, string> = {
  solution_architect: 'Solution Architect',
  service_manager: 'Service Manager',
  project_manager: 'Projektmanager',
  security: 'Security Officer',
};

export const LANGUAGES = ['de', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Lebenszyklus eines Dokuments im Bid-Studio. Jede Freigabe des Bid Managers ist ein eigener Schritt. */
export const BID_DOCUMENT_STATUSES = [
  'draft',
  'analyzing',
  'outline_review',
  'writing',
  'written',
  'reviewing',
  'reviewed',
  'failed',
] as const;
export type BidDocumentStatus = (typeof BID_DOCUMENT_STATUSES)[number];

export const BID_DOCUMENT_STATUS_LABELS: Record<BidDocumentStatus, string> = {
  draft: 'Vorgabe hochgeladen',
  analyzing: 'Analyse läuft',
  outline_review: 'Gliederung zur Freigabe',
  writing: 'Agenten schreiben',
  written: 'Entwurf fertig',
  reviewing: 'Prüfung läuft',
  reviewed: 'Geprüft',
  failed: 'Fehlgeschlagen',
};

export const SECTION_STATUSES = ['pending', 'researching', 'writing', 'written', 'failed'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];
