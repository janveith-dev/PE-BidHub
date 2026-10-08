import { emptyUsage, type AgentRequest, type AgentResult, type Llm } from './types.js';

type Handler = (
  req: AgentRequest<never>,
  callIndex: number,
) =>
  | Promise<Partial<AgentResult<unknown>> & { json?: unknown }>
  | (Partial<AgentResult<unknown>> & { json?: unknown });

/**
 * Skriptbarer Ersatz für die Claude-API in Tests. Der Handler sieht die
 * vollständige Anfrage (inklusive Werkzeuge) und kann diese selbst aufrufen,
 * wie es das Modell täte. `json` wird gegen das Ausgabeschema der Anfrage geprüft.
 */
export class FakeLlm implements Llm {
  readonly calls: AgentRequest<never>[] = [];
  constructor(private readonly handler: Handler) {}

  async run<T = unknown>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const index = this.calls.push(req as unknown as AgentRequest<never>) - 1;
    const out = await this.handler(req as unknown as AgentRequest<never>, index);
    const text = out.text ?? (out.json !== undefined ? JSON.stringify(out.json) : '');
    if (out.text) req.onText?.(out.text);
    const parsed =
      req.output && out.json !== undefined
        ? (req.output.parse(out.json) as T)
        : (out.parsed as T | undefined);
    return {
      text,
      parsed,
      webSources: out.webSources ?? [],
      usage: out.usage ?? emptyUsage(),
      turns: out.turns ?? 1,
      stopReason: out.stopReason ?? 'end_turn',
      servedBy: out.servedBy ?? req.model,
    };
  }
}

/**
 * Ruft ein Werkzeug der Anfrage so auf, wie es das Modell täte: Eingabeprüfung inklusive, und Fehler
 * kommen — wie in der echten Schleife — als Text zurück statt als Ausnahme.
 */
export async function callTool(
  req: AgentRequest<never>,
  name: string,
  input: unknown,
): Promise<string> {
  const tool = req.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`Werkzeug ${name} ist in dieser Anfrage nicht vorhanden`);
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return `FEHLER: Ungültige Eingabe: ${parsed.error.message}`;
  try {
    return await tool.run(parsed.data as never);
  } catch (error) {
    return `FEHLER: ${error instanceof Error ? error.message : String(error)}`;
  }
}
