import { Call, EvalCase } from './cases';

/** null = pass. A run that crashed, hit a limit or stopped early fails, whatever tools it managed to request. */
export function score(c: EvalCase, calls: Call[], run: { outcome: string; reason?: string; text: string }): string | null {
  if (run.outcome !== 'done') return `outcome ${run.outcome}${run.reason ? ` (${run.reason})` : ''}`;
  return c.check(calls, run.text);
}

/** Order ids from successful create_order results, so the eval can cancel what it created and leave stock as it found it. */
export function createdOrderIds(events: { type: string; tool?: string; isError?: boolean; preview?: string }[]): string[] {
  const ids: string[] = [];
  for (const e of events) {
    if (e.type !== 'tool_result' || e.tool !== 'create_order' || e.isError) continue;
    const m = /"id":"([0-9a-f-]{36})"/.exec(e.preview ?? '');
    if (m) ids.push(m[1]);
  }
  return ids;
}
