import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribe } from '../api';
import { VadRecorder } from './recorder';
import { Speaker, plainSpeech } from './speaker';

export type DialogState =
  'off' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

/** Whisper erfindet bei Rauschen gelegentlich Standardsätze aus seinen Trainingsdaten. Solche Treffer sind keine Frage. */
const HALLUCINATIONS =
  /^(untertitel|vielen dank (fürs|für das) (zuschauen|zuhören)|thanks for watching|bis zum nächsten mal|copyright|www\.)/i;
export const isUsableTranscript = (text: string): boolean =>
  text.trim().length >= 2 && !HALLUCINATIONS.test(text.trim());

interface DialogOptions {
  language: 'de' | 'en';
  /** Antworten vorlesen (ElevenLabs konfiguriert)? */
  speakReplies: boolean;
  /** Verarbeitet eine erkannte Äußerung (sendet sie an den Chat) und liefert den Antworttext zurück. */
  onUserText: (text: string) => Promise<string>;
}

/**
 * Vollständiger Sprachdialog: zuhören → erkennen (Whisper) → antworten (Claude) → vorlesen (ElevenLabs) → zuhören …
 * Beim Denken und Sprechen ist das Mikrofon pausiert; „Unterbrechen" bricht das Vorlesen ab.
 */
export function useVoiceDialog(options: DialogOptions) {
  const [state, setState] = useState<DialogState>('off');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<VadRecorder | undefined>(undefined);
  const speaker = useRef(new Speaker());
  const opts = useRef(options);
  opts.current = options;
  const active = useRef(false);

  const stop = useCallback(() => {
    active.current = false;
    recorder.current?.stop();
    recorder.current = undefined;
    speaker.current.stop();
    setState('off');
    setLevel(0);
  }, []);

  const handleUtterance = useCallback(async (wav: Blob) => {
    const rec = recorder.current;
    if (!rec || !active.current) return;
    rec.pause();
    try {
      setState('transcribing');
      const { text } = await transcribe(wav, opts.current.language);
      if (!active.current) return;
      if (isUsableTranscript(text)) {
        setState('thinking');
        const answer = await opts.current.onUserText(text.trim());
        if (active.current && opts.current.speakReplies && answer.trim()) {
          setState('speaking');
          await speaker.current.speak(plainSpeech(answer));
        }
      }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (active.current) {
        rec.resume();
        setState('listening');
      }
    }
  }, []);

  const start = useCallback(async () => {
    if (active.current) return;
    setError(null);
    const rec = new VadRecorder({
      onLevel: setLevel,
      onSpeechStart: () => setState('hearing'),
      onUtterance: (wav) => void handleUtterance(wav),
      onError: (e) => setError(e.message),
    });
    try {
      await rec.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    recorder.current = rec;
    active.current = true;
    setState('listening');
  }, [handleUtterance]);

  const interrupt = useCallback(() => speaker.current.stop(), []);
  useEffect(() => stop, [stop]);

  return { state, level, error, start, stop, interrupt, active: state !== 'off' };
}

/** Diktat: eine Äußerung aufnehmen, erkennen und als Text zurückgeben (zum Prüfen vor dem Senden). */
export function useDictation(onText: (text: string) => void, language: 'de' | 'en') {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<VadRecorder | undefined>(undefined);
  const cb = useRef(onText);
  cb.current = onText;

  const stop = useCallback(() => {
    recorder.current?.stop();
    recorder.current = undefined;
    setRecording(false);
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const rec = new VadRecorder({
      onLevel: setLevel,
      onUtterance: (wav) => {
        stop();
        setBusy(true);
        transcribe(wav, language)
          .then(({ text }) => isUsableTranscript(text) && cb.current(text.trim()))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      },
      onError: (e) => setError(e.message),
    });
    try {
      await rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [language, stop]);

  useEffect(() => stop, [stop]);
  return { recording, busy, level, error, toggle: () => (recording ? stop() : void start()) };
}
