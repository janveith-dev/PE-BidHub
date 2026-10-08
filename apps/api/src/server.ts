import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Anthropic from '@anthropic-ai/sdk';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { createEmbedder } from './services/embeddings.js';
import { createLlm, LlmOutputError, LlmRefusalError } from './services/llm/index.js';
import { ElevenLabsTextToSpeech, MlOcr, MlSpeechToText } from './services/voice.js';

export async function createContext(config = loadConfig()): Promise<AppContext> {
  const db = await openDb(config.databaseUrl);
  await migrate(db);
  return {
    config,
    db,
    embedder: createEmbedder(config),
    llm: createLlm(config),
    ocr: config.mlServiceUrl ? new MlOcr(config.mlServiceUrl) : undefined,
    stt: new MlSpeechToText(config.mlServiceUrl),
    tts: new ElevenLabsTextToSpeech(config.elevenLabs),
  };
}

/** Übersetzt Fehler in Status und eine Meldung, die Anwender verstehen. Details gehören ins Log. */
export function describeError(error: unknown): { status: number; message: string } {
  if (error instanceof ZodError) return { status: 400, message: z.prettifyError(error) };
  if (error instanceof LlmRefusalError) return { status: 422, message: error.message };
  if (error instanceof LlmOutputError) return { status: 502, message: error.message };
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 502;
    if (status === 401 || status === 403) return { status: 502, message: 'Die Anthropic-API hat den API-Schlüssel abgelehnt.' };
    if (status === 429) return { status: 429, message: 'Das Anfragelimit der Anthropic-API ist erreicht. Bitte kurz warten und erneut versuchen.' };
    if (status >= 500) return { status: 503, message: 'Die Anthropic-API ist gerade überlastet oder nicht erreichbar.' };
    return { status: 502, message: `Die Anthropic-API hat die Anfrage abgelehnt: ${error.message}` };
  }
  const e = error as FastifyError & { status?: number };
  const status = e.statusCode ?? (typeof e.status === 'number' ? e.status : 500);
  if (status >= 400 && status < 500) return { status, message: e.message };
  if (e.name === 'HttpError') return { status, message: e.message };
  return { status: 500, message: 'Interner Serverfehler' };
}

export async function buildServer(ctx: AppContext) {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            transport:
              process.env.NODE_ENV === 'production'
                ? undefined
                : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
          },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, { origin: ctx.config.corsOrigins });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 20 } });

  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  await registerDocumentRoutes(app, ctx);
  await registerChatRoutes(app, ctx);
  await registerVoiceRoutes(app, ctx);

  app.setErrorHandler((error: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    const { status, message } = describeError(error);
    if (status >= 500) app.log.error(error);
    return reply.status(status).send({ error: message });
  });

  return app;
}

async function main(): Promise<void> {
  const ctx = await createContext();
  const app = await buildServer(ctx);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} empfangen — fahre herunter`);
    await app.close();
    await ctx.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: ctx.config.port, host: ctx.config.host });
}

// Nur starten, wenn direkt aufgerufen — Tests importieren `buildServer`.
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
