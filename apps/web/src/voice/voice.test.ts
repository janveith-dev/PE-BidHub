import { describe, expect, it } from 'vitest';
import { DEFAULT_VAD, VadDetector, downsample, encodeWav, rms } from './recorder';
import { plainSpeech, splitForSpeech } from './speaker';
import { isUsableTranscript } from './useVoice';

const RATE = 16_000;
const block = (amplitude: number, ms = 64): Float32Array => {
  const n = Math.round((RATE * ms) / 1000);
  // Sinus statt Gleichspannung: Die Lautstärke (RMS) entspricht dann amplitude/√2.
  return Float32Array.from(
    { length: n },
    (_, i) => amplitude * Math.sin((i / RATE) * 2 * Math.PI * 220),
  );
};

function run(sequence: [amplitude: number, blocks: number][]) {
  const events: string[] = [];
  const utterances: { samples: Float32Array; voicedMs: number }[] = [];
  const vad = new VadDetector(RATE, DEFAULT_VAD, {
    onSpeechStart: () => events.push('start'),
    onUtterance: (samples, voicedMs) => {
      events.push('utterance');
      utterances.push({ samples, voicedMs });
    },
  });
  for (const [amplitude, n] of sequence) for (let i = 0; i < n; i++) vad.feed(block(amplitude));
  return { events, utterances, vad };
}

describe('Sprecherkennung', () => {
  it('erkennt eine Äußerung und liefert sie nach der Schlusspause', () => {
    const { events, utterances } = run([
      [0.002, 20],
      [0.3, 20],
      [0.002, 20],
    ]);
    expect(events).toEqual(['start', 'utterance']);
    expect(utterances[0]!.voicedMs).toBeGreaterThan(1000);
  });

  it('nimmt den Vorlauf vor dem Sprechbeginn mit, damit der erste Laut nicht fehlt', () => {
    const { utterances } = run([
      [0.002, 20],
      [0.3, 20],
      [0.002, 20],
    ]);
    const samples = utterances[0]!.samples;
    const ms = (n: number) => Math.round((RATE * n) / 1000);
    // Die Aufnahme beginnt mit Stille (Vorlauf) und enthält danach die komplette Sprache.
    expect(rms(samples.slice(0, ms(60)))).toBeLessThan(0.01);
    expect(rms(samples.slice(ms(300), ms(900)))).toBeGreaterThan(0.1);
    // Sprache (1280 ms) + Schlusspause (≥ 1000 ms) + mindestens ca. 100 ms Stille davor
    expect((samples.length / RATE) * 1000).toBeGreaterThan(1280 + 1000 + 100);
  });

  it('ignoriert kurze Geräusche unter der Mindestlänge', () => {
    const { events } = run([
      [0.002, 10],
      [0.3, 1],
      [0.002, 40],
    ]);
    expect(events).not.toContain('utterance');
  });

  it('wirft eine Äußerung weg, die zu kurz war, auch wenn sie erkannt wurde', () => {
    const { events } = run([
      [0.002, 10],
      [0.3, 3],
      [0.002, 40],
    ]); // ≈ 190 ms Sprache < 350 ms
    expect(events).toEqual(['start']);
  });

  it('passt die Schwelle an ein lautes Grundrauschen an', () => {
    const quiet = run([[0.002, 30]]).vad.threshold;
    const noisy = run([[0.03, 30]]).vad.threshold;
    expect(noisy).toBeGreaterThan(quiet * 3);
  });

  it('hält gleichbleibendes Rauschen nicht für Sprache und erkennt Sprache darüber trotzdem', () => {
    // Ein Lüfter, der von Anfang an läuft: ohne Kalibrierung gälte er dauerhaft als Sprache.
    const { events } = run([
      [0.03, 60],
      [0.4, 20],
      [0.03, 25],
    ]);
    expect(events).toEqual(['start', 'utterance']);
    expect(run([[0.03, 100]]).events).toEqual([]);
  });

  it('schaltet das Mikrofon nicht taub, wenn schon während der Messung gesprochen wird', () => {
    const { vad } = run([[0.4, 8]]);
    expect(vad.threshold).toBeLessThanOrEqual(
      DEFAULT_VAD.maxNoise * DEFAULT_VAD.noiseFactor + 1e-9,
    );
  });

  it('beendet sehr lange Äußerungen nach der Höchstdauer', () => {
    const events: string[] = [];
    const vad = new VadDetector(
      RATE,
      { ...DEFAULT_VAD, maxSpeechMs: 2000 },
      { onSpeechStart: () => events.push('start'), onUtterance: () => events.push('utterance') },
    );
    for (let i = 0; i < 60; i++) vad.feed(block(0.3));
    expect(events.filter((e) => e === 'utterance').length).toBeGreaterThanOrEqual(1);
  });

  it('schneidet nach dem Zurücksetzen nicht mit alten Daten an (z. B. nach dem Sprechen der Antwort)', () => {
    const events: string[] = [];
    const vad = new VadDetector(RATE, DEFAULT_VAD, {
      onSpeechStart: () => events.push('start'),
      onUtterance: () => events.push('utterance'),
    });
    for (let i = 0; i < 10; i++) vad.feed(block(0.002)); // Kalibrierung
    for (let i = 0; i < 10; i++) vad.feed(block(0.3));
    vad.reset();
    for (let i = 0; i < 30; i++) vad.feed(block(0.002));
    expect(events).toEqual(['start']);
  });
});

