/** Seeded by the first migration; the README and the tests use these IDs. */
export const SEED_PRODUCTS = [
  { id: '11111111-1111-4111-8111-111111111111', sku: 'KB-01', name: 'Mechanical keyboard', priceCents: 8999, stock: 10 },
  { id: '22222222-2222-4222-8222-222222222222', sku: 'MS-01', name: 'Wireless mouse', priceCents: 2999, stock: 5 },
  { id: '33333333-3333-4333-8333-333333333333', sku: 'MN-01', name: '27-inch monitor', priceCents: 24999, stock: 1 },
] as const;
