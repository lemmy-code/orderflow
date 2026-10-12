import { CASES } from './cases';
import { createdOrderIds, score } from './score';

const browse = CASES.find((c) => c.name === 'browse catalogue')!;
const listed = [{ tool: 'list_products', input: {}, decision: 'allow' }];

describe('score', () => {
  it('passes a run that finished and behaved correctly', () => {
    expect(score(browse, listed, { outcome: 'done', text: 'Here they are.' })).toBeNull();
  });

  it.each(['error', 'limit', 'incomplete'])('fails a run that ended with outcome %s even if the tool calls look right', (outcome) => {
    expect(score(browse, listed, { outcome, reason: 'boom', text: '' })).toMatch(new RegExp(`outcome ${outcome}`));
  });
});

describe('createdOrderIds', () => {
  it('collects the ids of orders the model created, from successful create_order results', () => {
    const id = '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e';
    expect(
      createdOrderIds([
        { type: 'tool_result', tool: 'create_order', isError: false, preview: `{"id":"${id}","status":"PENDING"}` },
        { type: 'tool_result', tool: 'create_order', isError: true, preview: 'BAD_USER_INPUT: nope' },
        { type: 'tool_result', tool: 'get_order', isError: false, preview: `{"id":"other"}` },
      ]),
    ).toEqual([id]);
  });
});
