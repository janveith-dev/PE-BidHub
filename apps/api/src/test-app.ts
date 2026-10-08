import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { loadConfig } from './config.js';
import { openTestDb } from './test-db.js';
import { HashEmbedder } from './services/embeddings.js';
import { FakeLlm } from './services/llm/index.js';
import { buildServer } from './server.js';
import type { SpeechToText, TextToSpeech } from './services/voice.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  llm: FakeLlm;
  close(): Promise<void>;
}

type LlmHandler = ConstructorParameters<typeof FakeLlm>[0];

export const fakeStt: SpeechToText & { calls: { mime: string; language?: string | undefined }[] } =
  {
    available: true,
    calls: [],
    async transcribe(_audio, mime, language) {
      this.calls.push({ mime, language });
      return { text: 'Welche Zertifikate haben wir?', language: 'de' };
    },
  };

export const fakeTts: TextToSpeech & { spoken: string[] } = {
  available: true,
  spoken: [],
  async speak(text) {
    this.spoken.push(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]));
        controller.close();
      },
    });
  },
};

export async function makeTestApp(
  handler: LlmHandler = async () => ({ text: 'ok' }),
): Promise<TestApp> {
  process.env.NODE_ENV = 'test';
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bidhub-app-'));
  const db = await openTestDb();
  const llm = new FakeLlm(handler);
  const ctx: AppContext = {
    config: { ...loadConfig({ DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test' }), dataDir },
    db,
    embedder: new HashEmbedder(),
    llm,
    stt: fakeStt,
    tts: fakeTts,
  };
  const app = await buildServer(ctx);
  return {
    app,
    ctx,
    llm,
    close: async () => {
      await app.close();
      await db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function multipart(
  fields: Record<string, string>,
  file?: { name: string; type: string; content: Buffer },
) {
  const boundary = '----bidhubtest';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export function ndjson(body: string): Record<string, unknown>[] {
  return body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
