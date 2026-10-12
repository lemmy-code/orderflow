export interface Limits {
  maxSteps: number;
  maxTokens: number;
}
export const DEFAULT_LIMITS: Limits = { maxSteps: 12, maxTokens: 60_000 };
export const MAX_TOOL_RESULT_CHARS = 20_000;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export class Budget {
  steps = 0;
  inputTokens = 0;
  outputTokens = 0;
  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {}

  record(u: TokenUsage): void {
    this.steps++;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
  }

  exhausted(): null | 'steps' | 'tokens' {
    if (this.inputTokens + this.outputTokens >= this.limits.maxTokens) return 'tokens';
    if (this.steps >= this.limits.maxSteps) return 'steps';
    return null;
  }
}

/** An estimate for display at Sonnet 5.5 list prices ($2 / $10 per million tokens); pass other prices for other models. */
export function estimateCostUsd(u: TokenUsage, price = { inPerMTok: 2, outPerMTok: 10 }): number {
  return (u.inputTokens * price.inPerMTok + u.outputTokens * price.outPerMTok) / 1_000_000;
}
