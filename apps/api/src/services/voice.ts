import type { Config } from '../config.js';
import { HttpError } from './errors.js';
import type { OcrProvider } from './extract/index.js';

export interface SpeechToText {
  readonly available: boolean;
  transcribe(
    audio: Buffer,
    mime: string,
    language?: string,
  ): Promise<{ text: string; language: string | null }>;
}

export interface TextToSpeech {
  readonly available: boolean;
  /** Liefert die MP3-Daten als Datenstrom. */
  speak(text: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

type Fetch = typeof fetch;

/** Whisper läuft lokal im ML-Dienst (services/ml); das Audio verlässt das Haus nicht. */
export class MlSpeechToText implements SpeechToText {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  async transcribe(
    audio: Buffer,
    mime: string,
    language?: string,
  ): Promise<{ text: string; language: string | null }> {
    if (!this.baseUrl)
      throw new HttpError(503, 'Spracherkennung ist nicht eingerichtet: ML_SERVICE_URL fehlt.');
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }),
      'aufnahme',
    );
    if (language) form.append('language', language);
    const res = await this.fetchImpl(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok)
      throw new HttpError(502, `Spracherkennung fehlgeschlagen (ML-Dienst: HTTP ${res.status}).`);
    const body = (await res.json()) as { text: string; language?: string };
    return { text: body.text.trim(), language: body.language ?? null };
  }
}

export class ElevenLabsTextToSpeech implements TextToSpeech {
  constructor(
    private readonly options: Config['elevenLabs'],
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get available(): boolean {
    return Boolean(this.options.apiKey);
  }

  async speak(text: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    if (!this.options.apiKey)
      throw new HttpError(503, 'Sprachausgabe ist nicht eingerichtet: ELEVENLABS_API_KEY fehlt.');
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}/stream?output_format=mp3_44100_128`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.options.apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: this.options.modelId }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) {
      throw new HttpError(502, `Sprachausgabe fehlgeschlagen (ElevenLabs: HTTP ${res.status}).`);
    }
    return res.body;
  }
}

/** Texterkennung (OCR) für eingescannte PDFs und Bilder über den ML-Dienst. */
export class MlOcr implements OcrProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async ocr(buffer: Buffer, mime: string, filename: string): Promise<string[]> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);
    const res = await this.fetchImpl(`${this.baseUrl}/ocr`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok)
      throw new HttpError(502, `Texterkennung fehlgeschlagen (ML-Dienst: HTTP ${res.status}).`);
    return ((await res.json()) as { pages: string[] }).pages;
  }
}
