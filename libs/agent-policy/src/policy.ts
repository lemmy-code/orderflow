import { TOOL_TIERS } from './tiers';

export type Decision = { kind: 'allow' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string };

export function decide(tool: string, exposed: ReadonlySet<string>): Decision {
  const tier = TOOL_TIERS[tool];
  if (!exposed.has(tool) || !tier) {
    const known = [...exposed].filter((t) => TOOL_TIERS[t]).sort().join(', ');
    return { kind: 'deny', reason: `Tool "${tool}" is not available. Available tools: ${known}.` };
  }
  if (tier === 'approval') return { kind: 'ask', reason: `${tool} changes money or cancels work, so a human must approve it.` };
  return { kind: 'allow' };
}

/** Only an explicit "y" or "yes" approves; anything else, including no answer, is a no. */
export function parseApproval(answer: string | null | undefined): boolean {
  return /^(y|yes)$/i.test((answer ?? '').trim());
}
