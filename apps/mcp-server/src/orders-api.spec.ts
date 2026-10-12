import { graphqlOrdersApi } from './orders-api';

const order = (n: number) => ({ id: `id-${n}`, status: 'PENDING', totalCents: null, rejectionReason: null, items: [] });

/** A fake GraphQL endpoint holding `total` orders oldest-first, paged 100 at a time like the real API. */
function fakeOrdersEndpoint(total: number) {
  const calls: { after?: string | null }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body);
    calls.push({ after: variables.after });
    const start = variables.after ? Number(variables.after) : 0;
    const nodes = Array.from({ length: Math.min(100, total - start) }, (_, i) => order(start + i));
    const end = start + nodes.length;
    const body = { data: { orders: { nodes, endCursor: String(end), hasNextPage: end < total } } };
    return { status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('graphqlOrdersApi.listOrders', () => {
  it('returns the newest orders first, following the cursor across pages', async () => {
    const { fetchImpl, calls } = fakeOrdersEndpoint(250);
    const latest = await graphqlOrdersApi('http://x/graphql', fetchImpl).listOrders({ first: 3 });
    expect(latest.map((o) => o.id)).toEqual(['id-249', 'id-248', 'id-247']);
    expect(calls).toHaveLength(3);
  });

  it('defaults to the 20 newest', async () => {
    const { fetchImpl } = fakeOrdersEndpoint(30);
    const latest = await graphqlOrdersApi('http://x/graphql', fetchImpl).listOrders({});
    expect(latest).toHaveLength(20);
    expect(latest[0].id).toBe('id-29');
  });
});
