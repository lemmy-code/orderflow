import Anthropic from '@anthropic-ai/sdk';
import { ModelClient, TextBlock, ToolUseBlock } from './types';

/** The real model: one Messages API call per step. Our block types are a subset of the SDK's, so they pass straight through. */
export function anthropicModel(o: { model: string; apiKey?: string }): ModelClient {
  const client = new Anthropic({ apiKey: o.apiKey, maxRetries: 3 }); // retries 429 and 5xx with exponential backoff
  return {
    async create(r) {
      const m = await client.messages.create({
        model: o.model,
        max_tokens: r.maxTokens,
        system: r.system,
        messages: r.messages as Anthropic.MessageParam[],
        tools: r.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      });
      return {
        content: m.content.flatMap<TextBlock | ToolUseBlock>((b) =>
          b.type === 'text'
            ? [{ type: 'text' as const, text: b.text }]
            : b.type === 'tool_use'
              ? [{ type: 'tool_use' as const, id: b.id, name: b.name, input: b.input }]
              : [],
        ),
        stopReason: m.stop_reason,
        usage: { inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens },
      };
    },
  };
}
