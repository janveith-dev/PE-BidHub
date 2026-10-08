import path from 'node:path';

/**
 * Konfiguration aus Umgebungsvariablen. Alles hat einen Default, mit dem die
 * Anwendung ohne weitere Dienste startet (eingebettete Datenbank, Hash-Embeddings,
 * keine KI) — fehlende Schlüssel werden erst beim Aufruf der jeweiligen
 * Funktion gemeldet, nicht beim Start.
 */
export interface Config {
  port: number;
  host: string;
  corsOrigins: string[];
  /** postgres://… für Betrieb, sonst Verzeichnis für die eingebettete Datenbank ("memory" = flüchtig). */
  databaseUrl: string;
  dataDir: string;
  anthropicApiKey: string | undefined;
  models: {
    chat: string;
    writer: string;
    analyst: string;
    reviewer: string;
    editor: string;
    research: string;
  };
  /** Serverseitiger Refusal-Fallback der Claude-API (Opus/Sonnet 5.5). */
  refusalFallback: boolean;
  /** Domains, die die Websuche nie liefern darf (Wettbewerber). */
  webBlockedDomains: string[];
  mlServiceUrl: string | undefined;
  /** Kennung des Embedding-Modells, die zu jedem Chunk gespeichert wird. Zusammen mit EMBED_MODEL des ML-Dienstes ändern. */
  mlEmbedId: string;
  elevenLabs: { apiKey: string | undefined; voiceId: string; modelId: string };
  embeddingDim: number;
  /** Absender in Deckblatt und Dokumenteigenschaften. */
  companyName: string;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  return {
    port: Number.parseInt(env.PORT ?? '3000', 10),
    host: env.HOST ?? '0.0.0.0',
    corsOrigins: list(env.CORS_ORIGINS ?? 'http://localhost:5173'),
    databaseUrl: env.DATABASE_URL ?? path.join(dataDir, 'pglite'),
    dataDir,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    models: {
      chat: env.MODEL_CHAT ?? 'claude-sonnet-5-5',
      research: env.MODEL_RESEARCH ?? 'claude-sonnet-5-5',
      editor: env.MODEL_EDITOR ?? 'claude-sonnet-5-5',
      analyst: env.MODEL_ANALYST ?? 'claude-opus-5-5',
      writer: env.MODEL_WRITER ?? 'claude-opus-5-5',
      reviewer: env.MODEL_REVIEWER ?? 'claude-opus-5-5',
    },
    refusalFallback: env.LLM_REFUSAL_FALLBACK !== '0',
    webBlockedDomains: list(env.WEB_BLOCKED_DOMAINS),
    mlServiceUrl: env.ML_SERVICE_URL || undefined,
    mlEmbedId: env.ML_EMBED_ID ?? 'ml-minilm-l12-v2',
    elevenLabs: {
      apiKey: env.ELEVENLABS_API_KEY || undefined,
      voiceId: env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb',
      modelId: env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2',
    },
    embeddingDim: 384,
    companyName: env.COMPANY_NAME ?? 'public edge GmbH',
  };
}
