import type {
  BidDocumentOptions,
  BidDocumentStatus,
  ChatSource,
  CoverageItem,
  Fact,
  Finding,
  SectionStatus,
  SpecAnalysis,
} from './index.js';

// Antwortformen der API. Server und Oberfläche teilen sie, damit sie nicht auseinanderlaufen.

export interface SectionDto {
  id: string;
  ordinal: number;
  outlineId: string;
  number: string;
  title: string;
  level: number;
  purpose: string;
  requirementIds: string[];
  authorRole: string;
  targetWords: number | null;
  maxWords: number | null;
  status: SectionStatus;
  facts: Fact[];
  content: string;
  notes: string;
  version: number;
  lastAuthor: string;
  wordCount: number;
  updatedAt: string;
}

export interface BidDocumentDto {
  id: string;
  bidId: string;
  title: string;
  status: BidDocumentStatus;
  error: string | null;
  options: BidDocumentOptions;
  analysis: SpecAnalysis | null;
  outlineApprovedAt: string | null;
  coverage: CoverageItem[] | null;
  findings: Finding[] | null;
  reviewSummary: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BidDocumentDetailDto extends BidDocumentDto {
  specText: string;
  running: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  sections: SectionDto[];
}

export interface BidDto {
  id: string;
  name: string;
  customer: string;
  deadline: string | null;
  language: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  document_count?: number;
}

export interface AgentEventDto {
  id: number;
  sectionId: string | null;
  agent: string;
  kind: 'info' | 'tool' | 'result' | 'error' | 'gate';
  message: string;
  data: unknown;
  createdAt: string;
}

export interface TemplateDto {
  id: string;
  name: string;
  filename: string;
  isDefault: boolean;
  builtin: boolean;
}

export interface SectionVersionDto {
  id: string;
  version: number;
  content: string;
  author: string;
  created_at: string;
}

export interface ChatSessionDto {
  id: string;
  title: string;
  role: string | null;
  updated_at: string;
}

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSource[];
  created_at: string;
}

export interface CapabilitiesDto {
  llm: boolean;
  speechToText: boolean;
  textToSpeech: boolean;
  ocr: boolean;
  embedding: string;
}
