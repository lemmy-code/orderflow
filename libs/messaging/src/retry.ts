import { ContractError } from '@app/contracts';

/**
 * 10 attempts with doubling backoff capped at 30 s spans about 80 s, so a database restart or failover
 * does not dead-letter valid events. Contract violations skip all of it: retrying cannot fix them.
 */
export const MAX_ATTEMPTS = 10;
export const MAX_BACKOFF_MS = 30_000;

export function backoffMs(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

export function decide(error: unknown, attempt: number): 'retry' | 'dlq' {
  if (error instanceof ContractError) return 'dlq';
  return attempt < MAX_ATTEMPTS ? 'retry' : 'dlq';
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
