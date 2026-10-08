/**
 * Mikrofonaufnahme mit Sprecherkennung (Voice Activity Detection) im Browser.
 *
 * Statt MediaRecorder (Codecs und Container unterscheiden sich je Browser, und ein fortlaufender Strom lässt
 * sich nicht rückwirkend anschneiden) werden Roh-Samples über ein AudioWorklet gelesen. Das erlaubt einen
 * Vorlauf: Die 300 ms vor dem erkannten Sprechbeginn gehören zur Aufnahme, sonst fehlt der erste Laut.
 * Das Ergebnis ist 16-kHz-Mono-WAV, das der ML-Dienst direkt versteht.
 */

export interface VadOptions {
  /** Untergrenze der Lautstärke-Schwelle (RMS, 0–1). */
  minThreshold: number;
  /** Schwelle = Grundrauschen × Faktor. */
  noiseFactor: number;
  startMs: number;
  endSilenceMs: number;
  minSpeechMs: number;
  maxSpeechMs: number;
  preRollMs: number;
  /** Zu Beginn wird das Grundrauschen des Raumes gemessen; in dieser Zeit wird nicht auf Sprache reagiert. */
  calibrateMs: number;
  /** Obergrenze der Kalibrierung: Wer schon während der Messung spricht, soll das Mikrofon nicht taub schalten. */
  maxNoise: number;
}

export const DEFAULT_VAD: VadOptions = {
  minThreshold: 0.012,
  noiseFactor: 3,
  startMs: 80,
  endSilenceMs: 1000,
  minSpeechMs: 350,
  maxSpeechMs: 30_000,
  preRollMs: 300,
  calibrateMs: 400,
  maxNoise: 0.04,
};

export interface RecorderHandlers {
  onLevel?: (level: number) => void;
  /** Die Messung des Grundrauschens ist abgeschlossen; ab jetzt wird auf Sprache gehört. */
  onReady?: () => void;
  onSpeechStart?: () => void;
  onUtterance: (wav: Blob, speechMs: number) => void;
  onError?: (error: Error) => void;
}

