import type { z } from 'zod';
import type { AppContext } from '../../context.js';
import {
  LlmOutputError,
  type AgentEvent,
  type AgentRequest,
  type AgentResult,
} from '../llm/index.js';
import type { EventInput } from './store.js';

export type Emit = (event: EventInput) => Promise<void>;

/**
 * Ruft das Modell mit strukturierter Ausgabe auf. Scheitert die Schemaprüfung,
 * bekommt es genau einen zweiten Versuch mit der Fehlermeldung — so retten wir
 * den häufigsten Fehler (ein Feld vergessen) ohne Endlosschleifen.
 */
export async function runStructured<T>(
  ctx: AppContext,
  req: Omit<AgentRequest<T>, 'output'> & { output: z.ZodType<T> },
  emit: Emit,
  agent: string,
  sectionId?: string,
): Promise<AgentResult<T>> {
  const onEvent = eventLogger(emit, agent, sectionId);
  try {
    return await ctx.llm.run({ ...req, onEvent });
  } catch (error) {
    if (!(error instanceof LlmOutputError) || /abgeschnitten/.test(error.message)) throw error;
    await emit({
      agent,
      sectionId,
      kind: 'info',
      message: `Antwort nicht verwertbar, zweiter Versuch: ${error.message.slice(0, 300)}`,
    });
    return ctx.llm.run({
      ...req,
      onEvent,
      messages: [
        ...req.messages,
        { role: 'assistant', content: '(ungültige Antwort)' },
        {
          role: 'user',
          content: `Deine letzte Antwort war nicht gültig: ${error.message}\nGib die Antwort vollständig und im geforderten Format erneut aus.`,
        },
      ],
    });
  }
}

/**
 * Protokolliert Modellereignisse in der Reihenfolge ihres Eintretens. Die Einträge laufen über eine
 * Kette, und Fehler beim Schreiben werden verschluckt: ein defektes Protokoll darf keinen Lauf abbrechen.
 */
export function eventLogger(
  emit: Emit,
  agent: string,
  sectionId?: string,
): (e: AgentEvent) => void {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (event: EventInput): void => {
    chain = chain.then(() => emit(event)).catch(() => undefined);
  };
  return (e) => {
    const base = { agent, sectionId, kind: 'tool' as const };
    if (e.type === 'tool_call')
      enqueue({ ...base, message: `${e.name}: ${JSON.stringify(e.input).slice(0, 300)}` });
    else if (e.type === 'tool_result' && !e.ok)
      enqueue({ ...base, kind: 'error', message: `${e.name} fehlgeschlagen: ${e.preview}` });
    else if (e.type === 'web_search') enqueue({ ...base, message: `Websuche: ${e.query}` });
    else if (e.type === 'web_results')
      enqueue({ ...base, message: `Websuche lieferte ${e.sources.length} Quellen` });
    else if (e.type === 'fallback')
      enqueue({
        ...base,
        kind: 'info',
        message: `Modellwechsel durch Sicherheitsfallback: ${e.from} → ${e.to}`,
      });
  };
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
