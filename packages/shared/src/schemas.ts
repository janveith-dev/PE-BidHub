import { z } from 'zod';
import { AUTHOR_ROLES, DOCUMENT_CATEGORIES, LANGUAGES, USER_ROLES } from './enums.js';

// --- Wissensbasis -------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als JJJJ-MM-TT');

export const DocumentMetaSchema = z.object({
  title: z.string().trim().min(1).max(300),
  category: z.enum(DOCUMENT_CATEGORIES),
  vendor: z.string().trim().max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  validFrom: isoDate.optional(),
  validUntil: isoDate.optional(),
  /** Ersetzt eine bestehende Dokumentfamilie: die alte Fassung bleibt als Version erhalten. */
  replacesDocumentId: z.string().uuid().optional(),
});
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

export const DocumentSummarySchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  title: z.string(),
  category: z.enum(DOCUMENT_CATEGORIES),
  vendor: z.string().nullable(),
  tags: z.array(z.string()),
  language: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  version: z.number().int(),
  isCurrent: z.boolean(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
  chunkCount: z.number().int(),
  extractionMethod: z.string(),
  uploadedByRole: z.string().nullable(),
  createdAt: z.string(),
  /** valid | expired | expiring (innerhalb von 60 Tagen) | unlimited */
  validity: z.enum(['valid', 'expiring', 'expired', 'unlimited']),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  categories: z.array(z.enum(DOCUMENT_CATEGORIES)).optional(),
  vendor: z.string().optional(),
  limit: z.number().int().min(1).max(30).default(8),
  /** Abgelaufene Dokumente ausblenden (Bid-Studio) oder kennzeichnen (Chat). */
  excludeExpired: z.boolean().default(false),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  title: z.string(),
  category: z.enum(DOCUMENT_CATEGORIES),
  vendor: z.string().nullable(),
  heading: z.string().nullable(),
  page: z.number().nullable(),
  content: z.string(),
  score: z.number(),
  validUntil: z.string().nullable(),
  validity: z.enum(['valid', 'expiring', 'expired', 'unlimited']),
  version: z.number().int(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

// --- Chat ---------------------------------------------------------------------

export const ChatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000),
  /** true bei Spracheingabe: Antworten werden kürzer und sprechbar formuliert. */
  spoken: z.boolean().default(false),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatSourceSchema = z.object({
  /** Marke im Antworttext, z. B. „Q2". */
  ref: z.string(),
  documentId: z.string().uuid(),
  title: z.string(),
  heading: z.string().nullable(),
  page: z.number().nullable(),
  validity: z.enum(['valid', 'expiring', 'expired', 'unlimited']),
  excerpt: z.string(),
});
export type ChatSource = z.infer<typeof ChatSourceSchema>;

// --- Bid-Studio -----------------------------------------------------------------

export const RequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(['must', 'should', 'info']),
  topic: z.string(),
  /** Wörtliches Zitat aus der Kundenvorgabe, damit der Bid Manager es prüfen kann. */
  sourceQuote: z.string().optional(),
  /** Vom Server gesetzt: kommt das Zitat tatsächlich in der Vorgabe vor? */
  quoteVerified: z.boolean().optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const OutlineSectionSchema = z.object({
  id: z.string(),
  number: z.string(),
  title: z.string(),
  level: z.number().int().min(1).max(3),
  purpose: z.string(),
  requirementIds: z.array(z.string()),
  authorRole: z.enum(AUTHOR_ROLES),
  targetWords: z.number().int().positive().optional(),
  /** Harte Obergrenze aus der Kundenvorgabe (Seiten- oder Zeichenlimit), in Wörtern. */
  maxWords: z.number().int().positive().optional(),
});
export type OutlineSection = z.infer<typeof OutlineSectionSchema>;

export const SpecAnalysisSchema = z.object({
  summary: z.string(),
  language: z.enum(LANGUAGES),
  /** Formale Vorgaben des Kunden: Gliederung, Schriftgröße, Seitenlimit, Nachweise. */
  formalRules: z.array(z.string()),
  evaluationCriteria: z.array(z.string()),
  /** Begriffe des Kunden, die der Text übernehmen soll (z. B. „Auftraggeber" statt „Kunde"). */
  customerTerms: z.array(z.object({ term: z.string(), note: z.string() })),
  requirements: z.array(RequirementSchema),
  outline: z.array(OutlineSectionSchema),
});
export type SpecAnalysis = z.infer<typeof SpecAnalysisSchema>;

export const FactSchema = z.object({
  id: z.string(),
  statement: z.string(),
  sourceType: z.enum(['kb', 'web']),
  /** kb: Dokument-ID, web: URL */
  sourceRef: z.string(),
  sourceTitle: z.string(),
  quote: z.string().optional(),
  validUntil: z.string().nullable().optional(),
  /**
   * kb: das Zitat steht nachweislich im Fundstück. web: nur die Adresse stammt nachweislich aus der
   * Websuche, der Inhalt des Zitats ist nicht maschinell prüfbar.
   */
  quoteVerified: z.boolean().optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const CoverageItemSchema = z.object({
  requirementId: z.string(),
  status: z.enum(['covered', 'partial', 'missing']),
  sectionIds: z.array(z.string()),
  comment: z.string(),
});
export type CoverageItem = z.infer<typeof CoverageItemSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['blocker', 'major', 'minor']),
  kind: z.enum([
    'coverage',
    'open_point',
    'unsupported_claim',
    'length',
    'stale_source',
    'consistency',
    'style',
  ]),
  sectionId: z.string().optional(),
  requirementId: z.string().optional(),
  message: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CreateBidSchema = z.object({
  name: z.string().trim().min(1).max(200),
  customer: z.string().trim().min(1).max(200),
  deadline: isoDate.optional(),
  language: z.enum(LANGUAGES).default('de'),
  notes: z.string().max(4000).optional(),
});
export type CreateBid = z.infer<typeof CreateBidSchema>;

export const UserRoleSchema = z.enum(USER_ROLES);

/** Optionen je Dokument. */
export const BidDocumentOptionsSchema = z.object({
  /** Websuche für Recherche und Autoren zulassen. */
  allowWeb: z.boolean().default(true),
});
export type BidDocumentOptions = z.infer<typeof BidDocumentOptionsSchema>;
