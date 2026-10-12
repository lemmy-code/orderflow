import { parseApproval } from '@app/agent-policy';
import { createInterface } from 'node:readline/promises';
import { Approver } from './types';

/** Asks in the terminal; the default (just pressing Enter) is no. */
export function cliApprover(): Approver {
  return {
    async approve({ tool, input, reason }) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        process.stdout.write(`\n⚠️  ${reason}\n   ${tool} ${JSON.stringify(input)}\n`);
        return parseApproval(await rl.question('   Allow? [y/N] '));
      } catch {
        return false; // stdin closed: treat as no
      } finally {
        rl.close();
      }
    },
  };
}
