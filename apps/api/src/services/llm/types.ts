import type { z } from 'zod';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Ein Werkzeug, das der Agent aufrufen darf. Die Eingabe wird vor dem Aufruf gegen das Schema geprüft. */
export interface AgentTool<T = never> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  /** Ergebnistext für das Modell; ein geworfener Fehler wird als Werkzeugfehler zurückgemeldet. */
  run(input: T): Promise<string>;
}

/** Fasst ein typisiertes Werkzeug zu dem einheitlichen Typ zusammen, den `AgentRequest.tools` erwartet. */
export function defineTool<T>(tool: AgentTool<T>): AgentTool<never> {
  return tool as unknown as AgentTool<never>;
}

export interface WebSource {
  url: string;
  title: string;
}

export type AgentEvent =
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'web_search'; query: string }
  | { type: 'web_results'; sources: WebSource[] }
  | { type: 'fallback'; from: string; to: string };

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentRequest<T = unknown> {
  model: string;
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  effort?: Effort;
  tools?: AgentTool<never>[];
  webSearch?: { maxUses: number; blockedDomains?: string[] };
  /** Erzwingt eine strukturierte Schlussantwort, die gegen dieses Schema geprüft wird. */
  output?: z.ZodType<T>;
  /** Obergrenze für Modellaufrufe in einer Werkzeugschleife. */
  maxTurns?: number;
  onText?: (delta: string) => void;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentResult<T = unknown> {
  text: string;
  parsed: T | undefined;
  webSources: WebSource[];
  usage: Usage;
  turns: number;
  stopReason: string;
  /** Modell, das die letzte Antwort geliefert hat (weicht bei einem Fallback vom angefragten ab). */
  servedBy: string;
}

export interface Llm {
  run<T = unknown>(req: AgentRequest<T>): Promise<AgentResult<T>>;
}

export class LlmRefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(
      `Das Modell hat die Anfrage aus Sicherheitsgründen abgelehnt${category ? ` (${category})` : ''}.${explanation ? ` ${explanation}` : ''}`,
    );
    this.name = 'LlmRefusalError';
  }
}

export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
