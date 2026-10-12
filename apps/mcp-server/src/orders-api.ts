export class OrdersApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OrderItemView {
  productId: string;
  quantity: number;
  unitPriceCents: number | null;
}
export interface OrderView {
  id: string;
  status: string;
  totalCents: number | null;
  rejectionReason: string | null;
  items?: OrderItemView[];
}

export interface OrdersApi {
  createOrder(items: { productId: string; quantity: number }[]): Promise<OrderView>;
  getOrder(id: string): Promise<OrderView>;
  listOrders(o: { status?: string; first?: number }): Promise<OrderView[]>;
  payOrder(id: string): Promise<OrderView>;
  cancelOrder(id: string): Promise<OrderView>;
}

const FIELDS = 'id status totalCents rejectionReason items { productId quantity unitPriceCents }';

type GqlError = { message: string; extensions?: { code?: string } };

/** A thin client for the orders GraphQL API that turns GraphQL error codes into OrdersApiError. */
export function graphqlOrdersApi(url: string, fetchImpl: typeof fetch = fetch): OrdersApi {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: GqlError[] };
    if (body.errors?.length) {
      const e = body.errors[0];
      throw new OrdersApiError(e.extensions?.code ?? 'INTERNAL', e.message);
    }
    if (!body.data) throw new OrdersApiError('INTERNAL', `orders API returned HTTP ${res.status} with no data`);
    return body.data;
  }

  return {
    async createOrder(items) {
      const q = `mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { ${FIELDS} } }`;
      return (await gql<{ createOrder: OrderView }>(q, { items })).createOrder;
    },
    async getOrder(id) {
      const { order } = await gql<{ order: OrderView | null }>(`query($id: ID!) { order(id: $id) { ${FIELDS} } }`, { id });
      if (!order) throw new OrdersApiError('NOT_FOUND', `Order ${id} not found`);
      return order;
    },
    async listOrders({ status, first }) {
      const q = `query($status: OrderStatus, $first: Int) { orders(status: $status, first: $first) { nodes { ${FIELDS} } } }`;
      return (await gql<{ orders: { nodes: OrderView[] } }>(q, { status, first })).orders.nodes;
    },
    async payOrder(id) {
      return (await gql<{ payOrder: OrderView }>(`mutation($id: ID!) { payOrder(id: $id) { ${FIELDS} } }`, { id })).payOrder;
    },
    async cancelOrder(id) {
      const q = `mutation($id: ID!) { cancelOrder(id: $id) { ${FIELDS} } }`;
      return (await gql<{ cancelOrder: OrderView }>(q, { id })).cancelOrder;
    },
  };
}
