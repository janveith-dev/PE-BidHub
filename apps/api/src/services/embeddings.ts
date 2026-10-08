import { createHash } from 'node:crypto';
import type { Config } from '../config.js';

export type EmbedKind = 'passage' | 'query';

export interface Embedder {
  /** Kennung, die zu jedem Chunk gespeichert wird: Vektoren verschiedener Modelle sind nicht vergleichbar. */
  readonly name: string;
  readonly dim: number;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** Schneller 32-Bit-FNV-1a-Hash für das Feature-Hashing. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOPWORDS = new Set(
  'der die das und oder nicht mit für ist sind wird werden eine einer einen von zu im in auf den dem des als auch the and of to is are with for that this on be as by from or an a it at wir sie ihr'.split(' '),
);

/**
 * Lexikalisches Ersatz-Embedding ohne Modell: gewichtete Wörter, Wortpaare und
 * Zeichen-Trigramme werden per Feature-Hashing auf 384 Dimensionen verteilt.
 * Es findet ähnliche Wortformen („Rechenzentrum"/„Rechenzentren"), aber keine
 * Synonyme — für Entwicklung, Tests und den Betrieb ohne ML-Dienst.
 */
export class HashEmbedder implements Embedder {
  readonly name = 'hash-v1';
  constructor(readonly dim = 384) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const add = (feature: string, weight: number): void => {
      const h = fnv1a(feature);
      v[h % this.dim]! += (h & 0x80000000 ? -1 : 1) * weight;
    };
    const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).filter((w) => !STOPWORDS.has(w));
    words.forEach((w, i) => {
      add(`w:${w}`, 1);
      if (i > 0) add(`b:${words[i - 1]}_${w}`, 0.5);
      if (w.length >= 5) for (let j = 0; j <= w.length - 3; j++) add(`t:${w.slice(j, j + 3)}`, 0.25);
    });
    return normalize(v);
  }
}

/** Embeddings über den ML-Dienst (mehrsprachiges Satzmodell, siehe services/ml). */
export class MlEmbedder implements Embedder {
  readonly dim = 384;
  private servedModel: string | undefined;

  constructor(
    private readonly baseUrl: string,
    readonly name = 'ml-minilm-l12-v2',
  ) {}

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const res = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: texts.slice(i, i + 32), kind }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ML-Dienst /embed: HTTP ${res.status}`);
      const body = (await res.json()) as { embeddings: number[][]; model?: string; dim?: number };
      // Wechselt das Modell des Dienstes, wären neue und gespeicherte Vektoren nicht vergleichbar.
      if (body.model) {
        this.servedModel ??= body.model;
        if (body.model !== this.servedModel) {
          throw new Error(`Der ML-Dienst liefert jetzt das Modell ${body.model} statt ${this.servedModel}. Bitte neu einbetten (POST /api/admin/reindex) und ML_EMBED_ID anpassen.`);
        }
      }
      if (body.dim !== undefined && body.dim !== this.dim) {
        throw new Error(`Das Embedding-Modell liefert ${body.dim} statt ${this.dim} Dimensionen; die Datenbankspalte ist vector(${this.dim}).`);
      }
      out.push(...body.embeddings);
    }
    return out;
  }
}

export function createEmbedder(config: Pick<Config, 'mlServiceUrl' | 'embeddingDim' | 'mlEmbedId'>): Embedder {
  return config.mlServiceUrl ? new MlEmbedder(config.mlServiceUrl, config.mlEmbedId) : new HashEmbedder(config.embeddingDim);
}

export const contentHash = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
