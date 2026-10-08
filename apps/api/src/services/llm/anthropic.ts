import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import {
  emptyUsage,
  LlmOutputError,
  LlmRefusalError,
  type AgentRequest,
  type AgentResult,
  type AgentTool,
  type Llm,
  type WebSource,
} from './types.js';

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_MAX_TURNS = 12;

/** Haiku 5.5 hat keinen serverseitigen Fallback; die Angabe dort führt zu einem 400. */
const supportsFallback = (model: string): boolean => /^claude-(opus|sonnet|fable)-/.test(model);

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return rest;
}

export interface AnthropicLlmOptions {
  apiKey: string | undefined;
  /** Serverseitigen Refusal-Fallback der Claude-API mitsenden. */
  refusalFallback: boolean;
  /** Für Tests: vorgefertigter Client statt eines neuen SDK-Clients. */
  client?: Anthropic;
}

export class AnthropicLlm implements Llm {
  private client: Anthropic | undefined;

  constructor(private readonly options: AnthropicLlmOptions) {
    this.client = options.client;
  }

  private getClient(): Anthropic {
    if (!this.client && !this.options.apiKey) {
      throw new HttpError(
        503,
        'Die KI-Funktionen sind nicht eingerichtet: ANTHROPIC_API_KEY ist nicht gesetzt.',
      );
    }
    this.client ??= new Anthropic({ apiKey: this.options.apiKey! });
    return this.client;
  }

  async run<T = unknown>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const client = this.getClient();
    const messages: MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const tools = (req.tools ?? []) as AgentTool<unknown>[];
    const toolByName = new Map(tools.map((t) => [t.name, t]));

    const apiTools: Anthropic.Beta.BetaToolUnion[] = [
      ...tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toJsonSchema(t.schema) as Anthropic.Beta.BetaTool['input_schema'],
        // Große Eingaben (Kapiteltexte) sollen fortlaufend ankommen; die Prüfung übernimmt unten das Zod-Schema.
        eager_input_streaming: true,
      })),
      ...(req.webSearch
        ? [
            {
              type: 'web_search_20260209' as const,
              name: 'web_search' as const,
              max_uses: req.webSearch.maxUses,
              ...(req.webSearch.blockedDomains?.length
                ? { blocked_domains: req.webSearch.blockedDomains }
                : {}),
            },
          ]
        : []),
    ];

    const usage = emptyUsage();
    const webSources = new Map<string, WebSource>();
    const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;
    let text = '';
    let lastMessage: Message | undefined;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const useFallback = this.options.refusalFallback && supportsFallback(req.model);
      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages,
          ...(apiTools.length ? { tools: apiTools } : {}),
          output_config: {
            ...(req.effort ? { effort: req.effort } : {}),
            ...(req.output ? { format: zodOutputFormat(req.output as unknown as z.ZodType) } : {}),
          },
          ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        req.signal ? { signal: req.signal } : undefined,
      );

      let turnText = '';
      stream.on('text', (delta) => {
        turnText += delta;
        req.onText?.(delta);
      });

      const message = await stream.finalMessage();
      lastMessage = message;
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;

      for (const block of message.content) {
        if (block.type === 'fallback')
          req.onEvent?.({ type: 'fallback', from: block.from.model, to: block.to.model });
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          const query = (block.input as { query?: string }).query;
          if (query) req.onEvent?.({ type: 'web_search', query });
        }
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          const found = block.content.map((r) => ({ url: r.url, title: r.title }));
          for (const s of found) webSources.set(s.url, s);
          req.onEvent?.({ type: 'web_results', sources: found });
        }
      }

      // Eine Ablehnung kann einen Werkzeugaufruf mitten in der Eingabe abschneiden — niemals ausführen.
      if (message.stop_reason === 'refusal') {
        throw new LlmRefusalError(
          message.stop_details?.category ?? null,
          message.stop_details?.explanation ?? null,
        );
      }

      messages.push({ role: 'assistant', content: message.content as MessageParam['content'] });
      text += turnText;

      // Serverseitige Werkzeuge (Websuche) können eine Runde unterbrechen; unverändert fortsetzen.
      if (message.stop_reason === 'pause_turn') continue;

      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );

      if (message.stop_reason === 'max_tokens') {
        if (toolUses.length)
          throw new LlmOutputError(
            'Die Antwort wurde mitten in einem Werkzeugaufruf abgeschnitten (max_tokens).',
          );
        if (req.output)
          throw new LlmOutputError('Die strukturierte Antwort wurde abgeschnitten (max_tokens).');
        break;
      }
      if (!toolUses.length) break;

      const results = await Promise.all(toolUses.map((use) => this.runTool(use, toolByName, req)));
      messages.push({ role: 'user', content: results });
    }

    if (!lastMessage) throw new LlmOutputError('Das Modell hat nicht geantwortet.');
    if (lastMessage.stop_reason === 'tool_use') {
      throw new LlmOutputError(
        `Die Werkzeugschleife wurde nach ${maxTurns} Durchläufen abgebrochen.`,
      );
    }

    let parsed: T | undefined;
    if (req.output) {
      const finalText = lastTurnText(lastMessage);
      try {
        parsed = req.output.parse(JSON.parse(finalText)) as T;
      } catch (error) {
        throw new LlmOutputError(
          `Die Antwort entspricht nicht dem erwarteten Format: ${(error as Error).message}`,
        );
      }
    }

    return {
      text,
      parsed,
      webSources: [...webSources.values()],
      usage,
      turns: messages.filter((m) => m.role === 'assistant').length,
      stopReason: lastMessage.stop_reason ?? 'unknown',
      servedBy: lastMessage.model,
    };
  }

  private async runTool(
    use: Anthropic.Beta.BetaToolUseBlock,
    tools: Map<string, AgentTool<unknown>>,
    req: AgentRequest<unknown>,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const fail = (message: string): Anthropic.Beta.BetaToolResultBlockParam => {
      req.onEvent?.({
        type: 'tool_result',
        name: use.name,
        ok: false,
        preview: message.slice(0, 200),
      });
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: message };
    };
    const tool = tools.get(use.name);
    if (!tool) return fail(`Unbekanntes Werkzeug: ${use.name}`);

    // Das SDK parst Eingaben tolerant, auch unvollständiges JSON: erst das Schema entscheidet.
    const parsed = tool.schema.safeParse(use.input);
    if (!parsed.success) return fail(`Ungültige Eingabe: ${z.prettifyError(parsed.error)}`);

    req.onEvent?.({ type: 'tool_call', name: use.name, input: parsed.data });
    try {
      const content = await tool.run(parsed.data);
      req.onEvent?.({
        type: 'tool_result',
        name: use.name,
        ok: true,
        preview: content.slice(0, 200),
      });
      return { type: 'tool_result', tool_use_id: use.id, content };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}

function lastTurnText(message: Message): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
