import { decide, parseApproval, TOOL_TIERS } from './index';

const exposed = new Set(Object.keys(TOOL_TIERS));

describe('decide', () => {
  it.each(['list_products', 'get_order', 'list_orders', 'create_order'])('allows %s', (t) => {
    expect(decide(t, exposed)).toEqual({ kind: 'allow' });
  });
  it.each(['pay_order', 'cancel_order'])('asks a human before %s', (t) => {
    expect(decide(t, exposed).kind).toBe('ask');
  });
  it('refuses a tool that does not exist, naming the ones that do', () => {
    const d = decide('drop_database', exposed);
    expect(d).toMatchObject({ kind: 'deny' });
    expect((d as { reason: string }).reason).toContain('create_order');
  });
  it('refuses a tool the server has but nobody has given a tier', () => {
    expect(decide('refund_order', new Set([...exposed, 'refund_order'])).kind).toBe('deny');
  });
});

describe('parseApproval', () => {
  it.each(['y', 'Y', 'yes', ' YES ', 'Yes\n'])('approves %j', (a) => expect(parseApproval(a)).toBe(true));
  it.each(['', 'n', 'no', 'yess', 'sure', null, undefined])('denies %j', (a) => expect(parseApproval(a)).toBe(false));
});