const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('bid-capture', Capture);
`;

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Mittelt je Zielsample ein Fenster der Quelle (einfacher Tiefpass gegen Aliasing). */
export function downsample(samples: Float32Array, fromRate: number, toRate = 16_000): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]!;
    out[i] = sum / (end - start);
  }
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Zustandsautomat der Sprecherkennung, getrennt vom Browser-Audio, damit er testbar bleibt. */
export class VadDetector {
  private state: 'idle' | 'speech' = 'idle';
  private noise = 0.005;
  private calibratedMs = 0;
  private calibrationSum = 0;
  private speechRunMs = 0;
  private preRoll: { data: Float32Array; ms: number }[] = [];
  private preRollMs = 0;
  private utter: Float32Array[] = [];
  private voicedMs = 0;
  private silenceMs = 0;
  private totalMs = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly opts: VadOptions,
    private readonly cb: {
      onSpeechStart: () => void;
      onUtterance: (samples: Float32Array, voicedMs: number) => void;
    },
  ) {}

  /** false, solange das Grundrauschen noch gemessen wird. */
  get ready(): boolean {
    return this.calibratedMs >= this.opts.calibrateMs;
  }

  get threshold(): number {
    return Math.max(this.opts.minThreshold, this.noise * this.opts.noiseFactor);
  }

  reset(): void {
    this.state = 'idle';
    this.speechRunMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
    this.utter = [];
    this.voicedMs = this.silenceMs = this.totalMs = 0;
  }

  /** Verarbeitet einen Block Samples und liefert dessen Lautstärke. */
  feed(chunk: Float32Array): number {
    const level = rms(chunk);
    const ms = (chunk.length / this.sampleRate) * 1000;

    // Ein Raum, der von Anfang an lauter ist als die Startschätzung (Lüfter, Großraumbüro), würde sonst dauerhaft
    // als Sprache gelten: Das Grundrauschen passt sich nur an, solange nichts als Sprache gilt.
    if (this.calibratedMs < this.opts.calibrateMs) {
      this.calibrationSum += level * ms;
      this.calibratedMs += ms;
      this.noise = Math.min(
        this.opts.maxNoise,
        Math.max(0.001, this.calibrationSum / this.calibratedMs),
      );
      return level;
    }

    if (this.state === 'idle') {
      const loud = level > this.threshold;
      if (!loud) this.noise = this.noise * 0.97 + level * 0.03;
      this.speechRunMs = loud ? this.speechRunMs + ms : 0;

      this.preRoll.push({ data: chunk, ms });
      this.preRollMs += ms;
      while (this.preRollMs > this.opts.preRollMs && this.preRoll.length > 1)
        this.preRollMs -= this.preRoll.shift()!.ms;

      if (this.speechRunMs >= this.opts.startMs) {
        this.state = 'speech';
        this.utter = this.preRoll.map((p) => p.data);
        this.totalMs = this.preRollMs;
        this.voicedMs = this.speechRunMs;
        this.silenceMs = 0;
        this.preRoll = [];
        this.preRollMs = 0;
        this.cb.onSpeechStart();
      }
      return level;
    }

    this.utter.push(chunk);
    this.totalMs += ms;
    // Hysterese: Innerhalb einer Äußerung reicht eine niedrigere Schwelle, damit leise Wortenden nicht abreißen.
    if (level > this.threshold * 0.7) {
      this.voicedMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
    }
    if (this.silenceMs >= this.opts.endSilenceMs || this.totalMs >= this.opts.maxSpeechMs) {
      const samples = concat(this.utter);
      const voiced = this.voicedMs;
      this.reset();
      if (voiced >= this.opts.minSpeechMs) this.cb.onUtterance(samples, voiced);
    }
    return level;
  }
}

export class VadRecorder {
  private stream: MediaStream | undefined;
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private detector: VadDetector | undefined;
  private paused = false;
  private announcedReady = false;

  constructor(
    private readonly handlers: RecorderHandlers,
    private readonly opts: VadOptions = DEFAULT_VAD,
  ) {}

  get active(): boolean {
    return this.ctx !== undefined;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Dieser Browser bietet keinen Mikrofonzugriff (HTTPS oder localhost nötig).');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      const name = (e as DOMException).name;
      throw new Error(
        name === 'NotAllowedError'
          ? 'Der Zugriff auf das Mikrofon wurde verweigert. Bitte im Browser erlauben.'
          : name === 'NotFoundError'
            ? 'Es wurde kein Mikrofon gefunden.'
            : `Mikrofon nicht verfügbar: ${(e as Error).message}`,
      );
    }
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    await this.ctx.resume();

    const rate = this.ctx.sampleRate;
    this.detector = new VadDetector(rate, this.opts, {
      onSpeechStart: () => this.handlers.onSpeechStart?.(),
      onUtterance: (samples, voicedMs) => {
        try {
          this.handlers.onUtterance(encodeWav(downsample(samples, rate), 16_000), voicedMs);
        } catch (e) {
          this.handlers.onError?.(e as Error);
        }
      },
    });
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'bid-capture');
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.paused || !this.detector) return;
      const level = this.detector.feed(e.data);
      if (!this.announcedReady && this.detector.ready) {
        this.announcedReady = true;
        this.handlers.onReady?.();
      }
      this.handlers.onLevel?.(Math.min(1, level * 8));
    };
    source.connect(this.node); // bewusst nicht an die Ausgabe: Das Mikrofon soll nicht mitlaufen.
  }

  /** Während die Anwendung spricht oder denkt, wird nicht zugehört — sonst hört sie sich selbst. */
  pause(): void {
    this.paused = true;
    this.detector?.reset();
    this.handlers.onLevel?.(0);
  }

  resume(): void {
    this.detector?.reset();
    this.paused = false;
  }

  stop(): void {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = this.stream = this.ctx = this.detector = undefined;
    this.handlers.onLevel?.(0);
  }
}
