import type { FastifyInstance } from 'fastify';
import { ChatRequestSchema } from '@bid/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { chatTurn, deleteSession, getSession, listSessions } from '../services/chat.js';
import { roleOf } from './helpers.js';

export async function registerChatRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/chat/sessions', async () => listSessions(ctx.db));
  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) =>
    getSession(ctx.db, z.uuid().parse(req.params.id)),
  );
  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req, reply) => {
    await deleteSession(ctx.db, z.uuid().parse(req.params.id));
    return reply.status(204).send();
  });

  /**
   * Antwort als NDJSON-Strom, eine JSON-Zeile je Ereignis:
   * session → text* → (tool|web)* → sources → done, bei Fehlern `error`.
   */
  app.post('/api/chat', async (req, reply) => {
    const body = ChatRequestSchema.parse(req.body);
    const role = roleOf(req);

    reply.hijack();
    const raw = reply.raw;
    // hijack() umgeht reply.send; bereits gesetzte Header (CORS) müssen von Hand mitgegeben werden.
    const inherited: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) inherited[name] = value;
    raw.writeHead(200, {
      ...inherited,
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      // Verhindert, dass nginx den Strom puffert.
      'x-accel-buffering': 'no',
    });
    const send = (event: Record<string, unknown>): void => {
      if (!raw.writableEnded) raw.write(`${JSON.stringify(event)}\n`);
    };

    const abort = new AbortController();
    raw.on('close', () => abort.abort());

    try {
      const result = await chatTurn(
        ctx,
        { ...body, role, signal: abort.signal },
        {
          onSession: (id) => send({ type: 'session', id }),
          onText: (delta) => send({ type: 'text', delta }),
          onEvent: (e) => {
            if (e.type === 'tool_call')
              send({ type: 'status', message: 'Durchsuche die Wissensbasis …' });
          },
        },
      );
      send({ type: 'sources', sources: result.sources });
      send({ type: 'done', sessionId: result.sessionId });
    } catch (error) {
      if (!abort.signal.aborted) {
        app.log.error(error);
        send({ type: 'error', message: errorMessage(error) });
      }
    } finally {
      raw.end();
    }
  });
}

function errorMessage(error: unknown): string {
  const status = (error as { status?: number }).status;
  if (status && status < 500) return (error as Error).message;
  if (error instanceof Error && error.name === 'HttpError') return error.message;
  return 'Die Antwort konnte nicht erzeugt werden. Bitte später erneut versuchen.';
}
