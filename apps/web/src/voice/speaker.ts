import { speak as fetchSpeech } from '../api';

/** Befreit Antworttext von allem, was man nicht vorlesen will: Quellenmarken, Markdown, Adressen. */
export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(?:Q|F)\d+\]/g, '')
    .replace(/\[OFFEN:[^\]]*\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_`>|~]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Teilt an Satzenden in Stücke bis `maxLen` Zeichen: Das erste Stück kommt schnell, die übrigen werden vorab geladen. */
export function splitForSpeech(text: string, maxLen = 280): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen));
    } else if (current && current.length + s.length + 1 > maxLen) {
      chunks.push(current);
      current = s;
    } else current = current ? `${current} ${s}` : s;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class Speaker {
  private abort: AbortController | undefined;
  private audio: HTMLAudioElement | undefined;
  private finishCurrent: (() => void) | undefined;

  get speaking(): boolean {
    return this.abort !== undefined && !this.abort.signal.aborted;
  }

  /** Spricht den Text; kehrt zurück, wenn er zu Ende gesprochen oder mit stop() abgebrochen wurde. */
  async speak(text: string): Promise<void> {
    const chunks = splitForSpeech(text);
    if (!chunks.length) return;
    this.stop();
    const abort = (this.abort = new AbortController());

    const fetched: Promise<Blob>[] = [];
    const get = (i: number): Promise<Blob> => {
      fetched[i] ??= fetchSpeech(chunks[i]!, abort.signal);
      fetched[i]!.catch(() => undefined); // abgebrochenes Vorabladen soll keine unbehandelte Ablehnung erzeugen
      return fetched[i]!;
    };

    try {
      for (let i = 0; i < chunks.length && !abort.signal.aborted; i++) {
        const current = get(i);
        if (i + 1 < chunks.length) get(i + 1); // nächstes Stück laden, während dieses läuft
        const blob = await current;
        if (abort.signal.aborted) break;
        await this.play(blob);
      }
    } catch (e) {
      if (!abort.signal.aborted) throw e;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private play(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    const audio = (this.audio = new Audio(url));
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        URL.revokeObjectURL(url);
        this.finishCurrent = undefined;
        resolve();
      };
      this.finishCurrent = done;
      audio.onended = done;
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Die Sprachausgabe konnte nicht abgespielt werden.'));
      };
      audio.play().catch((e: unknown) => {
        URL.revokeObjectURL(url);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.audio?.pause();
    this.finishCurrent?.();
  }
}
