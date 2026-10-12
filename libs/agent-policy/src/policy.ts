import { hasTier, TOOL_TIERS } from './tiers';

export type Decision = { kind: 'allow' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string };

export function decide(tool: string, exposed: ReadonlySet<string>): Decision {
  if (!exposed.has(tool) || !hasTier(tool)) {
    const known = [...exposed].filter(hasTier).sort().join(', ');
    return { kind: 'deny', reason: `Tool "${tool}" is not available. Available tools: ${known}.` };
  }
  if (TOOL_TIERS[tool] === 'approval') return { kind: 'ask', reason: `${tool} changes money or cancels work, so a human must approve it.` };
  return { kind: 'allow' };
}

/** Only an explicit "y" or "yes" approves; anything else, including no answer, is a no. */
export function parseApproval(answer: string | null | undefined): boolean {
  return /^(y|yes)$/i.test((answer ?? '').trim());
}
