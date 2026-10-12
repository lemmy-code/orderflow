export type Tier = 'read' | 'write' | 'approval';

/** Every tool the model may use, and how much trust it gets. A server tool missing here is refused. */
export const TOOL_TIERS: Readonly<Record<string, Tier>> = {
  list_products: 'read',
  get_order: 'read',
  list_orders: 'read',
  create_order: 'write',
  pay_order: 'approval',
  cancel_order: 'approval',
};