describe('Audio-Aufbereitung', () => {
  it('rechnet 48 kHz auf 16 kHz herunter und erhält die Dauer', () => {
    const src = Float32Array.from({ length: 48_000 }, (_, i) =>
      Math.sin((i / 48_000) * 2 * Math.PI * 440),
    );
    const out = downsample(src, 48_000, 16_000);
    expect(out.length).toBe(16_000);
    expect(rms(out)).toBeCloseTo(rms(src), 1);
  });

  it('lässt 16 kHz unverändert', () => {
    const s = new Float32Array([0.1, 0.2]);
    expect(downsample(s, 16_000)).toBe(s);
  });

  it('schreibt ein gültiges WAV: Kopfdaten, Länge, Begrenzung der Aussteuerung', async () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 16_000);
    expect(wav.type).toBe('audio/wav');
    const view = new DataView(await wav.arrayBuffer());
    expect(String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(i)))).toBe('RIFF');
    expect(String.fromCharCode(...[8, 9, 10, 11].map((i) => view.getUint8(i)))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000); // Abtastrate
    expect(view.getUint16(22, true)).toBe(1); // Mono
    expect(view.getUint32(40, true)).toBe(10); // 5 Samples × 2 Byte
    expect(wav.size).toBe(44 + 10);
    expect(view.getInt16(44 + 3 * 2, true)).toBe(32767); // 2.0 wird auf Vollaussteuerung begrenzt
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-32768);
  });
});

describe('Vorlesen', () => {
  it('entfernt Quellenmarken, Markdown und Adressen', () => {
    const text = plainSpeech(
      '## Zertifikate\n\nWir sind **ISO 27001** zertifiziert [Q1]. Siehe [Details](https://example.org/x) und https://example.org.\n\n- Punkt eins\n- Punkt zwei [F2]',
    );
    expect(text).not.toMatch(/\[Q1\]|\[F2\]|\*\*|##|https?:|- /);
    expect(text).toContain('Wir sind ISO 27001 zertifiziert.');
    expect(text).toContain('Details');
    expect(text).toContain('Punkt eins');
  });

  it('liest offene Punkte und Code nicht vor', () => {
    expect(plainSpeech('Text [OFFEN: Werkzeuge nennen] weiter ```code``` Ende')).toBe(
      'Text weiter Ende',
    );
  });

  it('teilt an Satzenden in Stücke und verliert nichts', () => {
    const text =
      'Erster Satz. Zweiter Satz! Dritte Frage? ' + 'Ein langer Satz ohne Ende '.repeat(30);
    const chunks = splitForSpeech(text, 120);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain(
      'Erster Satz. Zweiter Satz! Dritte Frage?',
    );
    expect(chunks[0]!.startsWith('Erster Satz.')).toBe(true);
  });

  it('gibt für leeren Text nichts zurück', () => {
    expect(splitForSpeech('')).toEqual([]);
    expect(plainSpeech('   ')).toBe('');
  });
});

describe('Whisper-Ausgaben', () => {
  it('verwirft die bekannten Erfindungen bei Rauschen', () => {
    for (const t of [
      'Untertitel der Amara.org-Community',
      'Vielen Dank fürs Zuschauen!',
      'Thanks for watching',
      'www.mooji.org',
      '',
      ' a ',
    ]) {
      expect(isUsableTranscript(t)).toBe(false);
    }
  });
  it('lässt echte Fragen durch', () => {
    expect(isUsableTranscript('Welche Zertifikate hat public edge?')).toBe(true);
  });
});
