import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicLlm } from './anthropic.js';
import { LlmOutputError, LlmRefusalError, type AgentEvent, type AgentTool } from './types.js';

type Block = Record<string, unknown>;
interface Reply {
  content: Block[];
  stop_reason: string;
  stop_details?: { category: string | null; explanation: string | null };
  model?: string;
  text?: string;
}

/** Stub für client.beta.messages.stream: liefert vorbereitete Antworten und merkt sich jede Anfrage. */
function stubClient(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          const reply = replies[requests.length - 1];
          if (!reply) throw new Error('Keine vorbereitete Antwort mehr');
          let onText: ((d: string) => void) | undefined;
          return {
            on(event: string, cb: (d: string) => void) {
              if (event === 'text') onText = cb;
            },
            async finalMessage() {
              if (reply.text) onText?.(reply.text);
              return {
                id: 'msg_x', type: 'message', role: 'assistant', model: reply.model ?? 'claude-opus-5-5',
                content: reply.content, stop_reason: reply.stop_reason, stop_details: reply.stop_details ?? null,
                usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
              };
            },
          };
        },
      },
    },
  };
  return { client: client as never, requests };
}

const text = (t: string): Block => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input });

const echo: AgentTool<{ q: string }> = {
  name: 'echo',
  description: 'Gibt die Eingabe zurück',
  schema: z.object({ q: z.string().min(1) }),
  run: async ({ q }) => `Echo: ${q}`,
};

