import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './services/embeddings.js';
import type { OcrProvider } from './services/extract/index.js';
import type { Llm } from './services/llm/index.js';
import type { SpeechToText, TextToSpeech } from './services/voice.js';

/** Alles, was Routen und Dienste brauchen — wird in Tests durch Ersatzobjekte ersetzt. */
export interface AppContext {
  config: Config;
  db: Db;
  embedder: Embedder;
  llm: Llm;
  ocr?: OcrProvider | undefined;
  stt: SpeechToText;
  tts: TextToSpeech;
}
