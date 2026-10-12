import { Budget, estimateCostUsd } from './index';

describe('Budget', () => {
  it('counts steps and tokens and reports which limit ran out', () => {
    const b = new Budget({ maxSteps: 2, maxTokens: 1000 });
    expect(b.exhausted()).toBeNull();
    b.record({ inputTokens: 300, outputTokens: 100 });
    expect(b.exhausted()).toBeNull();
    b.record({ inputTokens: 300, outputTokens: 100 });
    expect(b.exhausted()).toBe('steps');
    const t = new Budget({ maxSteps: 10, maxTokens: 500 });
    t.record({ inputTokens: 450, outputTokens: 100 });
    expect(t.exhausted()).toBe('tokens');
  });
  it('estimates cost from per-million-token prices', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, { inPerMTok: 3, outPerMTok: 15 })).toBeCloseTo(4.5);
  });
});