const base = { model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user' as const, content: 'hallo' }] };

describe('AnthropicLlm', () => {
  it('führt Werkzeugaufrufe aus und gibt Ergebnisse gebündelt zurück', async () => {
    const { client, requests } = stubClient([
      { content: [toolUse('t1', 'echo', { q: 'a' }), toolUse('t2', 'echo', { q: 'b' })], stop_reason: 'tool_use' },
      { content: [text('Fertig')], stop_reason: 'end_turn', text: 'Fertig' },
    ]);
    const events: AgentEvent[] = [];
    const streamed: string[] = [];
    const llm = new AnthropicLlm({ apiKey: 'k', refusalFallback: true, client });
    const res = await llm.run({ ...base, tools: [echo as never], onEvent: (e) => events.push(e), onText: (d) => streamed.push(d) });

    expect(res.text).toBe('Fertig');
    expect(streamed).toEqual(['Fertig']);
    expect(res.turns).toBe(2);
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2 });
    // Beide Ergebnisse stehen in EINER Nutzernachricht.
    const followUp = (requests[1]!.messages as { role: string; content: Block[] }[]).at(-1)!;
    expect(followUp.role).toBe('user');
    expect(followUp.content.map((b) => [b.tool_use_id, b.content])).toEqual([['t1', 'Echo: a'], ['t2', 'Echo: b']]);
    expect(events.filter((e) => e.type === 'tool_result' && e.ok)).toHaveLength(2);
  });

  it('meldet ungültige Werkzeugeingaben dem Modell, ohne das Werkzeug auszuführen', async () => {
    let ran = 0;
    const tool = { ...echo, run: async () => (ran++, 'x') };
    const { client, requests } = stubClient([
      { content: [toolUse('t1', 'echo', { q: '' })], stop_reason: 'tool_use' },
      { content: [text('ok')], stop_reason: 'end_turn' },
    ]);
    await new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({ ...base, tools: [tool as never] });
    expect(ran).toBe(0);
    const result = (requests[1]!.messages as { content: Block[] }[]).at(-1)!.content[0]!;
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
    expect(String(result.content)).toContain('Ungültige Eingabe');
  });

  it('meldet Fehler und unbekannte Werkzeuge als Werkzeugfehler statt abzubrechen', async () => {
    const boom = { ...echo, run: async () => { throw new Error('Datenbank nicht erreichbar'); } };
    const { client, requests } = stubClient([
      { content: [toolUse('t1', 'echo', { q: 'a' }), toolUse('t2', 'gibtsnicht', {})], stop_reason: 'tool_use' },
      { content: [text('ok')], stop_reason: 'end_turn' },
    ]);
    await new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({ ...base, tools: [boom as never] });
    const results = (requests[1]!.messages as { content: Block[] }[]).at(-1)!.content;
    expect(results.map((r) => [r.is_error, r.content])).toEqual([[true, 'Datenbank nicht erreichbar'], [true, 'Unbekanntes Werkzeug: gibtsnicht']]);
  });

  it('setzt nach pause_turn unverändert fort und sammelt Websuche-Quellen', async () => {
    const { client, requests } = stubClient([
      {
        content: [
          { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'ITIL 4 Practices' } },
          { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://example.org/itil', title: 'ITIL 4', encrypted_content: 'x', page_age: null }] },
        ],
        stop_reason: 'pause_turn',
      },
      { content: [text('Antwort')], stop_reason: 'end_turn', text: 'Antwort' },
    ]);
    const events: AgentEvent[] = [];
    const res = await new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({
      ...base, webSearch: { maxUses: 3, blockedDomains: ['wettbewerber.de'] }, onEvent: (e) => events.push(e),
    });
    expect(res.webSources).toEqual([{ url: 'https://example.org/itil', title: 'ITIL 4' }]);
    expect(events.map((e) => e.type)).toEqual(['web_search', 'web_results']);
    expect(requests[0]!.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, blocked_domains: ['wettbewerber.de'] }]);
    // Der unterbrochene Zug wird unverändert zurückgeschickt.
    const msgs = requests[1]!.messages as { role: string; content: Block[] }[];
    expect(msgs.at(-1)!.role).toBe('assistant');
    expect(msgs.at(-1)!.content[0]).toMatchObject({ type: 'server_tool_use' });
  });

  it('sendet den Refusal-Fallback nur für Opus/Sonnet und nur wenn aktiviert', async () => {
    const run = async (model: string, refusalFallback: boolean) => {
      const { client, requests } = stubClient([{ content: [text('x')], stop_reason: 'end_turn' }]);
      await new AnthropicLlm({ apiKey: 'k', refusalFallback, client }).run({ ...base, model });
      return requests[0]!;
    };
    expect(await run('claude-opus-5-5', true)).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(await run('claude-sonnet-5-5', true)).toMatchObject({ fallbacks: 'default' });
    expect(await run('claude-haiku-5-5', true)).not.toHaveProperty('fallbacks');
    expect(await run('claude-opus-5-5', false)).not.toHaveProperty('fallbacks');
  });

  it('sendet weder Temperatur noch Thinking-Budget und setzt den Aufwand', async () => {
    const { client, requests } = stubClient([{ content: [text('x')], stop_reason: 'end_turn' }]);
    await new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({ ...base, effort: 'high' });
    expect(requests[0]).not.toHaveProperty('temperature');
    expect(requests[0]).not.toHaveProperty('thinking');
    expect(requests[0]!.output_config).toEqual({ effort: 'high' });
  });

  it('prüft die strukturierte Antwort gegen das Schema', async () => {
    const schema = z.object({ n: z.number().int(), items: z.array(z.string()) });
    const ok = stubClient([{ content: [text('{"n":3,"items":["a"]}')], stop_reason: 'end_turn' }]);
    const res = await new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client: ok.client }).run({ ...base, output: schema });
    expect(res.parsed).toEqual({ n: 3, items: ['a'] });
    expect(ok.requests[0]!.output_config).toMatchObject({ format: { type: 'json_schema' } });

    const bad = stubClient([{ content: [text('{"n":"drei"}')], stop_reason: 'end_turn' }]);
    await expect(
      new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client: bad.client }).run({ ...base, output: schema }),
    ).rejects.toThrow(LlmOutputError);
  });

  it('wirft bei Ablehnung und führt keine Werkzeuge aus', async () => {
    let ran = 0;
    const tool = { ...echo, run: async () => (ran++, 'x') };
    const { client } = stubClient([
      { content: [toolUse('t1', 'echo', { q: 'a' })], stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: null } },
    ]);
    await expect(
      new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({ ...base, tools: [tool as never] }),
    ).rejects.toThrow(LlmRefusalError);
    expect(ran).toBe(0);
  });

  it('führt abgeschnittene Werkzeugaufrufe nicht aus', async () => {
    let ran = 0;
    const tool = { ...echo, run: async () => (ran++, 'x') };
    const { client } = stubClient([{ content: [toolUse('t1', 'echo', { q: 'a' })], stop_reason: 'max_tokens' }]);
    await expect(
      new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({ ...base, tools: [tool as never] }),
    ).rejects.toThrow(/abgeschnitten/);
    expect(ran).toBe(0);
  });

  it('bricht endlose Werkzeugschleifen ab', async () => {
    const loop: Reply = { content: [toolUse('t', 'echo', { q: 'a' })], stop_reason: 'tool_use' };
    const { client } = stubClient([loop, loop, loop]);
    await expect(
      new AnthropicLlm({ apiKey: 'k', refusalFallback: false, client }).run({ ...base, tools: [echo as never], maxTurns: 3 }),
    ).rejects.toThrow(/nach 3 Durchläufen/);
  });

  it('meldet einen fehlenden API-Schlüssel verständlich', async () => {
    await expect(new AnthropicLlm({ apiKey: undefined, refusalFallback: false }).run(base)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('ANTHROPIC_API_KEY'),
    });
  });
});
