import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../services/errors.js';

const SpeakSchema = z.object({ text: z.string().trim().min(1).max(1500) });

export async function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Aufnahmen kommen als rohe Audiodaten (MediaRecorder), nicht als Formular.
  app.addContentTypeParser(/^(audio|video)\/.*/, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/api/capabilities', async () => ({
    llm: Boolean(ctx.config.anthropicApiKey),
    speechToText: ctx.stt.available,
    textToSpeech: ctx.tts.available,
    ocr: Boolean(ctx.ocr),
    embedding: ctx.embedder.name,
  }));

  app.post('/api/voice/transcribe', async (req) => {
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 100) throw badRequest('Keine Audioaufnahme übertragen.');
    const { language } = z.object({ language: z.enum(['de', 'en']).optional() }).parse(req.query);
    return ctx.stt.transcribe(audio, String(req.headers['content-type'] ?? ''), language);
  });

  app.post('/api/voice/speak', async (req, reply) => {
    const { text } = SpeakSchema.parse(req.body);
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    const stream = await ctx.tts.speak(text, abort.signal);
    return reply.type('audio/mpeg').header('cache-control', 'no-store').send(Readable.fromWeb(stream as unknown as NodeWebStream));
  });
}
