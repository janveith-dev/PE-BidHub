import type { ChatSource } from '@bid/shared';
import { getRole } from './role';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function failure(res: Response): Promise<ApiError> {
  let message = `Anfrage fehlgeschlagen (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* keine JSON-Antwort */
  }
  return new ApiError(res.status, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    headers: {
      'x-role': getRole(),
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
  });
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: (path: string) => request<void>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

/** Roh-Audio an die Spracherkennung. */
export async function transcribe(
  audio: Blob,
  language?: 'de' | 'en',
): Promise<{ text: string; language: string | null }> {
  const res = await fetch(`/api/voice/transcribe${language ? `?language=${language}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': audio.type || 'audio/wav', 'x-role': getRole() },
    body: audio,
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as { text: string; language: string | null };
}

/** MP3 für einen Textabschnitt von ElevenLabs (über die API, damit der Schlüssel serverseitig bleibt). */
export async function speak(text: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-role': getRole() },
    body: JSON.stringify({ text }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await failure(res);
  return res.blob();
}

export type ChatEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; delta: string }
  | { type: 'status'; message: string }
  | { type: 'sources'; sources: ChatSource[] }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; message: string };

/** Liest den NDJSON-Strom des Chats Zeile für Zeile. */
export async function* streamChat(
  body: { sessionId?: string | undefined; message: string; spoken: boolean },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-role': getRole() },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw await failure(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as ChatEvent;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as ChatEvent;
}
