import { ContractError } from '@app/contracts';

export const MAX_ATTEMPTS = 3;

export function backoffMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1);
}

export function decide(error: unknown, attempt: number): 'retry' | 'dlq' {
  if (error instanceof ContractError) return 'dlq';
  return attempt < MAX_ATTEMPTS ? 'retry' : 'dlq';
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
