import type { TokenUsage } from '@app/agent-policy';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** A block the loop doesn't interpret (e.g. thinking) but must send back unchanged. */
export interface OpaqueBlock {
  type: string;
  [key: string]: unknown;
}
export interface Message {
  role: 'user' | 'assistant';
  content: string | (TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock)[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
}
export interface ModelReply {
  /** The text and tool_use blocks the loop acts on. */
  content: (TextBlock | ToolUseBlock)[];
  /** The reply exactly as the API returned it (incl. thinking blocks), echoed back unchanged in the history. */
  raw?: (TextBlock | ToolUseBlock | OpaqueBlock)[];
  stopReason: string | null;
  usage: TokenUsage;
}
/** The model behind a seam: the Anthropic SDK in production, a scripted fake in tests. */
export interface ModelClient {
  create(r: ModelRequest): Promise<ModelReply>;
}

/** The tools behind a seam: an MCP client in production. */
export interface ToolGateway {
  listTools(): Promise<ToolSpec[]>;
  call(name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
}

/** The human in the loop: a terminal prompt in production. */
export interface Approver {
  approve(r: { tool: string; input: unknown; reason: string }): Promise<boolean>;
}

export type TraceEvent =
  | { type: 'task'; at: string; task: string; tools: string[] }
  | { type: 'model'; at: string; step: number; stopReason: string | null; usage: TokenUsage; text: string }
  | { type: 'tool_request'; at: string; id: string; tool: string; input: unknown }
  | {
      type: 'policy';
      at: string;
      id: string;
      tool: string;
      decision: 'allow' | 'deny' | 'approved-by-human' | 'denied-by-human';
      reason?: string;
    }
  | { type: 'tool_result'; at: string; id: string; tool: string; isError: boolean; ms: number; preview: string }
  | { type: 'end'; at: string; outcome: string; reason?: string; steps: number; usage: TokenUsage };

export interface TraceSink {
  write(e: TraceEvent): void;
}
