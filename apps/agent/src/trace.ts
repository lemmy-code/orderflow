import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TraceEvent, TraceSink } from './types';

/** One JSON line per event, so a run can be read back, diffed and debugged later. */
export function jsonlTrace(dir = '.agent-traces', echo = false): TraceSink & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  return {
    path,
    write(e) {
      appendFileSync(path, `${JSON.stringify(e)}\n`);
      if (echo) {
        const tool = 'tool' in e ? ` ${e.tool}` : '';
        const decision = 'decision' in e ? ` → ${e.decision}` : '';
        process.stderr.write(`· ${e.type}${tool}${decision}\n`);
      }
    },
  };
}

export function memoryTrace(): TraceSink & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return { events, write: (e) => void events.push(e) };
}
