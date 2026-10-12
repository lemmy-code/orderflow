import { ModelClient, ModelReply, ModelRequest, TextBlock, ToolUseBlock } from '../../apps/agent/src/types';

/** Plays back scripted replies in order; records every request so tests can inspect what the model was sent. */
export class FakeModel implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private readonly script: ModelReply[]) {}
  async create(r: ModelRequest): Promise<ModelReply> {
    this.requests.push(structuredClone(r));
    const next = this.script.shift();
    if (!next) throw new Error('FakeModel: script exhausted');
    return next;
  }
}

export const toolUse = (id: string, name: string, input: unknown): ToolUseBlock => ({ type: 'tool_use', id, name, input });
export const say = (text: string): TextBlock => ({ type: 'text', text });
export const reply = (
  content: (TextBlock | ToolUseBlock)[],
  stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
): ModelReply => ({ content, stopReason, usage: { inputTokens: 100, outputTokens: 20 } });
