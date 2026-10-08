import type { Config } from '../../config.js';
import { AnthropicLlm } from './anthropic.js';
import type { Llm } from './types.js';

export * from './types.js';
export { AnthropicLlm, toJsonSchema } from './anthropic.js';
export { FakeLlm, callTool } from './fake.js';

export function createLlm(config: Pick<Config, 'anthropicApiKey' | 'refusalFallback'>): Llm {
  return new AnthropicLlm({
    apiKey: config.anthropicApiKey,
    refusalFallback: config.refusalFallback,
  });
}
