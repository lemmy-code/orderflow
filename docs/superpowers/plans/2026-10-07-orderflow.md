# orderflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two event-driven NestJS services (orders, inventory) linked only by Kafka, with a transactional outbox, idempotent consumers, a DLQ, and unit, integration and e2e tests that run in CI from a clean checkout.

**Architecture:** NestJS monorepo with `apps/orders` (GraphQL, code-first Apollo), `apps/inventory` (Kafka consumer only), `libs/contracts` (event types and the payload validator) and `libs/messaging` (Kafka setup, outbox, idempotency guard, consumer with retry and DLQ). Each service owns its own PostgreSQL database; all state changes and their outgoing events are written in one DB transaction and published later by an outbox loop.

**Tech Stack:** Node 22 (CI/Docker; Node 25 locally is fine), TypeScript ~5.9 (strict), NestJS, `@nestjs/graphql` + `@nestjs/apollo` + `@apollo/server`, TypeORM + `pg`, KafkaJS, Jest + ts-jest, Supertest, Testcontainers (`@testcontainers/postgresql`, `@testcontainers/kafka`), ESLint (typescript-eslint), Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-07-orderflow-design.md` (read §10: the revisions made while planning).

## Global Constraints

- Repository root: `~/Documents/GitHub/orderflow`. All documentation stays inside this repository (`docs/`, `README.md`).
- **Docker must be running locally** for integration tests, e2e tests and Compose (`docker info` succeeds). CI has Docker.
- TypeScript `strict: true`; no `any` (ESLint `no-explicit-any: error`).
- Topics are exactly `order-events`, `stock-events`, `order-events.dlq`, `stock-events.dlq`; every message key is the `orderId`.
- Event `type`s are exactly `order.created`, `order.paid`, `order.cancelled`, `stock.reserved`, `stock.rejected`.
- Order statuses are exactly `PENDING | RESERVED | REJECTED | PAID | CANCELLED`; GraphQL error codes are exactly `BAD_USER_INPUT`, `NOT_FOUND`, `INVALID_STATE`; rejection reasons are exactly `INSUFFICIENT_STOCK`, `UNKNOWN_PRODUCT`.
- Retry: 3 attempts in total with exponential backoff (base 200 ms), then DLQ; a payload that fails validation goes to the DLQ on the first attempt.
- **Env vars are read only inside functions called at module-init time, never at import time, and every one has a local default.** The app must start and the tests must pass with no `.env` file (the Speechify lesson).
- `orders(first)` defaults to 20, is capped at 100; `first < 1` is `BAD_USER_INPUT`.
- Order input limits: 1–50 lines, quantity an integer 1–1000, `productId` a UUID, no duplicate `productId`.
- Seeded products (fixed IDs, used by tests and README): keyboard `11111111-1111-4111-8111-111111111111` (8999¢, stock 10), mouse `22222222-2222-4222-8222-222222222222` (2999¢, stock 5), monitor `33333333-3333-4333-8333-333333333333` (24999¢, stock 1).
- Commit after every task with a conventional-commit message ending in the `Co-Authored-By` trailer the session uses. Do not push until the user says so.

## Review Focus

1. **Malformed `createOrder` input** (empty list, quantity 0 / -1 / 1001 / 1.5, 51 lines, the same product twice, a non-UUID productId) → `BAD_USER_INPUT` and nothing saved. Pinned in Task 3 (unit) and Task 6 (GraphQL int test).
2. **A non-UUID `id`** passed to `order`, `payOrder` or `cancelOrder` → `BAD_USER_INPUT`, never a Postgres "invalid input syntax" 500. Pinned in Task 5 and Task 6.
3. **Kafka down when the outbox publishes** → the API keeps accepting orders, rows stay unsent, and they go out once Kafka is back. Pinned in Task 4.
4. **The same product twice inside one `order.created` that bypassed the API** (another producer, a replay) → quantities summed, one reservation row per product. Pinned in Task 7 (unit) and Task 8 (int).
5. **Pagination abuse** (`first: 1000`, `first: 0`, a garbage `after` cursor) → capped at 100, `BAD_USER_INPUT`, `BAD_USER_INPUT`. Pinned in Task 3 (unit) and Task 5 (int).

---

## File structure

```
orderflow/
├── package.json  tsconfig.json  nest-cli.json  jest.config.js  eslint.config.mjs  .prettierrc  .gitignore
├── Dockerfile  docker-compose.yml  docker/postgres-init.sql
├── .github/workflows/ci.yml
├── README.md
├── libs/contracts/src/            topics.ts  events.ts  envelope.ts  parse.ts  parse.spec.ts  index.ts
├── libs/messaging/src/            retry.ts  retry.spec.ts  consumer.ts  consumer.spec.ts  kafka.ts
│                                  idempotency.ts  outbox.ts  schema.ts  logger.ts  index.ts
├── apps/orders/src/
│   ├── main.ts  app.module.ts  config.ts  health.controller.ts  messaging.lifecycle.ts  data-source.ts
│   ├── migrations/1728300000000-init-orders.ts
│   └── orders/  order-status.ts  order-state.ts(+spec)  order-input.ts(+spec)  pagination.ts(+spec)  errors.ts
│                order.entity.ts  order-item.entity.ts  orders.service.ts  graphql.models.ts  orders.resolver.ts  graphql-errors.ts
├── apps/inventory/src/
│   ├── main.ts  app.module.ts  config.ts  messaging.lifecycle.ts  data-source.ts
│   ├── migrations/1728300000001-init-inventory.ts
│   └── stock/  stock.ts(+spec)  seed.ts  product.entity.ts  reservation.entity.ts  reservation.service.ts
└── test/
    ├── support/  timeout.ts  postgres.ts  kafka.ts  wait-for.ts  fake-producer.ts
    ├── int/      messaging.int-spec.ts  orders.int-spec.ts  orders-graphql.int-spec.ts  inventory.int-spec.ts
    └── e2e/      orderflow.e2e-spec.ts
```

Each `*.spec.ts` is a unit test (no I/O). `*.int-spec.ts` uses Testcontainers PostgreSQL. `*.e2e-spec.ts` uses PostgreSQL + Kafka and both apps.

---

### Task 1: Scaffold the monorepo and `libs/contracts`

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `jest.config.js`, `eslint.config.mjs`, `.prettierrc`, `apps/orders/tsconfig.app.json`, `apps/inventory/tsconfig.app.json`, `libs/contracts/tsconfig.lib.json`, `libs/messaging/tsconfig.lib.json`, `test/support/timeout.ts`
- Create: `libs/contracts/src/topics.ts`, `events.ts`, `envelope.ts`, `parse.ts`, `index.ts`
- Modify: `.gitignore` (already exists: `node_modules/ dist/ coverage/ .env`)
- Test: `libs/contracts/src/parse.spec.ts`

**Interfaces:**
- Produces (import from `@app/contracts`):
  - `Topics = { OrderEvents: 'order-events', StockEvents: 'stock-events' }`, `type Topic`, `dlqTopic(t: Topic): string`, `ALL_TOPICS: string[]`
  - `EventTypes = { OrderCreated, OrderPaid, OrderCancelled, StockReserved, StockRejected }` (values = the type strings), `type EventType`, `topicFor(type: EventType): Topic`
  - `interface EventEnvelope { eventId: string; occurredAt: string; orderId: string }`, `OrderItemLine { productId; quantity }`, `PricedLine { productId; unitPriceCents }`, `type RejectionReason`, `OrderCreated | OrderPaid | OrderCancelled` (= `OrderEvent`), `StockReserved | StockRejected` (= `StockEvent`), `AnyEvent`
  - `newEnvelope(orderId: string): EventEnvelope`
  - `class ContractError extends Error`, `isUuid(v: unknown): v is string`, `parseEvent(topic: string, raw: string | null): AnyEvent`

- [ ] **Step 0: Check Docker and Node**

Run: `docker info --format '{{.ServerVersion}}' && node -v`
Expected: a Docker server version and `v22` or newer. If `docker` is missing, stop and ask the user to install Docker Desktop (or OrbStack) and start it. Do not continue without it.

- [ ] **Step 1: Create `package.json` and install dependencies**

```json
{
  "name": "orderflow",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "nest build orders && nest build inventory",
    "start:orders": "nest start orders --watch",
    "start:inventory": "nest start inventory --watch",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test:unit": "jest --selectProjects unit",
    "test:int": "jest --selectProjects int --runInBand",
    "test:e2e": "jest --selectProjects e2e --runInBand",
    "test": "npm run test:unit && npm run test:int && npm run test:e2e"
  }
}
```

Run:
```bash
cd ~/Documents/GitHub/orderflow
npm install @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/graphql @nestjs/apollo @apollo/server graphql @nestjs/typeorm typeorm pg kafkajs reflect-metadata rxjs
npm install -D @nestjs/cli @nestjs/schematics @nestjs/testing typescript@~5.9 ts-jest jest @types/jest @types/node @types/pg supertest @types/supertest testcontainers @testcontainers/postgresql @testcontainers/kafka eslint typescript-eslint prettier ts-node
```
Expected: installs without peer-dependency errors. If npm reports a peer conflict between NestJS packages, install the versions npm names in the error, all at the same major.

- [ ] **Step 2: Write the TypeScript, Nest CLI, Jest, ESLint and Prettier config**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "types": ["node", "jest"],
    "paths": {
      "@app/contracts": ["libs/contracts/src"],
      "@app/contracts/*": ["libs/contracts/src/*"],
      "@app/messaging": ["libs/messaging/src"],
      "@app/messaging/*": ["libs/messaging/src/*"]
    }
  },
  "include": ["apps/**/*.ts", "libs/**/*.ts", "test/**/*.ts"]
}
```

`apps/orders/tsconfig.app.json` (and the same for `apps/inventory`, with `inventory` in `outDir`):
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "../../dist/apps/orders" },
  "include": ["src/**/*", "../../libs/**/*"],
  "exclude": ["node_modules", "dist", "**/*.spec.ts"]
}
```

`libs/contracts/tsconfig.lib.json` (and the same for `libs/messaging`):
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "declaration": true, "outDir": "../../dist/libs/contracts" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.spec.ts"]
}
```

`nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "monorepo": true,
  "root": "apps/orders",
  "sourceRoot": "apps/orders/src",
  "compilerOptions": { "webpack": true, "tsConfigPath": "apps/orders/tsconfig.app.json" },
  "projects": {
    "orders": { "type": "application", "root": "apps/orders", "entryFile": "main", "sourceRoot": "apps/orders/src", "compilerOptions": { "tsConfigPath": "apps/orders/tsconfig.app.json" } },
    "inventory": { "type": "application", "root": "apps/inventory", "entryFile": "main", "sourceRoot": "apps/inventory/src", "compilerOptions": { "tsConfigPath": "apps/inventory/tsconfig.app.json" } },
    "contracts": { "type": "library", "root": "libs/contracts", "entryFile": "index", "sourceRoot": "libs/contracts/src", "compilerOptions": { "tsConfigPath": "libs/contracts/tsconfig.lib.json" } },
    "messaging": { "type": "library", "root": "libs/messaging", "entryFile": "index", "sourceRoot": "libs/messaging/src", "compilerOptions": { "tsConfigPath": "libs/messaging/tsconfig.lib.json" } }
  }
}
```

`jest.config.js`:
```js
const base = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@app/contracts$': '<rootDir>/libs/contracts/src',
    '^@app/contracts/(.*)$': '<rootDir>/libs/contracts/src/$1',
    '^@app/messaging$': '<rootDir>/libs/messaging/src',
    '^@app/messaging/(.*)$': '<rootDir>/libs/messaging/src/$1',
  },
};

module.exports = {
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['apps/**/src/**/*.ts', 'libs/**/src/**/*.ts', '!**/main.ts', '!**/migrations/**'],
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/{apps,libs}/**/*.spec.ts'] },
    { ...base, displayName: 'int', testMatch: ['<rootDir>/test/int/**/*.int-spec.ts'], setupFilesAfterEnv: ['<rootDir>/test/support/timeout.ts'] },
    { ...base, displayName: 'e2e', testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'], setupFilesAfterEnv: ['<rootDir>/test/support/timeout.ts'] },
  ],
};
```

`test/support/timeout.ts`:
```ts
// Containers take a while to pull and start on a cold machine or CI runner.
jest.setTimeout(180_000);
```

`eslint.config.mjs`:
```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'jest.config.js'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
```

`.prettierrc`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 110 }
```

- [ ] **Step 3: Write the failing contract tests**

`libs/contracts/src/parse.spec.ts`:
```ts
import { ContractError, EventTypes, parseEvent, Topics } from './index';

const env = {
  eventId: '0b8c1f9e-3b7a-4c55-9d0e-1a2b3c4d5e6f',
  occurredAt: '2026-10-07T10:00:00.000Z',
  orderId: '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e',
};
const KEYBOARD = '11111111-1111-4111-8111-111111111111';
const raw = (v: unknown) => JSON.stringify(v);

describe('parseEvent', () => {
  it('accepts a valid order.created on order-events', () => {
    const e = parseEvent(
      Topics.OrderEvents,
      raw({ ...env, type: EventTypes.OrderCreated, items: [{ productId: KEYBOARD, quantity: 2 }] }),
    );
    expect(e).toMatchObject({ type: 'order.created', orderId: env.orderId });
  });

  it('accepts a valid stock.rejected on stock-events', () => {
    const e = parseEvent(Topics.StockEvents, raw({ ...env, type: EventTypes.StockRejected, reason: 'INSUFFICIENT_STOCK' }));
    expect(e.type).toBe('stock.rejected');
  });

  it.each([
    ['null', null],
    ['not JSON', 'not json'],
    ['a JSON array', '[]'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseEvent(Topics.OrderEvents, value)).toThrow(ContractError);
  });

  it('rejects an event on the wrong topic', () => {
    const value = raw({ ...env, type: EventTypes.StockReserved, lines: [] });
    expect(() => parseEvent(Topics.OrderEvents, value)).toThrow(/topic/);
  });

  it('rejects an unknown type', () => {
    expect(() => parseEvent(Topics.OrderEvents, raw({ ...env, type: 'order.exploded' }))).toThrow(ContractError);
  });

  it.each([
    ['empty items', []],
    ['zero quantity', [{ productId: KEYBOARD, quantity: 0 }]],
    ['fractional quantity', [{ productId: KEYBOARD, quantity: 1.5 }]],
    ['non-UUID productId', [{ productId: 'abc', quantity: 1 }]],
  ])('rejects order.created with %s', (_label, items) => {
    expect(() => parseEvent(Topics.OrderEvents, raw({ ...env, type: EventTypes.OrderCreated, items }))).toThrow(ContractError);
  });

  it('rejects a bad envelope', () => {
    const value = raw({ ...env, eventId: 'nope', type: EventTypes.OrderCancelled });
    expect(() => parseEvent(Topics.OrderEvents, value)).toThrow(/eventId/);
  });

  it('rejects an unknown rejection reason', () => {
    const value = raw({ ...env, type: EventTypes.StockRejected, reason: 'BORED' });
    expect(() => parseEvent(Topics.StockEvents, value)).toThrow(/reason/);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx jest --selectProjects unit libs/contracts`
Expected: FAIL, `Cannot find module './index'`.

- [ ] **Step 5: Implement `libs/contracts`**

`libs/contracts/src/topics.ts`:
```ts
export const Topics = { OrderEvents: 'order-events', StockEvents: 'stock-events' } as const;
export type Topic = (typeof Topics)[keyof typeof Topics];

export const EventTypes = {
  OrderCreated: 'order.created',
  OrderPaid: 'order.paid',
  OrderCancelled: 'order.cancelled',
  StockReserved: 'stock.reserved',
  StockRejected: 'stock.rejected',
} as const;
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export const dlqTopic = (topic: Topic): string => `${topic}.dlq`;

/** One topic per stream: every event for one order shares a topic, so Kafka keeps them in order. */
export const topicFor = (type: EventType): Topic => (type.startsWith('order.') ? Topics.OrderEvents : Topics.StockEvents);

export const ALL_TOPICS: string[] = [
  Topics.OrderEvents,
  Topics.StockEvents,
  dlqTopic(Topics.OrderEvents),
  dlqTopic(Topics.StockEvents),
];
```

`libs/contracts/src/events.ts`:
```ts
import { EventTypes } from './topics';

export interface EventEnvelope {
  eventId: string;
  occurredAt: string;
  orderId: string;
}

export interface OrderItemLine {
  productId: string;
  quantity: number;
}

export interface PricedLine {
  productId: string;
  unitPriceCents: number;
}

export type RejectionReason = 'INSUFFICIENT_STOCK' | 'UNKNOWN_PRODUCT';
export const REJECTION_REASONS: readonly RejectionReason[] = ['INSUFFICIENT_STOCK', 'UNKNOWN_PRODUCT'];

export interface OrderCreated extends EventEnvelope {
  type: typeof EventTypes.OrderCreated;
  items: OrderItemLine[];
}
export interface OrderPaid extends EventEnvelope {
  type: typeof EventTypes.OrderPaid;
  totalCents: number;
}
export interface OrderCancelled extends EventEnvelope {
  type: typeof EventTypes.OrderCancelled;
}
export interface StockReserved extends EventEnvelope {
  type: typeof EventTypes.StockReserved;
  lines: PricedLine[];
}
export interface StockRejected extends EventEnvelope {
  type: typeof EventTypes.StockRejected;
  reason: RejectionReason;
}

export type OrderEvent = OrderCreated | OrderPaid | OrderCancelled;
export type StockEvent = StockReserved | StockRejected;
export type AnyEvent = OrderEvent | StockEvent;
```

`libs/contracts/src/envelope.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from './events';

export function newEnvelope(orderId: string): EventEnvelope {
  return { eventId: randomUUID(), occurredAt: new Date().toISOString(), orderId };
}
```

`libs/contracts/src/parse.ts`:
```ts
import { AnyEvent, REJECTION_REASONS } from './events';
import { EventType, EventTypes, topicFor } from './topics';

export class ContractError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const KNOWN_TYPES = new Set<string>(Object.values(EventTypes));

function uuidField(o: Obj, field: string): void {
  if (!isUuid(o[field])) throw new ContractError(`${field} must be a UUID`);
}
function intField(o: Obj, field: string, min: number): void {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ContractError(`${field} must be an integer >= ${min}`);
  }
}
function lines(v: unknown, field: string, check: (line: Obj) => void): void {
  if (!Array.isArray(v) || v.length === 0) throw new ContractError(`${field} must be a non-empty array`);
  for (const line of v) {
    if (!isObj(line)) throw new ContractError(`${field} entries must be objects`);
    check(line);
  }
}

/** Validates a raw Kafka message value against the contract for the topic it arrived on. */
export function parseEvent(topic: string, raw: string | null): AnyEvent {
  if (raw === null) throw new ContractError('empty message');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ContractError('message is not JSON');
  }
  if (!isObj(v)) throw new ContractError('message is not a JSON object');
  if (typeof v.type !== 'string' || !KNOWN_TYPES.has(v.type)) throw new ContractError(`unknown type ${String(v.type)}`);
  const type = v.type as EventType;
  if (topicFor(type) !== topic) throw new ContractError(`type ${type} does not belong on topic ${topic}`);
  uuidField(v, 'eventId');
  uuidField(v, 'orderId');
  if (typeof v.occurredAt !== 'string' || Number.isNaN(Date.parse(v.occurredAt))) {
    throw new ContractError('occurredAt must be an ISO date');
  }

  switch (type) {
    case EventTypes.OrderCreated:
      lines(v.items, 'items', (l) => {
        uuidField(l, 'productId');
        intField(l, 'quantity', 1);
      });
      break;
    case EventTypes.OrderPaid:
      intField(v, 'totalCents', 0);
      break;
    case EventTypes.StockReserved:
      lines(v.lines, 'lines', (l) => {
        uuidField(l, 'productId');
        intField(l, 'unitPriceCents', 0);
      });
      break;
    case EventTypes.StockRejected:
      if (!REJECTION_REASONS.includes(v.reason as never)) throw new ContractError(`unknown reason ${String(v.reason)}`);
      break;
    case EventTypes.OrderCancelled:
      break;
  }
  return v as unknown as AnyEvent;
}
```

`libs/contracts/src/index.ts`:
```ts
export * from './topics';
export * from './events';
export * from './envelope';
export * from './parse';
```

- [ ] **Step 6: Run the tests, lint and typecheck**

Run: `npx jest --selectProjects unit libs/contracts && npm run lint && npm run typecheck`
Expected: all contract tests PASS; lint and typecheck report no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Nest monorepo; feat(contracts): event types and payload validator"
```

---

### Task 2: `libs/messaging` — retry policy and the message processor

**Files:**
- Create: `libs/messaging/src/logger.ts`, `retry.ts`, `consumer.ts`, `kafka.ts`, `index.ts`
- Test: `libs/messaging/src/retry.spec.ts`, `libs/messaging/src/consumer.spec.ts`

**Interfaces:**
- Consumes: `parseEvent`, `ContractError`, `Topic`, `dlqTopic`, `ALL_TOPICS`, `AnyEvent` from `@app/contracts`.
- Produces (import from `@app/messaging`):
  - `interface LoggerLike { log(m: string): void; warn(m: string): void; error(m: string): void }`
  - `MAX_ATTEMPTS = 3`, `backoffMs(attempt: number, baseMs: number): number`, `decide(err: unknown, attempt: number): 'retry' | 'dlq'`, `errMessage(e: unknown): string`
  - `interface RawMessage { topic: string; key: string | null; value: string | null }`
  - `interface DeadLetter { topic: string; key: string | null; original: string | null; error: string; attempts: number; failedAt: string }`
  - `processMessage(msg: RawMessage, deps: ProcessDeps): Promise<'handled' | 'dead-lettered'>` where `ProcessDeps = { handle(e: AnyEvent): Promise<void>; sendToDlq(d: DeadLetter): Promise<void>; sleep(ms: number): Promise<void>; baseBackoffMs: number; logger?: LoggerLike }`
  - `class EventConsumer { constructor(o: EventConsumerOptions); start(): Promise<void>; stop(): Promise<void> }` with `EventConsumerOptions = { kafka: Kafka; groupId: string; topic: Topic; handle(e: AnyEvent): Promise<void>; logger?: LoggerLike; baseBackoffMs?: number }`
  - `createKafka(clientId: string, brokers: string[]): Kafka`, `ensureTopics(kafka: Kafka, numPartitions?: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`libs/messaging/src/retry.spec.ts`:
```ts
import { ContractError } from '@app/contracts';
import { backoffMs, decide, MAX_ATTEMPTS } from './retry';

describe('retry policy', () => {
  it('doubles the backoff each attempt', () => {
    expect([1, 2, 3].map((a) => backoffMs(a, 200))).toEqual([200, 400, 800]);
  });

  it('retries a handler error until the last attempt, then dead-letters', () => {
    expect(decide(new Error('db down'), 1)).toBe('retry');
    expect(decide(new Error('db down'), MAX_ATTEMPTS - 1)).toBe('retry');
    expect(decide(new Error('db down'), MAX_ATTEMPTS)).toBe('dlq');
  });

  it('dead-letters a contract violation on the first attempt (retrying cannot fix it)', () => {
    expect(decide(new ContractError('bad payload'), 1)).toBe('dlq');
  });
});
```

`libs/messaging/src/consumer.spec.ts`:
```ts
import { EventTypes, Topics } from '@app/contracts';
import { DeadLetter, processMessage, ProcessDeps } from './consumer';

const valid = JSON.stringify({
  type: EventTypes.OrderCancelled,
  eventId: '0b8c1f9e-3b7a-4c55-9d0e-1a2b3c4d5e6f',
  occurredAt: '2026-10-07T10:00:00.000Z',
  orderId: '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e',
});
const msg = (value: string | null) => ({ topic: Topics.OrderEvents, key: 'k', value });

function deps(handle: ProcessDeps['handle']) {
  const dead: DeadLetter[] = [];
  const sleeps: number[] = [];
  const d: ProcessDeps = {
    handle,
    sendToDlq: async (x) => void dead.push(x),
    sleep: async (ms) => void sleeps.push(ms),
    baseBackoffMs: 200,
  };
  return { d, dead, sleeps };
}

describe('processMessage', () => {
  it('hands a valid event to the handler once', async () => {
    const handle = jest.fn().mockResolvedValue(undefined);
    const { d, dead } = deps(handle);
    await expect(processMessage(msg(valid), d)).resolves.toBe('handled');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(dead).toHaveLength(0);
  });

  it('retries a transient failure with backoff and then succeeds', async () => {
    const handle = jest.fn().mockRejectedValueOnce(new Error('deadlock')).mockResolvedValue(undefined);
    const { d, dead, sleeps } = deps(handle);
    await expect(processMessage(msg(valid), d)).resolves.toBe('handled');
    expect(handle).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([200]);
    expect(dead).toHaveLength(0);
  });

  it('dead-letters after 3 failed attempts, keeping the original and the error', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('always broken'));
    const { d, dead, sleeps } = deps(handle);
    await expect(processMessage(msg(valid), d)).resolves.toBe('dead-lettered');
    expect(handle).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 400]);
    expect(dead[0]).toMatchObject({ topic: 'order-events', key: 'k', original: valid, error: 'always broken', attempts: 3 });
  });

  it('dead-letters a malformed message immediately without calling the handler', async () => {
    const handle = jest.fn();
    const { d, dead, sleeps } = deps(handle);
    await expect(processMessage(msg('not json'), d)).resolves.toBe('dead-lettered');
    expect(handle).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
    expect(dead[0]).toMatchObject({ original: 'not json', attempts: 1 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest --selectProjects unit libs/messaging`
Expected: FAIL, `Cannot find module './retry'` and `'./consumer'`.

- [ ] **Step 3: Implement**

`libs/messaging/src/logger.ts`:
```ts
/** The subset of Nest's Logger the plumbing needs; keeps libs/messaging free of Nest. */
export interface LoggerLike {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
```

`libs/messaging/src/retry.ts`:
```ts
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
```

`libs/messaging/src/consumer.ts`:
```ts
import { AnyEvent, dlqTopic, parseEvent, Topic } from '@app/contracts';
import { Consumer, Kafka, Producer } from 'kafkajs';
import { LoggerLike } from './logger';
import { backoffMs, decide, errMessage } from './retry';

export interface RawMessage {
  topic: string;
  key: string | null;
  value: string | null;
}

export interface DeadLetter {
  topic: string;
  key: string | null;
  original: string | null;
  error: string;
  attempts: number;
  failedAt: string;
}

export interface ProcessDeps {
  handle(event: AnyEvent): Promise<void>;
  sendToDlq(letter: DeadLetter): Promise<void>;
  sleep(ms: number): Promise<void>;
  baseBackoffMs: number;
  logger?: LoggerLike;
}

/** Parse, handle, retry with backoff, and dead-letter what can't be handled — so one bad message never blocks a partition. */
export async function processMessage(msg: RawMessage, deps: ProcessDeps): Promise<'handled' | 'dead-lettered'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.handle(parseEvent(msg.topic, msg.value));
      return 'handled';
    } catch (err) {
      if (decide(err, attempt) === 'retry') {
        deps.logger?.warn(`${msg.topic} attempt ${attempt} failed: ${errMessage(err)}; retrying`);
        await deps.sleep(backoffMs(attempt, deps.baseBackoffMs));
        continue;
      }
      await deps.sendToDlq({
        topic: msg.topic,
        key: msg.key,
        original: msg.value,
        error: errMessage(err),
        attempts: attempt,
        failedAt: new Date().toISOString(),
      });
      deps.logger?.error(`${msg.topic} message dead-lettered after ${attempt} attempt(s): ${errMessage(err)}`);
      return 'dead-lettered';
    }
  }
}

export interface EventConsumerOptions {
  kafka: Kafka;
  groupId: string;
  topic: Topic;
  handle(event: AnyEvent): Promise<void>;
  logger?: LoggerLike;
  baseBackoffMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EventConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: Producer;

  constructor(private readonly o: EventConsumerOptions) {
    this.consumer = o.kafka.consumer({ groupId: o.groupId });
    this.dlqProducer = o.kafka.producer();
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.o.topic, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        await processMessage(
          { topic: this.o.topic, key: message.key?.toString() ?? null, value: message.value?.toString() ?? null },
          {
            handle: this.o.handle,
            sendToDlq: async (letter) => {
              await this.dlqProducer.send({
                topic: dlqTopic(this.o.topic),
                messages: [{ key: letter.key, value: JSON.stringify(letter) }],
              });
            },
            sleep,
            baseBackoffMs: this.o.baseBackoffMs ?? 200,
            logger: this.o.logger,
          },
        );
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
```

`libs/messaging/src/kafka.ts`:
```ts
import { ALL_TOPICS } from '@app/contracts';
import { Kafka, logLevel } from 'kafkajs';

export function createKafka(clientId: string, brokers: string[]): Kafka {
  return new Kafka({ clientId, brokers, logLevel: logLevel.WARN });
}

function isAlreadyExists(e: unknown): boolean {
  const errors = (e as { errors?: { type?: string }[] }).errors;
  return Array.isArray(errors) && errors.length > 0 && errors.every((x) => x.type === 'TOPIC_ALREADY_EXISTS');
}

/** Idempotent: both services call it on boot, possibly at the same time. */
export async function ensureTopics(kafka: Kafka, numPartitions = 3): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: ALL_TOPICS.map((topic) => ({ topic, numPartitions, replicationFactor: 1 })),
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  } finally {
    await admin.disconnect();
  }
}
```

`libs/messaging/src/index.ts`:
```ts
export * from './logger';
export * from './retry';
export * from './consumer';
export * from './kafka';
```

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx jest --selectProjects unit libs/messaging && npm run lint && npm run typecheck`
Expected: PASS, no lint or type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(messaging): retry policy, message processor with DLQ, Kafka helpers"
```

---

### Task 3: Orders domain rules (pure)

**Files:**
- Create: `apps/orders/src/orders/order-status.ts`, `order-state.ts`, `errors.ts`, `order-input.ts`, `pagination.ts`
- Test: `apps/orders/src/orders/order-state.spec.ts`, `order-input.spec.ts`, `pagination.spec.ts`

**Interfaces:**
- Consumes: `isUuid`, `OrderItemLine` from `@app/contracts`.
- Produces:
  - `enum OrderStatus { PENDING, RESERVED, REJECTED, PAID, CANCELLED }` (string values equal to names)
  - `canTransition(from: OrderStatus, to: OrderStatus): boolean`, `assertTransition(from, to): void`, `class InvalidStateError extends Error`
  - `class InvalidInputError extends Error`, `class OrderNotFoundError extends Error { constructor(id: string) }`
  - `MAX_LINES = 50`, `MAX_QUANTITY = 1000`, `assertUuid(value: string, field: string): void`, `validateItems(items: OrderItemLine[]): void`
  - `DEFAULT_PAGE_SIZE = 20`, `MAX_PAGE_SIZE = 100`, `pageSize(first?: number | null): number`, `interface Cursor { createdAt: string; id: string }`, `encodeCursor(c: { createdAt: Date; id: string }): string`, `decodeCursor(s: string): Cursor`

- [ ] **Step 1: Write the failing tests**

`apps/orders/src/orders/order-state.spec.ts`:
```ts
import { assertTransition, canTransition, InvalidStateError } from './order-state';
import { OrderStatus as S } from './order-status';

describe('order state machine', () => {
  it.each([
    [S.PENDING, S.RESERVED],
    [S.PENDING, S.REJECTED],
    [S.PENDING, S.CANCELLED],
    [S.RESERVED, S.PAID],
    [S.RESERVED, S.CANCELLED],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    [S.PENDING, S.PAID],
    [S.REJECTED, S.PAID],
    [S.REJECTED, S.CANCELLED],
    [S.PAID, S.CANCELLED],
    [S.CANCELLED, S.CANCELLED],
    [S.PAID, S.PAID],
    [S.RESERVED, S.RESERVED],
  ])('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidStateError);
  });
});
```

`apps/orders/src/orders/order-input.spec.ts`:
```ts
import { InvalidInputError } from './errors';
import { MAX_LINES, validateItems } from './order-input';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

describe('validateItems', () => {
  it('accepts a normal order', () => {
    expect(() => validateItems([{ productId: P1, quantity: 2 }, { productId: P2, quantity: 1 }])).not.toThrow();
  });

  it.each([
    ['no items', []],
    ['quantity 0', [{ productId: P1, quantity: 0 }]],
    ['negative quantity', [{ productId: P1, quantity: -1 }]],
    ['quantity over 1000', [{ productId: P1, quantity: 1001 }]],
    ['fractional quantity', [{ productId: P1, quantity: 1.5 }]],
    ['a non-UUID productId', [{ productId: 'keyboard', quantity: 1 }]],
    ['the same product twice', [{ productId: P1, quantity: 1 }, { productId: P1, quantity: 2 }]],
    ['too many lines', Array.from({ length: MAX_LINES + 1 }, (_, i) => ({ productId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, quantity: 1 }))],
  ])('rejects %s', (_label, items) => {
    expect(() => validateItems(items)).toThrow(InvalidInputError);
  });
});
```

`apps/orders/src/orders/pagination.spec.ts`:
```ts
import { InvalidInputError } from './errors';
import { decodeCursor, encodeCursor, MAX_PAGE_SIZE, pageSize } from './pagination';

describe('pagination', () => {
  it('defaults to 20 and caps at 100', () => {
    expect(pageSize(undefined)).toBe(20);
    expect(pageSize(null)).toBe(20);
    expect(pageSize(5)).toBe(5);
    expect(pageSize(1000)).toBe(MAX_PAGE_SIZE);
  });

  it('rejects a page size below 1', () => {
    expect(() => pageSize(0)).toThrow(InvalidInputError);
  });

  it('round-trips a cursor', () => {
    const c = encodeCursor({ createdAt: new Date('2026-10-07T10:00:00.123Z'), id: '11111111-1111-4111-8111-111111111111' });
    expect(decodeCursor(c)).toEqual({ createdAt: '2026-10-07T10:00:00.123Z', id: '11111111-1111-4111-8111-111111111111' });
  });

  it.each(['garbage', Buffer.from('no-separator').toString('base64url'), Buffer.from('not-a-date|abc').toString('base64url')])(
    'rejects a malformed cursor %s',
    (c) => {
      expect(() => decodeCursor(c)).toThrow(InvalidInputError);
    },
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest --selectProjects unit apps/orders`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/orders/src/orders/order-status.ts`:
```ts
export enum OrderStatus {
  PENDING = 'PENDING',
  RESERVED = 'RESERVED',
  REJECTED = 'REJECTED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}
```

`apps/orders/src/orders/order-state.ts`:
```ts
import { OrderStatus as S } from './order-status';

const ALLOWED: Record<S, readonly S[]> = {
  [S.PENDING]: [S.RESERVED, S.REJECTED, S.CANCELLED],
  [S.RESERVED]: [S.PAID, S.CANCELLED],
  [S.REJECTED]: [],
  [S.PAID]: [],
  [S.CANCELLED]: [],
};

export class InvalidStateError extends Error {
  constructor(
    readonly from: S,
    readonly to: S,
  ) {
    super(`Cannot move an order from ${from} to ${to}`);
  }
}

export const canTransition = (from: S, to: S): boolean => ALLOWED[from].includes(to);

export function assertTransition(from: S, to: S): void {
  if (!canTransition(from, to)) throw new InvalidStateError(from, to);
}
```

`apps/orders/src/orders/errors.ts`:
```ts
export class InvalidInputError extends Error {}

export class OrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Order ${id} not found`);
  }
}
```

`apps/orders/src/orders/order-input.ts`:
```ts
import { isUuid, OrderItemLine } from '@app/contracts';
import { InvalidInputError } from './errors';

export const MAX_LINES = 50;
export const MAX_QUANTITY = 1000;

export function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) throw new InvalidInputError(`${field} must be a UUID`);
}

export function validateItems(items: OrderItemLine[]): void {
  if (items.length === 0) throw new InvalidInputError('An order needs at least one item');
  if (items.length > MAX_LINES) throw new InvalidInputError(`An order can have at most ${MAX_LINES} lines`);
  const seen = new Set<string>();
  for (const item of items) {
    assertUuid(item.productId, 'productId');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      throw new InvalidInputError(`quantity must be an integer from 1 to ${MAX_QUANTITY}`);
    }
    if (seen.has(item.productId)) {
      throw new InvalidInputError(`productId ${item.productId} appears twice; combine the quantities`);
    }
    seen.add(item.productId);
  }
}
```

`apps/orders/src/orders/pagination.ts`:
```ts
import { isUuid } from '@app/contracts';
import { InvalidInputError } from './errors';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface Cursor {
  createdAt: string;
  id: string;
}

export function pageSize(first?: number | null): number {
  if (first === undefined || first === null) return DEFAULT_PAGE_SIZE;
  if (first < 1) throw new InvalidInputError('first must be at least 1');
  return Math.min(first, MAX_PAGE_SIZE);
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !createdAt || Number.isNaN(Date.parse(createdAt)) || !isUuid(id)) {
    throw new InvalidInputError('after is not a valid cursor');
  }
  return { createdAt, id };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest --selectProjects unit apps/orders && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orders): state machine, input validation and cursor pagination"
```

---

### Task 4: `libs/messaging` — outbox and idempotency guard (against real PostgreSQL)

**Files:**
- Create: `libs/messaging/src/schema.ts`, `idempotency.ts`, `outbox.ts`; modify `libs/messaging/src/index.ts`
- Create: `test/support/postgres.ts`, `test/support/fake-producer.ts`
- Test: `test/int/messaging.int-spec.ts`

**Interfaces:**
- Consumes: `AnyEvent`, `topicFor` from `@app/contracts`; `LoggerLike`, `errMessage` from Task 2.
- Produces (from `@app/messaging`):
  - `MESSAGING_TABLES_SQL: string`, `DROP_MESSAGING_TABLES_SQL: string` (both apps' migrations run these)
  - `class ProcessedEvent` entity (`processed_events`), `markProcessed(m: EntityManager, eventId: string): Promise<boolean>` (true = first time)
  - `class OutboxMessage` entity (`outbox`: `seq`, `eventId`, `topic`, `key`, `payload`, `createdAt`, `sentAt`)
  - `enqueue(m: EntityManager, event: AnyEvent): Promise<void>`
  - `type ProducerLike = Pick<Producer, 'connect' | 'disconnect' | 'sendBatch'>`
  - `class OutboxPublisher { constructor(ds: DataSource, producer: ProducerLike, o: { intervalMs: number; batchSize?: number; logger?: LoggerLike }); start(): Promise<void>; stop(): Promise<void>; publishBatch(): Promise<number> }`
  - test support: `startPostgres(): Promise<{ container: StartedPostgreSqlContainer; ordersUrl: string; inventoryUrl: string }>`, `class FakeProducer implements ProducerLike { sent: { topic: string; key: string; value: string }[]; failNext: number }`

- [ ] **Step 1: Write the test support files**

`test/support/postgres.ts`:
```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/** One PostgreSQL container holding both service databases, like docker-compose does. */
export async function startPostgres(): Promise<{
  container: StartedPostgreSqlContainer;
  ordersUrl: string;
  inventoryUrl: string;
}> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orders')
    .withUsername('orderflow')
    .withPassword('orderflow')
    .start();
  const base = `postgres://orderflow:orderflow@${container.getHost()}:${container.getMappedPort(5432)}`;
  const admin = new Client({ connectionString: `${base}/orders` });
  await admin.connect();
  await admin.query('CREATE DATABASE inventory');
  await admin.end();
  return { container, ordersUrl: `${base}/orders`, inventoryUrl: `${base}/inventory` };
}
```

`test/support/fake-producer.ts`:
```ts
import { ProducerLike } from '@app/messaging';

type SendBatchArgs = Parameters<ProducerLike['sendBatch']>[0];

/** Records what would have gone to Kafka; `failNext` makes the next N sends throw like a broker outage. */
export class FakeProducer implements ProducerLike {
  sent: { topic: string; key: string; value: string }[] = [];
  failNext = 0;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async sendBatch(batch: SendBatchArgs) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    for (const tm of batch.topicMessages ?? []) {
      for (const m of tm.messages) this.sent.push({ topic: tm.topic, key: String(m.key), value: String(m.value) });
    }
    return [];
  }
}
```

- [ ] **Step 2: Write the failing integration test**

`test/int/messaging.int-spec.ts`:
```ts
import { EventTypes, newEnvelope, OrderCancelled } from '@app/contracts';
import {
  enqueue,
  markProcessed,
  MESSAGING_TABLES_SQL,
  OutboxMessage,
  OutboxPublisher,
  ProcessedEvent,
} from '@app/messaging';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { FakeProducer } from '../support/fake-producer';
import { startPostgres } from '../support/postgres';

const ORDER = '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e';
const cancelled = (): OrderCancelled => ({ ...newEnvelope(ORDER), type: EventTypes.OrderCancelled });

describe('messaging persistence', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ds = await new DataSource({ type: 'postgres', url: started.ordersUrl, entities: [OutboxMessage, ProcessedEvent] }).initialize();
    await ds.query(MESSAGING_TABLES_SQL);
  });
  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });
  beforeEach(() => ds.query('TRUNCATE outbox, processed_events'));

  describe('markProcessed', () => {
    it('returns true the first time and false for a repeat', async () => {
      const id = newEnvelope(ORDER).eventId;
      await expect(ds.transaction((m) => markProcessed(m, id))).resolves.toBe(true);
      await expect(ds.transaction((m) => markProcessed(m, id))).resolves.toBe(false);
    });

    it('is rolled back with the transaction it ran in', async () => {
      const id = newEnvelope(ORDER).eventId;
      await expect(
        ds.transaction(async (m) => {
          await markProcessed(m, id);
          throw new Error('handler failed');
        }),
      ).rejects.toThrow('handler failed');
      await expect(ds.transaction((m) => markProcessed(m, id))).resolves.toBe(true);
    });
  });

  describe('OutboxPublisher.publishBatch', () => {
    it('publishes unsent rows in order, keyed by orderId, and marks them sent', async () => {
      const a = cancelled();
      const b = cancelled();
      await ds.transaction(async (m) => {
        await enqueue(m, a);
        await enqueue(m, b);
      });
      const producer = new FakeProducer();
      const publisher = new OutboxPublisher(ds, producer, { intervalMs: 1000 });

      await expect(publisher.publishBatch()).resolves.toBe(2);
      expect(producer.sent.map((s) => JSON.parse(s.value).eventId)).toEqual([a.eventId, b.eventId]);
      expect(producer.sent.every((s) => s.topic === 'order-events' && s.key === ORDER)).toBe(true);
      await expect(publisher.publishBatch()).resolves.toBe(0);
      expect(producer.sent).toHaveLength(2);
    });

    it('keeps rows unsent when Kafka is down and sends them on the next run', async () => {
      await ds.transaction((m) => enqueue(m, cancelled()));
      const producer = new FakeProducer();
      producer.failNext = 1;
      const publisher = new OutboxPublisher(ds, producer, { intervalMs: 1000 });

      await expect(publisher.publishBatch()).rejects.toThrow('broker unavailable');
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM outbox WHERE sent_at IS NULL`);
      expect(count).toBe(1);

      await expect(publisher.publishBatch()).resolves.toBe(1);
      expect(producer.sent).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:int -- test/int/messaging`
Expected: FAIL, `enqueue` / `OutboxPublisher` not exported from `@app/messaging`.

- [ ] **Step 4: Implement**

`libs/messaging/src/schema.ts`:
```ts
/** Tables every service needs for the outbox and the idempotency guard. Both apps' first migration runs this. */
export const MESSAGING_TABLES_SQL = `
  CREATE TABLE outbox (
    seq         bigserial PRIMARY KEY,
    event_id    uuid        NOT NULL UNIQUE,
    topic       varchar(64) NOT NULL,
    key         varchar(64) NOT NULL,
    payload     jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz
  );
  CREATE INDEX outbox_unsent_idx ON outbox (seq) WHERE sent_at IS NULL;
  CREATE TABLE processed_events (
    event_id     uuid PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
  );
`;

export const DROP_MESSAGING_TABLES_SQL = `DROP TABLE processed_events; DROP TABLE outbox;`;
```

`libs/messaging/src/idempotency.ts`:
```ts
import { CreateDateColumn, Entity, EntityManager, PrimaryColumn } from 'typeorm';

@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}

/**
 * Records the event in the caller's transaction. Returns false if it was already processed,
 * so a redelivered Kafka message changes nothing.
 */
export async function markProcessed(m: EntityManager, eventId: string): Promise<boolean> {
  const rows: unknown[] = await m.query(
    'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
    [eventId],
  );
  return rows.length === 1;
}
```

`libs/messaging/src/outbox.ts`:
```ts
import { AnyEvent, topicFor } from '@app/contracts';
import { Producer } from 'kafkajs';
import { Column, CreateDateColumn, DataSource, Entity, EntityManager, In, PrimaryGeneratedColumn } from 'typeorm';
import { LoggerLike } from './logger';
import { errMessage } from './retry';

@Entity('outbox')
export class OutboxMessage {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  seq!: string;

  @Column('uuid', { name: 'event_id', unique: true })
  eventId!: string;

  @Column('varchar', { length: 64 })
  topic!: string;

  @Column('varchar', { length: 64 })
  key!: string;

  @Column('jsonb')
  payload!: AnyEvent;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'sent_at', nullable: true })
  sentAt!: Date | null;
}

/** Call inside the same transaction as the state change the event describes. */
export async function enqueue(m: EntityManager, event: AnyEvent): Promise<void> {
  await m.insert(OutboxMessage, { eventId: event.eventId, topic: topicFor(event.type), key: event.orderId, payload: event });
}

export type ProducerLike = Pick<Producer, 'connect' | 'disconnect' | 'sendBatch'>;

export interface OutboxPublisherOptions {
  intervalMs: number;
  batchSize?: number;
  logger?: LoggerLike;
}

export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(
    private readonly ds: DataSource,
    private readonly producer: ProducerLike,
    private readonly o: OutboxPublisherOptions,
  ) {}

  async start(): Promise<void> {
    await this.producer.connect();
    this.timer = setInterval(() => {
      if (this.inFlight) return; // never overlap two batches
      this.inFlight = this.publishBatch()
        .then(() => undefined)
        .catch((e) => this.o.logger?.warn(`outbox publish failed, will retry: ${errMessage(e)}`))
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.o.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
    await this.producer.disconnect();
  }

  /**
   * Sends the oldest unsent rows and marks them sent, in one transaction. If Kafka throws, the transaction
   * rolls back and the rows go out on a later run. SKIP LOCKED lets two publisher instances share the table.
   */
  async publishBatch(): Promise<number> {
    return this.ds.transaction(async (m) => {
      const rows = await m
        .createQueryBuilder(OutboxMessage, 'o')
        .where('o.sent_at IS NULL')
        .orderBy('o.seq', 'ASC')
        .limit(this.o.batchSize ?? 100)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      if (rows.length === 0) return 0;

      const byTopic = new Map<string, { key: string; value: string }[]>();
      for (const row of rows) {
        const list = byTopic.get(row.topic) ?? [];
        list.push({ key: row.key, value: JSON.stringify(row.payload) });
        byTopic.set(row.topic, list);
      }
      await this.producer.sendBatch({
        topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
      });
      await m.update(OutboxMessage, { seq: In(rows.map((r) => r.seq)) }, { sentAt: new Date() });
      return rows.length;
    });
  }
}
```

Append to `libs/messaging/src/index.ts`:
```ts
export * from './schema';
export * from './idempotency';
export * from './outbox';
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:int -- test/int/messaging && npm run lint && npm run typecheck`
Expected: PASS (the first run pulls `postgres:16-alpine`, which can take a minute).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(messaging): transactional outbox publisher and processed_events guard"
```

---

### Task 5: Orders persistence and `OrdersService`

**Files:**
- Create: `apps/orders/src/config.ts`, `data-source.ts`, `migrations/1728300000000-init-orders.ts`, `orders/order.entity.ts`, `orders/order-item.entity.ts`, `orders/orders.service.ts`
- Test: `test/int/orders.int-spec.ts`

**Interfaces:**
- Consumes: everything from Task 3; `enqueue`, `markProcessed`, `OutboxMessage`, `ProcessedEvent`, `MESSAGING_TABLES_SQL`, `DROP_MESSAGING_TABLES_SQL` (Task 4); `newEnvelope`, `EventTypes`, `OrderItemLine`, `StockEvent`, `OrderEvent` (Task 1).
- Produces:
  - `ordersConfig(): { databaseUrl: string; kafkaBrokers: string[]; port: number; outboxIntervalMs: number }`
  - `ordersDataSourceOptions(url: string): DataSourceOptions` (runs migrations on initialise)
  - entities `Order { id; status: OrderStatus; totalCents: number | null; rejectionReason: string | null; items: OrderItem[]; createdAt: Date; updatedAt: Date }`, `OrderItem { id; order; productId; quantity; unitPriceCents: number | null }`
  - `OrdersService(dataSource: DataSource)` with `create(items: OrderItemLine[]): Promise<Order>`, `pay(id: string): Promise<Order>`, `cancel(id: string): Promise<Order>`, `findById(id: string): Promise<Order | null>`, `list(o: { status?: OrderStatus | null; first?: number | null; after?: string | null }): Promise<OrderPage>`, `applyStockReply(e: StockEvent): Promise<void>`; `interface OrderPage { nodes: Order[]; endCursor: string | null; hasNextPage: boolean }`

- [ ] **Step 1: Write the failing integration test**

`test/int/orders.int-spec.ts`:
```ts
import { EventTypes, newEnvelope, StockRejected, StockReserved } from '@app/contracts';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ordersDataSourceOptions } from '../../apps/orders/src/data-source';
import { InvalidInputError, OrderNotFoundError } from '../../apps/orders/src/orders/errors';
import { InvalidStateError } from '../../apps/orders/src/orders/order-state';
import { OrderStatus } from '../../apps/orders/src/orders/order-status';
import { OrdersService } from '../../apps/orders/src/orders/orders.service';
import { startPostgres } from '../support/postgres';

const KEYBOARD = '11111111-1111-4111-8111-111111111111';
const MOUSE = '22222222-2222-4222-8222-222222222222';
const MISSING = '99999999-9999-4999-8999-999999999999';

describe('OrdersService (real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let orders: OrdersService;

  const outboxTypes = async (orderId: string) =>
    (await ds.query(`SELECT payload->>'type' AS type FROM outbox WHERE key = $1 ORDER BY seq`, [orderId])).map(
      (r: { type: string }) => r.type,
    );
  const reserved = (orderId: string): StockReserved => ({
    ...newEnvelope(orderId),
    type: EventTypes.StockReserved,
    lines: [
      { productId: KEYBOARD, unitPriceCents: 8999 },
      { productId: MOUSE, unitPriceCents: 2999 },
    ],
  });

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ds = await new DataSource(ordersDataSourceOptions(started.ordersUrl)).initialize();
    orders = new OrdersService(ds);
  });
  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });
  beforeEach(() => ds.query('TRUNCATE orders, order_items, outbox, processed_events CASCADE'));

  it('creates a PENDING order and its order.created outbox row together', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 2 }]);
    expect(o.status).toBe(OrderStatus.PENDING);
    expect(o.items).toHaveLength(1);
    expect(await outboxTypes(o.id)).toEqual(['order.created']);
  });

  it('saves nothing when the outbox write fails (both or neither)', async () => {
    await ds.query('ALTER TABLE outbox ADD CONSTRAINT always_fail CHECK (false) NOT VALID');
    try {
      await expect(orders.create([{ productId: KEYBOARD, quantity: 1 }])).rejects.toThrow();
      const [{ count }] = await ds.query('SELECT count(*)::int AS count FROM orders');
      expect(count).toBe(0);
    } finally {
      await ds.query('ALTER TABLE outbox DROP CONSTRAINT always_fail');
    }
  });

  it('rejects invalid input before touching the database', async () => {
    await expect(orders.create([])).rejects.toThrow(InvalidInputError);
  });

  it('applies stock.reserved: RESERVED, prices filled in, total computed', async () => {
    const o = await orders.create([
      { productId: KEYBOARD, quantity: 2 },
      { productId: MOUSE, quantity: 1 },
    ]);
    await orders.applyStockReply(reserved(o.id));
    const after = await orders.findById(o.id);
    expect(after).toMatchObject({ status: OrderStatus.RESERVED, totalCents: 2 * 8999 + 2999 });
    expect(after?.items.map((i) => i.unitPriceCents).sort()).toEqual([2999, 8999]);
  });

  it('applies stock.rejected with its reason', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    const rejected: StockRejected = { ...newEnvelope(o.id), type: EventTypes.StockRejected, reason: 'INSUFFICIENT_STOCK' };
    await orders.applyStockReply(rejected);
    expect(await orders.findById(o.id)).toMatchObject({ status: OrderStatus.REJECTED, rejectionReason: 'INSUFFICIENT_STOCK' });
  });

  it('ignores a duplicate stock reply', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    const reply = reserved(o.id);
    await orders.applyStockReply(reply);
    await orders.pay(o.id);
    await orders.applyStockReply(reply); // redelivered after the order moved on
    expect((await orders.findById(o.id))?.status).toBe(OrderStatus.PAID);
  });

  it('ignores a stock reply for an order cancelled in the meantime', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await orders.cancel(o.id);
    await orders.applyStockReply(reserved(o.id));
    expect((await orders.findById(o.id))?.status).toBe(OrderStatus.CANCELLED);
  });

  it('pays a RESERVED order and emits order.paid with the total', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await orders.applyStockReply(reserved(o.id));
    await expect(orders.pay(o.id)).resolves.toMatchObject({ status: OrderStatus.PAID });
    const [paid] = await ds.query(`SELECT payload FROM outbox WHERE key = $1 AND payload->>'type' = 'order.paid'`, [o.id]);
    expect(paid.payload.totalCents).toBe(8999);
  });

  it('refuses to pay a PENDING order', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await expect(orders.pay(o.id)).rejects.toThrow(InvalidStateError);
    expect(await outboxTypes(o.id)).toEqual(['order.created']);
  });

  it('cancels and emits order.cancelled; a second cancel is INVALID_STATE', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await expect(orders.cancel(o.id)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    await expect(orders.cancel(o.id)).rejects.toThrow(InvalidStateError);
    expect(await outboxTypes(o.id)).toEqual(['order.created', 'order.cancelled']);
  });

  it('NOT_FOUND for an unknown id, BAD_USER_INPUT for a non-UUID id', async () => {
    await expect(orders.pay(MISSING)).rejects.toThrow(OrderNotFoundError);
    await expect(orders.cancel('not-a-uuid')).rejects.toThrow(InvalidInputError);
    await expect(orders.findById('not-a-uuid')).rejects.toThrow(InvalidInputError);
    await expect(orders.findById(MISSING)).resolves.toBeNull();
  });

  it('pages through orders with a cursor, filters by status and caps first', async () => {
    const created = [];
    for (let i = 0; i < 3; i++) created.push(await orders.create([{ productId: KEYBOARD, quantity: 1 }]));
    await orders.cancel(created[2].id);

    const page1 = await orders.list({ first: 2 });
    expect(page1.nodes.map((n) => n.id)).toEqual([created[0].id, created[1].id]);
    expect(page1.hasNextPage).toBe(true);
    const page2 = await orders.list({ first: 2, after: page1.endCursor });
    expect(page2.nodes.map((n) => n.id)).toEqual([created[2].id]);
    expect(page2.hasNextPage).toBe(false);

    expect((await orders.list({ status: OrderStatus.CANCELLED })).nodes).toHaveLength(1);
    expect((await orders.list({ first: 1000 })).nodes).toHaveLength(3);
    await expect(orders.list({ after: 'garbage' })).rejects.toThrow(InvalidInputError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:int -- test/int/orders`
Expected: FAIL, `Cannot find module '../../apps/orders/src/data-source'`.

- [ ] **Step 3: Implement config, entities, migration and data source**

`apps/orders/src/config.ts`:
```ts
/** Read when a module initialises, never at import time, and every value has a local default. */
export function ordersConfig() {
  return {
    databaseUrl: process.env.ORDERS_DATABASE_URL ?? 'postgres://orderflow:orderflow@localhost:5432/orders',
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    port: Number(process.env.ORDERS_PORT ?? 3000),
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
  };
}
```

`apps/orders/src/orders/order.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 16 })
  status!: OrderStatus;

  @Column('integer', { name: 'total_cents', nullable: true })
  totalCents!: number | null;

  @Column('varchar', { name: 'rejection_reason', length: 32, nullable: true })
  rejectionReason!: string | null;

  // Not eager: FOR UPDATE can't lock the nullable side of the LEFT JOIN an eager relation adds.
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items!: OrderItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
```

`apps/orders/src/orders/order-item.entity.ts`:
```ts
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Order } from './order.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column('uuid', { name: 'product_id' })
  productId!: string;

  @Column('integer')
  quantity!: number;

  @Column('integer', { name: 'unit_price_cents', nullable: true })
  unitPriceCents!: number | null;
}
```

`apps/orders/src/migrations/1728300000000-init-orders.ts`:
```ts
import { DROP_MESSAGING_TABLES_SQL, MESSAGING_TABLES_SQL } from '@app/messaging';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitOrders1728300000000 implements MigrationInterface {
  name = 'InitOrders1728300000000';

  async up(q: QueryRunner): Promise<void> {
    // timestamptz(3): millisecond precision, so a JS Date round-trips exactly in pagination cursors.
    await q.query(`
      CREATE TABLE orders (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status           varchar(16) NOT NULL,
        total_cents      integer,
        rejection_reason varchar(32),
        created_at       timestamptz(3) NOT NULL DEFAULT now(),
        updated_at       timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX orders_created_idx ON orders (created_at, id);
      CREATE INDEX orders_status_created_idx ON orders (status, created_at, id);
      CREATE TABLE order_items (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id       uuid NOT NULL,
        quantity         integer NOT NULL CHECK (quantity > 0),
        unit_price_cents integer
      );
      CREATE INDEX order_items_order_idx ON order_items (order_id);
    `);
    await q.query(MESSAGING_TABLES_SQL);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(DROP_MESSAGING_TABLES_SQL);
    await q.query('DROP TABLE order_items; DROP TABLE orders;');
  }
}
```

`apps/orders/src/data-source.ts`:
```ts
import { OutboxMessage, ProcessedEvent } from '@app/messaging';
import { DataSourceOptions } from 'typeorm';
import { InitOrders1728300000000 } from './migrations/1728300000000-init-orders';
import { OrderItem } from './orders/order-item.entity';
import { Order } from './orders/order.entity';

export function ordersDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [Order, OrderItem, OutboxMessage, ProcessedEvent],
    migrations: [InitOrders1728300000000],
    migrationsRun: true,
    synchronize: false,
  };
}
```

- [ ] **Step 4: Implement `OrdersService`**

`apps/orders/src/orders/orders.service.ts`:
```ts
import { EventTypes, newEnvelope, OrderEvent, OrderItemLine, StockEvent } from '@app/contracts';
import { enqueue, markProcessed } from '@app/messaging';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OrderNotFoundError } from './errors';
import { assertUuid, validateItems } from './order-input';
import { OrderItem } from './order-item.entity';
import { assertTransition } from './order-state';
import { OrderStatus } from './order-status';
import { Order } from './order.entity';
import { decodeCursor, encodeCursor, pageSize } from './pagination';

export interface OrderPage {
  nodes: Order[];
  endCursor: string | null;
  hasNextPage: boolean;
}

@Injectable()
export class OrdersService {
  constructor(private readonly dataSource: DataSource) {}

  async create(items: OrderItemLine[]): Promise<Order> {
    validateItems(items);
    return this.dataSource.transaction(async (m) => {
      const order = m.create(Order, {
        status: OrderStatus.PENDING,
        totalCents: null,
        rejectionReason: null,
        items: items.map((i) => m.create(OrderItem, { productId: i.productId, quantity: i.quantity, unitPriceCents: null })),
      });
      await m.save(order);
      await enqueue(m, {
        ...newEnvelope(order.id),
        type: EventTypes.OrderCreated,
        items: items.map(({ productId, quantity }) => ({ productId, quantity })),
      });
      return order;
    });
  }

  pay(id: string): Promise<Order> {
    return this.transition(id, OrderStatus.PAID, (o) => ({
      ...newEnvelope(o.id),
      type: EventTypes.OrderPaid,
      totalCents: o.totalCents ?? 0,
    }));
  }

  cancel(id: string): Promise<Order> {
    return this.transition(id, OrderStatus.CANCELLED, (o) => ({ ...newEnvelope(o.id), type: EventTypes.OrderCancelled }));
  }

  async findById(id: string): Promise<Order | null> {
    assertUuid(id, 'id');
    return this.dataSource.getRepository(Order).findOne({ where: { id }, relations: { items: true } });
  }

  async list(o: { status?: OrderStatus | null; first?: number | null; after?: string | null }): Promise<OrderPage> {
    const limit = pageSize(o.first);
    const qb = this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'i')
      .orderBy('o.createdAt', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .take(limit + 1);
    if (o.status) qb.andWhere('o.status = :status', { status: o.status });
    if (o.after) qb.andWhere('(o.created_at, o.id) > (:createdAt, :id)', decodeCursor(o.after));
    const rows = await qb.getMany();
    const nodes = rows.slice(0, limit);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > limit, endCursor: last ? encodeCursor(last) : null };
  }

  /** Consumer handler for stock-events. Idempotent, and a no-op once the order has left PENDING. */
  async applyStockReply(event: StockEvent): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (!(await markProcessed(m, event.eventId))) return;
      const order = await m.findOne(Order, { where: { id: event.orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order || order.status !== OrderStatus.PENDING) return;

      if (event.type === EventTypes.StockReserved) {
        const prices = new Map(event.lines.map((l) => [l.productId, l.unitPriceCents]));
        const items = await m.find(OrderItem, { where: { order: { id: order.id } } });
        let total = 0;
        for (const item of items) {
          item.unitPriceCents = prices.get(item.productId) ?? 0;
          total += item.unitPriceCents * item.quantity;
        }
        await m.save(items);
        order.status = OrderStatus.RESERVED;
        order.totalCents = total;
      } else {
        order.status = OrderStatus.REJECTED;
        order.rejectionReason = event.reason;
      }
      await m.save(order);
    });
  }

  private async transition(id: string, to: OrderStatus, event: (o: Order) => OrderEvent): Promise<Order> {
    assertUuid(id, 'id');
    return this.dataSource.transaction(async (m: EntityManager) => {
      const order = await m.findOne(Order, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new OrderNotFoundError(id);
      assertTransition(order.status, to);
      order.status = to;
      await m.save(order);
      await enqueue(m, event(order));
      return m.findOneOrFail(Order, { where: { id }, relations: { items: true } });
    });
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:int -- test/int/orders && npm run test:unit && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(orders): persistence, migration and OrdersService with outbox writes"
```

---

### Task 6: Orders GraphQL API, Nest module, messaging lifecycle

**Files:**
- Create: `apps/orders/src/orders/graphql.models.ts`, `graphql-errors.ts`, `orders.resolver.ts`, `apps/orders/src/health.controller.ts`, `messaging.lifecycle.ts`, `app.module.ts`, `main.ts`
- Test: `test/int/orders-graphql.int-spec.ts`

**Interfaces:**
- Consumes: `OrdersService`, `ordersConfig`, `ordersDataSourceOptions` (Task 5); `createKafka`, `ensureTopics`, `OutboxPublisher`, `EventConsumer` (Tasks 2 and 4); `Topics`, `StockEvent` (Task 1).
- Produces:
  - `OrdersAppModule` (Nest module). GraphQL at `POST /graphql`, `GET /health` → `{ status: 'ok' }`.
  - `OrdersMessaging` provider: on bootstrap ensures topics, starts the outbox publisher and the `stock-events` consumer (group `orders`); stops both in `beforeApplicationShutdown`. **Skipped when `ORDERS_MESSAGING=off`** (used by the GraphQL integration test, which has no Kafka).
  - GraphQL schema: `createOrder(items: [OrderItemInput!]!): Order!`, `payOrder(id: ID!): Order!`, `cancelOrder(id: ID!): Order!`, `order(id: ID!): Order`, `orders(status: OrderStatus, first: Int, after: String): OrderPage!`

- [ ] **Step 1: Write the failing GraphQL integration test**

`test/int/orders-graphql.int-spec.ts`:
```ts
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { OrdersAppModule } from '../../apps/orders/src/app.module';
import { startPostgres } from '../support/postgres';

const KEYBOARD = '11111111-1111-4111-8111-111111111111';
type GqlResponse = { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: { code?: string } }[] };

describe('orders GraphQL API (real PostgreSQL, no Kafka)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;

  const gql = async (query: string, variables?: object): Promise<GqlResponse> =>
    (await request(app.getHttpServer()).post('/graphql').send({ query, variables })).body;

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    process.env.ORDERS_DATABASE_URL = started.ordersUrl;
    process.env.ORDERS_MESSAGING = 'off';
    app = await NestFactory.create(OrdersAppModule, { logger: ['error', 'warn'] });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    delete process.env.ORDERS_MESSAGING;
  });

  it('answers the health check', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('creates an order and reads it back', async () => {
    const created = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id status totalCents } }`, {
      items: [{ productId: KEYBOARD, quantity: 2 }],
    });
    expect(created.errors).toBeUndefined();
    const order = created.data?.createOrder as { id: string; status: string; totalCents: number | null };
    expect(order).toMatchObject({ status: 'PENDING', totalCents: null });

    const read = await gql(`query($id: ID!) { order(id: $id) { id status items { productId quantity } } }`, { id: order.id });
    expect(read.data?.order).toMatchObject({ id: order.id, items: [{ productId: KEYBOARD, quantity: 2 }] });
  });

  it.each([
    ['no items', []],
    ['quantity 0', [{ productId: KEYBOARD, quantity: 0 }]],
    ['a non-UUID productId', [{ productId: 'keyboard', quantity: 1 }]],
  ])('returns BAD_USER_INPUT for %s', async (_label, items) => {
    const res = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id } }`, { items });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('returns BAD_USER_INPUT, not a server error, for a non-UUID id', async () => {
    const res = await gql(`query { order(id: "nope") { id } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('returns NOT_FOUND when paying an order that does not exist', async () => {
    const res = await gql(`mutation { payOrder(id: "99999999-9999-4999-8999-999999999999") { id } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_STATE when paying a PENDING order', async () => {
    const created = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id } }`, {
      items: [{ productId: KEYBOARD, quantity: 1 }],
    });
    const id = (created.data?.createOrder as { id: string }).id;
    const res = await gql(`mutation($id: ID!) { payOrder(id: $id) { id } }`, { id });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATE');
  });

  it('lists orders with a page cursor', async () => {
    const res = await gql(`query { orders(first: 1) { nodes { id } endCursor hasNextPage } }`);
    expect(res.data?.orders).toMatchObject({ hasNextPage: true });
  });

  it('returns BAD_USER_INPUT for first: 0', async () => {
    const res = await gql(`query { orders(first: 0) { nodes { id } } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:int -- test/int/orders-graphql`
Expected: FAIL, `Cannot find module '../../apps/orders/src/app.module'`.

- [ ] **Step 3: Implement the GraphQL layer**

`apps/orders/src/orders/graphql.models.ts`:
```ts
import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { OrderStatus } from './order-status';

registerEnumType(OrderStatus, { name: 'OrderStatus' });

@ObjectType('OrderItem')
export class OrderItemModel {
  @Field(() => ID) productId!: string;
  @Field(() => Int) quantity!: number;
  @Field(() => Int, { nullable: true }) unitPriceCents!: number | null;
}

@ObjectType('Order')
export class OrderModel {
  @Field(() => ID) id!: string;
  @Field(() => OrderStatus) status!: OrderStatus;
  @Field(() => Int, { nullable: true, description: 'Known once inventory has reserved the stock' }) totalCents!: number | null;
  @Field(() => String, { nullable: true }) rejectionReason!: string | null;
  @Field(() => [OrderItemModel]) items!: OrderItemModel[];
  @Field(() => GraphQLISODateTime) createdAt!: Date;
}

@ObjectType('OrderPage')
export class OrderPageModel {
  @Field(() => [OrderModel]) nodes!: OrderModel[];
  @Field(() => String, { nullable: true }) endCursor!: string | null;
  @Field(() => Boolean) hasNextPage!: boolean;
}

@InputType()
export class OrderItemInput {
  @Field(() => ID) productId!: string;
  @Field(() => Int) quantity!: number;
}
```

`apps/orders/src/orders/graphql-errors.ts`:
```ts
import { GraphQLError } from 'graphql';
import { InvalidInputError, OrderNotFoundError } from './errors';
import { InvalidStateError } from './order-state';

/** Maps domain errors to stable GraphQL error codes; anything else stays an internal error. */
export async function withGraphQLErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidInputError) throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
    if (e instanceof OrderNotFoundError) throw new GraphQLError(e.message, { extensions: { code: 'NOT_FOUND' } });
    if (e instanceof InvalidStateError) throw new GraphQLError(e.message, { extensions: { code: 'INVALID_STATE' } });
    throw e;
  }
}
```

`apps/orders/src/orders/orders.resolver.ts`:
```ts
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { withGraphQLErrors } from './graphql-errors';
import { OrderItemInput, OrderModel, OrderPageModel } from './graphql.models';
import { OrderStatus } from './order-status';
import { OrderPage, OrdersService } from './orders.service';
import { Order } from './order.entity';

@Resolver(() => OrderModel)
export class OrdersResolver {
  constructor(private readonly orders: OrdersService) {}

  @Mutation(() => OrderModel)
  createOrder(@Args('items', { type: () => [OrderItemInput] }) items: OrderItemInput[]): Promise<Order> {
    return withGraphQLErrors(() => this.orders.create(items));
  }

  @Mutation(() => OrderModel, { description: 'Simulated payment; only a RESERVED order can be paid' })
  payOrder(@Args('id', { type: () => ID }) id: string): Promise<Order> {
    return withGraphQLErrors(() => this.orders.pay(id));
  }

  @Mutation(() => OrderModel)
  cancelOrder(@Args('id', { type: () => ID }) id: string): Promise<Order> {
    return withGraphQLErrors(() => this.orders.cancel(id));
  }

  @Query(() => OrderModel, { nullable: true })
  order(@Args('id', { type: () => ID }) id: string): Promise<Order | null> {
    return withGraphQLErrors(() => this.orders.findById(id));
  }

  @Query(() => OrderPageModel)
  orders(
    @Args('status', { type: () => OrderStatus, nullable: true }) status?: OrderStatus | null,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
    @Args('after', { type: () => String, nullable: true }) after?: string | null,
  ): Promise<OrderPage> {
    return withGraphQLErrors(() => this.orders.list({ status, first, after }));
  }
}
```

- [ ] **Step 4: Implement the module, lifecycle, health check and entry point**

`apps/orders/src/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`apps/orders/src/messaging.lifecycle.ts`:
```ts
import { StockEvent, Topics } from '@app/contracts';
import { createKafka, ensureTopics, EventConsumer, OutboxPublisher } from '@app/messaging';
import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ordersConfig } from './config';
import { OrdersService } from './orders/orders.service';

@Injectable()
export class OrdersMessaging implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private publisher?: OutboxPublisher;
  private consumer?: EventConsumer;

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrdersService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.ORDERS_MESSAGING === 'off') return;
    const cfg = ordersConfig();
    const kafka = createKafka('orders', cfg.kafkaBrokers);
    await ensureTopics(kafka);
    this.publisher = new OutboxPublisher(this.dataSource, kafka.producer({ maxInFlightRequests: 1 }), {
      intervalMs: cfg.outboxIntervalMs,
      logger: new Logger('OrdersOutbox'),
    });
    await this.publisher.start();
    this.consumer = new EventConsumer({
      kafka,
      groupId: 'orders',
      topic: Topics.StockEvents,
      handle: (e) => this.orders.applyStockReply(e as StockEvent), // parseEvent guarantees stock-events carry stock events
      logger: new Logger('StockEventsConsumer'),
    });
    await this.consumer.start();
  }

  // Before TypeORM closes its pool, so an in-flight batch can finish.
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
    await this.publisher?.stop();
  }
}
```

`apps/orders/src/app.module.ts`:
```ts
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ordersConfig } from './config';
import { ordersDataSourceOptions } from './data-source';
import { HealthController } from './health.controller';
import { OrdersMessaging } from './messaging.lifecycle';
import { OrdersResolver } from './orders/orders.resolver';
import { OrdersService } from './orders/orders.service';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true, sortSchema: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => ordersDataSourceOptions(ordersConfig().databaseUrl) }),
  ],
  controllers: [HealthController],
  providers: [OrdersService, OrdersResolver, OrdersMessaging],
})
export class OrdersAppModule {}
```

`apps/orders/src/main.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { OrdersAppModule } from './app.module';
import { ordersConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(OrdersAppModule);
  app.enableShutdownHooks();
  await app.listen(ordersConfig().port);
}
void bootstrap();
```

- [ ] **Step 5: Run the tests and the build**

Run: `npm run test:int -- test/int/orders-graphql && npm run lint && npm run typecheck && npx nest build orders`
Expected: tests PASS; `dist/apps/orders/main.js` exists.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(orders): GraphQL API with error codes, health check, messaging lifecycle"
```

---

### Task 7: Inventory stock rules (pure)

**Files:**
- Create: `apps/inventory/src/stock/stock.ts`, `apps/inventory/src/stock/seed.ts`
- Test: `apps/inventory/src/stock/stock.spec.ts`

**Interfaces:**
- Consumes: `OrderItemLine`, `PricedLine`, `RejectionReason` from `@app/contracts`.
- Produces:
  - `aggregate(items: OrderItemLine[]): OrderItemLine[]` (sums duplicates, sorted by `productId`)
  - `interface StockRow { id: string; stockAvailable: number; priceCents: number }`
  - `type ReserveDecision = { ok: true; lines: PricedLine[] } | { ok: false; reason: RejectionReason }`
  - `decideReservation(items: OrderItemLine[], products: Map<string, StockRow>): ReserveDecision`
  - `SEED_PRODUCTS: readonly { id: string; sku: string; name: string; priceCents: number; stock: number }[]`

- [ ] **Step 1: Write the failing test**

`apps/inventory/src/stock/stock.spec.ts`:
```ts
import { aggregate, decideReservation, StockRow } from './stock';

const K = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const stock = (rows: StockRow[]) => new Map(rows.map((r) => [r.id, r]));
const shelf = stock([
  { id: K, stockAvailable: 10, priceCents: 8999 },
  { id: M, stockAvailable: 1, priceCents: 2999 },
]);

describe('aggregate', () => {
  it('sums the same product appearing twice and sorts by id', () => {
    expect(aggregate([{ productId: M, quantity: 1 }, { productId: K, quantity: 2 }, { productId: K, quantity: 3 }])).toEqual([
      { productId: K, quantity: 5 },
      { productId: M, quantity: 1 },
    ]);
  });
});

describe('decideReservation', () => {
  it('reserves when every line fits, returning unit prices', () => {
    expect(decideReservation([{ productId: K, quantity: 10 }], shelf)).toEqual({
      ok: true,
      lines: [{ productId: K, unitPriceCents: 8999 }],
    });
  });

  it('rejects with INSUFFICIENT_STOCK when any line exceeds stock', () => {
    expect(decideReservation([{ productId: K, quantity: 1 }, { productId: M, quantity: 2 }], shelf)).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_STOCK',
    });
  });

  it('rejects with UNKNOWN_PRODUCT before checking quantities', () => {
    expect(decideReservation([{ productId: '99999999-9999-4999-8999-999999999999', quantity: 1 }], shelf)).toEqual({
      ok: false,
      reason: 'UNKNOWN_PRODUCT',
    });
  });

  it('judges duplicates by their combined quantity', () => {
    expect(decideReservation(aggregate([{ productId: M, quantity: 1 }, { productId: M, quantity: 1 }]), shelf)).toMatchObject({
      ok: false,
      reason: 'INSUFFICIENT_STOCK',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --selectProjects unit apps/inventory`
Expected: FAIL, `Cannot find module './stock'`.

- [ ] **Step 3: Implement**

`apps/inventory/src/stock/stock.ts`:
```ts
import { OrderItemLine, PricedLine, RejectionReason } from '@app/contracts';

export interface StockRow {
  id: string;
  stockAvailable: number;
  priceCents: number;
}

export type ReserveDecision = { ok: true; lines: PricedLine[] } | { ok: false; reason: RejectionReason };

/** Sums repeated products (the API forbids them, but other producers might not) and sorts by id for lock order. */
export function aggregate(items: OrderItemLine[]): OrderItemLine[] {
  const totals = new Map<string, number>();
  for (const i of items) totals.set(i.productId, (totals.get(i.productId) ?? 0) + i.quantity);
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, quantity]) => ({ productId, quantity }));
}

export function decideReservation(items: OrderItemLine[], products: Map<string, StockRow>): ReserveDecision {
  if (items.some((i) => !products.has(i.productId))) return { ok: false, reason: 'UNKNOWN_PRODUCT' };
  if (items.some((i) => products.get(i.productId)!.stockAvailable < i.quantity)) {
    return { ok: false, reason: 'INSUFFICIENT_STOCK' };
  }
  return { ok: true, lines: items.map((i) => ({ productId: i.productId, unitPriceCents: products.get(i.productId)!.priceCents })) };
}
```

`apps/inventory/src/stock/seed.ts`:
```ts
/** Seeded by the first migration; the README and the tests use these IDs. */
export const SEED_PRODUCTS = [
  { id: '11111111-1111-4111-8111-111111111111', sku: 'KB-01', name: 'Mechanical keyboard', priceCents: 8999, stock: 10 },
  { id: '22222222-2222-4222-8222-222222222222', sku: 'MS-01', name: 'Wireless mouse', priceCents: 2999, stock: 5 },
  { id: '33333333-3333-4333-8333-333333333333', sku: 'MN-01', name: '27-inch monitor', priceCents: 24999, stock: 1 },
] as const;
```

- [ ] **Step 4: Run the tests**

Run: `npx jest --selectProjects unit apps/inventory && npm run lint && npm run typecheck`
Expected: PASS. (`no-non-null-assertion` is not in the recommended set; if lint flags `!`, replace with a local `const p = products.get(...)` guard.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(inventory): stock reservation rules and seed catalogue"
```

---

### Task 8: Inventory persistence and `ReservationService`

**Files:**
- Create: `apps/inventory/src/config.ts`, `data-source.ts`, `migrations/1728300000001-init-inventory.ts`, `stock/product.entity.ts`, `stock/reservation.entity.ts`, `stock/reservation.service.ts`
- Test: `test/int/inventory.int-spec.ts`

**Interfaces:**
- Consumes: Task 7; `enqueue`, `markProcessed`, `OutboxMessage`, `ProcessedEvent`, messaging SQL (Task 4); `EventTypes`, `newEnvelope`, `OrderCreated`, `OrderCancelled`, `OrderEvent` (Task 1).
- Produces:
  - `inventoryConfig(): { databaseUrl: string; kafkaBrokers: string[]; outboxIntervalMs: number }`
  - `inventoryDataSourceOptions(url: string): DataSourceOptions`
  - entities `Product { id; sku; name; priceCents; stockAvailable }`, `Reservation { id; orderId; productId; quantity; status: 'ACTIVE' | 'RELEASED' }`
  - `ReservationService(dataSource)` with `handle(e: OrderEvent): Promise<void>` (dispatch), `reserve(e: OrderCreated): Promise<void>`, `release(e: OrderCancelled): Promise<void>`

- [ ] **Step 1: Write the failing integration test**

`test/int/inventory.int-spec.ts`:
```ts
import { EventTypes, newEnvelope, OrderCancelled, OrderCreated, OrderItemLine } from '@app/contracts';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { inventoryDataSourceOptions } from '../../apps/inventory/src/data-source';
import { ReservationService } from '../../apps/inventory/src/stock/reservation.service';
import { SEED_PRODUCTS } from '../../apps/inventory/src/stock/seed';
import { startPostgres } from '../support/postgres';

const [KEYBOARD, MOUSE, MONITOR] = SEED_PRODUCTS.map((p) => p.id);
const created = (items: OrderItemLine[], orderId = randomUUID()): OrderCreated => ({
  ...newEnvelope(orderId),
  type: EventTypes.OrderCreated,
  items,
});
const cancelled = (orderId: string): OrderCancelled => ({ ...newEnvelope(orderId), type: EventTypes.OrderCancelled });

describe('ReservationService (real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let service: ReservationService;

  const stockOf = async (id: string): Promise<number> =>
    (await ds.query('SELECT stock_available FROM products WHERE id = $1', [id]))[0].stock_available;
  const replies = async (orderId: string) =>
    (await ds.query(`SELECT payload FROM outbox WHERE key = $1 ORDER BY seq`, [orderId])).map((r: { payload: unknown }) => r.payload);
  const reservationRows = async (orderId: string) =>
    ds.query('SELECT product_id, quantity, status FROM reservations WHERE order_id = $1 ORDER BY product_id', [orderId]);

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ds = await new DataSource(inventoryDataSourceOptions(started.inventoryUrl)).initialize();
    service = new ReservationService(ds);
  });
  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE reservations, outbox, processed_events');
    for (const p of SEED_PRODUCTS) await ds.query('UPDATE products SET stock_available = $2 WHERE id = $1', [p.id, p.stock]);
  });

  it('reserves stock and writes stock.reserved with unit prices to its outbox', async () => {
    const e = created([{ productId: KEYBOARD, quantity: 3 }]);
    await service.handle(e);
    expect(await stockOf(KEYBOARD)).toBe(7);
    expect(await replies(e.orderId)).toEqual([
      expect.objectContaining({ type: 'stock.reserved', lines: [{ productId: KEYBOARD, unitPriceCents: 8999 }] }),
    ]);
  });

  it('rejects INSUFFICIENT_STOCK and leaves every product untouched', async () => {
    const e = created([{ productId: KEYBOARD, quantity: 1 }, { productId: MONITOR, quantity: 2 }]);
    await service.handle(e);
    expect(await stockOf(KEYBOARD)).toBe(10);
    expect(await stockOf(MONITOR)).toBe(1);
    expect(await replies(e.orderId)).toEqual([expect.objectContaining({ type: 'stock.rejected', reason: 'INSUFFICIENT_STOCK' })]);
  });

  it('rejects UNKNOWN_PRODUCT', async () => {
    const e = created([{ productId: '99999999-9999-4999-8999-999999999999', quantity: 1 }]);
    await service.handle(e);
    expect(await replies(e.orderId)).toEqual([expect.objectContaining({ type: 'stock.rejected', reason: 'UNKNOWN_PRODUCT' })]);
  });

  it('processes a redelivered event once', async () => {
    const e = created([{ productId: MOUSE, quantity: 2 }]);
    await service.handle(e);
    await service.handle(e);
    expect(await stockOf(MOUSE)).toBe(3);
    expect(await replies(e.orderId)).toHaveLength(1);
  });

  it('sums a product that appears twice in one event into one reservation', async () => {
    const e = created([{ productId: MOUSE, quantity: 1 }, { productId: MOUSE, quantity: 2 }]);
    await service.handle(e);
    expect(await stockOf(MOUSE)).toBe(2);
    expect(await reservationRows(e.orderId)).toEqual([{ product_id: MOUSE, quantity: 3, status: 'ACTIVE' }]);
  });

  it('never oversells: two concurrent orders for the last monitor, exactly one wins', async () => {
    const a = created([{ productId: MONITOR, quantity: 1 }]);
    const b = created([{ productId: MONITOR, quantity: 1 }]);
    await Promise.all([service.handle(a), service.handle(b)]);
    expect(await stockOf(MONITOR)).toBe(0);
    const types = [...(await replies(a.orderId)), ...(await replies(b.orderId))].map((r: { type: string }) => r.type).sort();
    expect(types).toEqual(['stock.rejected', 'stock.reserved']);
  });

  it('releases on order.cancelled, once, even if redelivered', async () => {
    const e = created([{ productId: KEYBOARD, quantity: 4 }]);
    await service.handle(e);
    const c = cancelled(e.orderId);
    await service.handle(c);
    await service.handle(c);
    expect(await stockOf(KEYBOARD)).toBe(10);
    expect(await reservationRows(e.orderId)).toEqual([{ product_id: KEYBOARD, quantity: 4, status: 'RELEASED' }]);
  });

  it('treats a cancel for an order it never reserved as a no-op', async () => {
    await expect(service.handle(cancelled(randomUUID()))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:int -- test/int/inventory`
Expected: FAIL, `Cannot find module '../../apps/inventory/src/data-source'`.

- [ ] **Step 3: Implement config, entities, migration, data source**

`apps/inventory/src/config.ts`:
```ts
/** Read when a module initialises, never at import time, and every value has a local default. */
export function inventoryConfig() {
  return {
    databaseUrl: process.env.INVENTORY_DATABASE_URL ?? 'postgres://orderflow:orderflow@localhost:5432/inventory',
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
  };
}
```

`apps/inventory/src/stock/product.entity.ts`:
```ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('varchar', { length: 32, unique: true })
  sku!: string;

  @Column('varchar', { length: 120 })
  name!: string;

  @Column('integer', { name: 'price_cents' })
  priceCents!: number;

  @Column('integer', { name: 'stock_available' })
  stockAvailable!: number;
}
```

`apps/inventory/src/stock/reservation.entity.ts`:
```ts
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('reservations')
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'order_id' })
  orderId!: string;

  @Column('uuid', { name: 'product_id' })
  productId!: string;

  @Column('integer')
  quantity!: number;

  @Column('varchar', { length: 16 })
  status!: 'ACTIVE' | 'RELEASED';
}
```

`apps/inventory/src/migrations/1728300000001-init-inventory.ts`:
```ts
import { DROP_MESSAGING_TABLES_SQL, MESSAGING_TABLES_SQL } from '@app/messaging';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { SEED_PRODUCTS } from '../stock/seed';

export class InitInventory1728300000001 implements MigrationInterface {
  name = 'InitInventory1728300000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE products (
        id              uuid PRIMARY KEY,
        sku             varchar(32)  NOT NULL UNIQUE,
        name            varchar(120) NOT NULL,
        price_cents     integer NOT NULL CHECK (price_cents >= 0),
        stock_available integer NOT NULL CHECK (stock_available >= 0)
      );
      CREATE TABLE reservations (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id   uuid NOT NULL,
        product_id uuid NOT NULL REFERENCES products(id),
        quantity   integer NOT NULL CHECK (quantity > 0),
        status     varchar(16) NOT NULL
      );
      CREATE INDEX reservations_order_idx ON reservations (order_id);
    `);
    await q.query(MESSAGING_TABLES_SQL);
    for (const p of SEED_PRODUCTS) {
      await q.query('INSERT INTO products (id, sku, name, price_cents, stock_available) VALUES ($1, $2, $3, $4, $5)', [
        p.id,
        p.sku,
        p.name,
        p.priceCents,
        p.stock,
      ]);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(DROP_MESSAGING_TABLES_SQL);
    await q.query('DROP TABLE reservations; DROP TABLE products;');
  }
}
```

`apps/inventory/src/data-source.ts`:
```ts
import { OutboxMessage, ProcessedEvent } from '@app/messaging';
import { DataSourceOptions } from 'typeorm';
import { InitInventory1728300000001 } from './migrations/1728300000001-init-inventory';
import { Product } from './stock/product.entity';
import { Reservation } from './stock/reservation.entity';

export function inventoryDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [Product, Reservation, OutboxMessage, ProcessedEvent],
    migrations: [InitInventory1728300000001],
    migrationsRun: true,
    synchronize: false,
  };
}
```

- [ ] **Step 4: Implement `ReservationService`**

`apps/inventory/src/stock/reservation.service.ts`:
```ts
import { EventTypes, newEnvelope, OrderCancelled, OrderCreated, OrderEvent, StockEvent } from '@app/contracts';
import { enqueue, markProcessed } from '@app/messaging';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from './product.entity';
import { Reservation } from './reservation.entity';
import { aggregate, decideReservation } from './stock';

@Injectable()
export class ReservationService {
  constructor(private readonly dataSource: DataSource) {}

  /** Consumer handler for order-events. */
  async handle(event: OrderEvent): Promise<void> {
    switch (event.type) {
      case EventTypes.OrderCreated:
        return this.reserve(event);
      case EventTypes.OrderCancelled:
        return this.release(event);
      case EventTypes.OrderPaid:
        return; // nothing to do: the stock was already taken at reservation
    }
  }

  /** Locks the product rows in id order (no deadlocks), decides, applies, and queues the reply — all in one transaction. */
  async reserve(event: OrderCreated): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (!(await markProcessed(m, event.eventId))) return;
      const items = aggregate(event.items);
      const products = await m
        .createQueryBuilder(Product, 'p')
        .where('p.id IN (:...ids)', { ids: items.map((i) => i.productId) })
        .orderBy('p.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();
      const decision = decideReservation(items, new Map(products.map((p) => [p.id, p])));

      let reply: StockEvent;
      if (decision.ok) {
        for (const i of items) {
          await m.decrement(Product, { id: i.productId }, 'stockAvailable', i.quantity);
          await m.insert(Reservation, { orderId: event.orderId, productId: i.productId, quantity: i.quantity, status: 'ACTIVE' });
        }
        reply = { ...newEnvelope(event.orderId), type: EventTypes.StockReserved, lines: decision.lines };
      } else {
        reply = { ...newEnvelope(event.orderId), type: EventTypes.StockRejected, reason: decision.reason };
      }
      await enqueue(m, reply);
    });
  }

  async release(event: OrderCancelled): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (!(await markProcessed(m, event.eventId))) return;
      const active = await m.find(Reservation, {
        where: { orderId: event.orderId, status: 'ACTIVE' },
        order: { productId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      for (const r of active) {
        await m.increment(Product, { id: r.productId }, 'stockAvailable', r.quantity);
        r.status = 'RELEASED';
      }
      await m.save(active);
    });
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:int -- test/int/inventory && npm run lint && npm run typecheck`
Expected: PASS, including the concurrency test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(inventory): row-locked reservations, release, idempotent handlers, reply outbox"
```

---

### Task 9: Inventory Nest module and entry point

**Files:**
- Create: `apps/inventory/src/messaging.lifecycle.ts`, `app.module.ts`, `main.ts`

**Interfaces:**
- Consumes: `ReservationService`, `inventoryConfig`, `inventoryDataSourceOptions` (Task 8); messaging (Tasks 2, 4).
- Produces: `InventoryAppModule` (no HTTP). On bootstrap: ensure topics, start the outbox publisher and the `order-events` consumer (group `inventory`); stop both before shutdown.

- [ ] **Step 1: Implement**

`apps/inventory/src/messaging.lifecycle.ts`:
```ts
import { OrderEvent, Topics } from '@app/contracts';
import { createKafka, ensureTopics, EventConsumer, OutboxPublisher } from '@app/messaging';
import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { inventoryConfig } from './config';
import { ReservationService } from './stock/reservation.service';

@Injectable()
export class InventoryMessaging implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private publisher?: OutboxPublisher;
  private consumer?: EventConsumer;

  constructor(
    private readonly dataSource: DataSource,
    private readonly reservations: ReservationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const cfg = inventoryConfig();
    const kafka = createKafka('inventory', cfg.kafkaBrokers);
    await ensureTopics(kafka);
    this.publisher = new OutboxPublisher(this.dataSource, kafka.producer({ maxInFlightRequests: 1 }), {
      intervalMs: cfg.outboxIntervalMs,
      logger: new Logger('InventoryOutbox'),
    });
    await this.publisher.start();
    this.consumer = new EventConsumer({
      kafka,
      groupId: 'inventory',
      topic: Topics.OrderEvents,
      handle: (e) => this.reservations.handle(e as OrderEvent), // parseEvent guarantees order-events carry order events
      logger: new Logger('OrderEventsConsumer'),
    });
    await this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
    await this.publisher?.stop();
  }
}
```

`apps/inventory/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { inventoryConfig } from './config';
import { inventoryDataSourceOptions } from './data-source';
import { InventoryMessaging } from './messaging.lifecycle';
import { ReservationService } from './stock/reservation.service';

@Module({
  imports: [TypeOrmModule.forRootAsync({ useFactory: () => inventoryDataSourceOptions(inventoryConfig().databaseUrl) })],
  providers: [ReservationService, InventoryMessaging],
})
export class InventoryAppModule {}
```

`apps/inventory/src/main.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { InventoryAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // No HTTP: inventory only listens to Kafka.
  const app = await NestFactory.createApplicationContext(InventoryAppModule);
  app.enableShutdownHooks();
}
void bootstrap();
```

- [ ] **Step 2: Build both apps**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: `dist/apps/orders/main.js` and `dist/apps/inventory/main.js` exist. (The running system is proven by Task 10's e2e suite.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(inventory): Nest application context with consumer and outbox"
```

---

### Task 10: End-to-end suite (PostgreSQL + Kafka + both services)

**Files:**
- Create: `test/support/kafka.ts`, `test/support/wait-for.ts`
- Test: `test/e2e/orderflow.e2e-spec.ts`

**Interfaces:**
- Consumes: `OrdersAppModule` (Task 6), `InventoryAppModule` (Task 9), `SEED_PRODUCTS` (Task 7), `startPostgres` (Task 4), `createKafka` (Task 2), `Topics`, `dlqTopic` (Task 1).
- Produces: `startKafka(): Promise<{ container: StartedKafkaContainer; brokers: string[] }>`, `waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs?: number): Promise<T>`

- [ ] **Step 1: Write the support files**

`test/support/kafka.ts`:
```ts
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';

/** Single-node Kafka in KRaft mode (no ZooKeeper). */
export async function startKafka(): Promise<{ container: StartedKafkaContainer; brokers: string[] }> {
  const container = await new KafkaContainer('confluentinc/cp-kafka:7.7.1').withKraft().start();
  // The Testcontainers Kafka module advertises the host listener on container port 9093.
  return { container, brokers: [`${container.getHost()}:${container.getMappedPort(9093)}`] };
}
```
If the installed `@testcontainers/kafka` version documents a different host port or a different KRaft method name, follow its README; the rest of the suite only needs `brokers`.

`test/support/wait-for.ts`:
```ts
/** Polls until `done(value)` is true. Eventual consistency without fixed sleeps. */
export async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms; last value: ${JSON.stringify(last)}`);
}
```

- [ ] **Step 2: Write the e2e suite**

`test/e2e/orderflow.e2e-spec.ts`:
```ts
import { dlqTopic, EventTypes, newEnvelope, Topics } from '@app/contracts';
import { createKafka } from '@app/messaging';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kafka, Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { InventoryAppModule } from '../../apps/inventory/src/app.module';
import { SEED_PRODUCTS } from '../../apps/inventory/src/stock/seed';
import { OrdersAppModule } from '../../apps/orders/src/app.module';
import { startKafka } from '../support/kafka';
import { startPostgres } from '../support/postgres';
import { waitFor } from '../support/wait-for';

const [KEYBOARD, MOUSE, MONITOR] = SEED_PRODUCTS.map((p) => p.id);
type Gql = { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: { code?: string } }[] };
type OrderView = { id: string; status: string; totalCents: number | null; rejectionReason: string | null };

describe('orderflow end to end', () => {
  let pg: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let kafka: Kafka;
  let rawProducer: Producer;
  let orders: INestApplication;
  let inventory: INestApplicationContext;
  let inventoryDb: Client;

  const gql = async (query: string, variables?: object): Promise<Gql> =>
    (await request(orders.getHttpServer()).post('/graphql').send({ query, variables })).body;
  const createOrder = async (items: { productId: string; quantity: number }[]): Promise<string> => {
    const res = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id } }`, { items });
    expect(res.errors).toBeUndefined();
    return (res.data?.createOrder as { id: string }).id;
  };
  const readOrder = async (id: string): Promise<OrderView> =>
    (await gql(`query($id: ID!) { order(id: $id) { id status totalCents rejectionReason } }`, { id })).data?.order as OrderView;
  const waitForStatus = (id: string, status: string) => waitFor(() => readOrder(id), (o) => o?.status === status);
  const stockOf = async (id: string): Promise<number> =>
    (await inventoryDb.query('SELECT stock_available FROM products WHERE id = $1', [id])).rows[0].stock_available;

  beforeAll(async () => {
    const [p, k] = await Promise.all([startPostgres(), startKafka()]);
    pg = p.container;
    kafkaContainer = k.container;
    // No .env anywhere: everything comes from these variables, read when the modules initialise.
    process.env.ORDERS_DATABASE_URL = p.ordersUrl;
    process.env.INVENTORY_DATABASE_URL = p.inventoryUrl;
    process.env.KAFKA_BROKERS = k.brokers.join(',');
    process.env.OUTBOX_INTERVAL_MS = '100';

    inventory = await NestFactory.createApplicationContext(InventoryAppModule, { logger: ['error', 'warn'] });
    orders = await NestFactory.create(OrdersAppModule, { logger: ['error', 'warn'] });
    await orders.init();

    kafka = createKafka('e2e', k.brokers);
    rawProducer = kafka.producer();
    await rawProducer.connect();
    inventoryDb = new Client({ connectionString: p.inventoryUrl });
    await inventoryDb.connect();
  });

  afterAll(async () => {
    await inventoryDb?.end();
    await rawProducer?.disconnect();
    await orders?.close();
    await inventory?.close();
    await kafkaContainer?.stop();
    await pg?.stop();
  });

  it('1. reserves stock for a new order, then takes payment', async () => {
    const before = await stockOf(KEYBOARD);
    const id = await createOrder([{ productId: KEYBOARD, quantity: 2 }]);
    const reserved = await waitForStatus(id, 'RESERVED');
    expect(reserved.totalCents).toBe(2 * 8999);
    expect(await stockOf(KEYBOARD)).toBe(before - 2);

    const paid = await gql(`mutation($id: ID!) { payOrder(id: $id) { status } }`, { id });
    expect(paid.data?.payOrder).toEqual({ status: 'PAID' });
  });

  let rejectedId = '';
  it('2. rejects an order larger than the stock, leaving stock unchanged', async () => {
    const before = await stockOf(MONITOR);
    rejectedId = await createOrder([{ productId: MONITOR, quantity: before + 1 }]);
    const rejected = await waitForStatus(rejectedId, 'REJECTED');
    expect(rejected.rejectionReason).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(MONITOR)).toBe(before);
  });

  it('3. releases stock when a reserved order is cancelled', async () => {
    const before = await stockOf(MOUSE);
    const id = await createOrder([{ productId: MOUSE, quantity: 2 }]);
    await waitForStatus(id, 'RESERVED');
    expect(await stockOf(MOUSE)).toBe(before - 2);

    await gql(`mutation($id: ID!) { cancelOrder(id: $id) { status } }`, { id });
    await waitFor(() => stockOf(MOUSE), (s) => s === before);
  });

  it('4. reserves stock once when the same order.created is delivered twice', async () => {
    const before = await stockOf(KEYBOARD);
    const id = await createOrder([{ productId: KEYBOARD, quantity: 1 }]);
    await waitForStatus(id, 'RESERVED');

    // Re-deliver the exact event the outbox already sent (same eventId), as Kafka may after a rebalance.
    const ordersDb = new Client({ connectionString: process.env.ORDERS_DATABASE_URL });
    await ordersDb.connect();
    const { rows } = await ordersDb.query(`SELECT payload FROM outbox WHERE key = $1 AND payload->>'type' = 'order.created'`, [id]);
    await ordersDb.end();
    await rawProducer.send({ topic: Topics.OrderEvents, messages: [{ key: id, value: JSON.stringify(rows[0].payload) }] });

    // Then cancel. Same key, same partition, so inventory handles the duplicate before the cancel.
    await gql(`mutation($id: ID!) { cancelOrder(id: $id) { status } }`, { id });
    const released = await waitFor(
      async () => (await inventoryDb.query('SELECT status FROM reservations WHERE order_id = $1', [id])).rows,
      (r) => r.length > 0 && r.every((x: { status: string }) => x.status === 'RELEASED'),
    );
    expect(released).toHaveLength(1); // a second reservation would mean the duplicate was processed
    expect(await stockOf(KEYBOARD)).toBe(before);
  });

  it('5. dead-letters a malformed message and keeps processing the next orders', async () => {
    const poisonKey = randomUUID();
    await rawProducer.send({ topic: Topics.OrderEvents, messages: [{ key: poisonKey, value: 'definitely not json' }] });
    // A well-formed event with a type that does not belong on this topic is a contract violation too.
    await rawProducer.send({
      topic: Topics.OrderEvents,
      messages: [{ key: poisonKey, value: JSON.stringify({ ...newEnvelope(poisonKey), type: EventTypes.StockRejected, reason: 'UNKNOWN_PRODUCT' }) }],
    });

    const id = await createOrder([{ productId: KEYBOARD, quantity: 1 }]);
    await waitForStatus(id, 'RESERVED');

    const dead: { original: string; attempts: number }[] = [];
    const reader = kafka.consumer({ groupId: `dlq-reader-${randomUUID()}` });
    await reader.connect();
    await reader.subscribe({ topic: dlqTopic(Topics.OrderEvents), fromBeginning: true });
    await reader.run({ eachMessage: async ({ message }) => void dead.push(JSON.parse(String(message.value))) });
    try {
      await waitFor(async () => dead.length, (n) => n >= 2);
    } finally {
      await reader.disconnect();
    }
    expect(dead.map((d) => d.original)).toContain('definitely not json');
    expect(dead.every((d) => d.attempts === 1)).toBe(true);
  });

  it('6. refuses to pay a REJECTED order', async () => {
    const res = await gql(`mutation($id: ID!) { payOrder(id: $id) { status } }`, { id: rejectedId });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATE');
  });
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: 6 PASS. The first run pulls the Kafka image (about a minute). If scenario 1 times out, check the inventory logs for a broker connection error first: that means the Kafka host port in `test/support/kafka.ts` is wrong for the installed module version.

- [ ] **Step 4: Run everything once**

Run: `npm run lint && npm run typecheck && npm test`
Expected: unit, int and e2e all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(e2e): full flow over real PostgreSQL and Kafka: reserve, reject, release, dedupe, DLQ"
```

---

### Task 11: Docker images and `docker compose up`

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker/postgres-init.sql`

**Interfaces:**
- Consumes: `npm run build` output (`dist/apps/<app>/main.js`); env vars from Tasks 5 and 8.
- Produces: `docker compose up --build --wait` runs postgres, kafka, orders (`localhost:3000`) and inventory; Kafka reachable from the host at `localhost:9094`.

- [ ] **Step 1: Write the files**

`Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG APP
RUN npx nest build ${APP}

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
ARG APP
COPY --from=build /app/dist/apps/${APP} ./dist
USER node
CMD ["node", "dist/main.js"]
```

`.dockerignore`:
```
node_modules
dist
coverage
.git
.env
docs
```

`docker/postgres-init.sql`:
```sql
-- The image creates the "orders" database from POSTGRES_DB; inventory gets its own database on the same server.
CREATE DATABASE inventory;
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: orderflow
      POSTGRES_PASSWORD: orderflow
      POSTGRES_DB: orders
    ports: ["5432:5432"]
    volumes:
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U orderflow -d orders"]
      interval: 2s
      retries: 30

  kafka:
    image: apache/kafka:3.9.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: INTERNAL://:9092,EXTERNAL://:9094,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:9092,EXTERNAL://localhost:9094
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
    ports: ["9094:9094"]
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null 2>&1"]
      interval: 3s
      retries: 40

  orders:
    build: { context: ., args: { APP: orders } }
    environment:
      ORDERS_DATABASE_URL: postgres://orderflow:orderflow@postgres:5432/orders
      KAFKA_BROKERS: kafka:9092
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 3s
      retries: 30

  inventory:
    build: { context: ., args: { APP: inventory } }
    environment:
      INVENTORY_DATABASE_URL: postgres://orderflow:orderflow@postgres:5432/inventory
      KAFKA_BROKERS: kafka:9092
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
```

- [ ] **Step 2: Bring it up and place an order by hand**

Run:
```bash
docker compose up --build --wait
curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { createOrder(items: [{productId: \"11111111-1111-4111-8111-111111111111\", quantity: 1}]) { id status } }"}'
```
Expected: `{"data":{"createOrder":{"id":"…","status":"PENDING"}}}`. Query that id a second later with `{ order(id: "…") { status totalCents } }` and expect `RESERVED` and `8999`.

- [ ] **Step 3: Tear down and commit**

```bash
docker compose down -v
git add -A
git commit -m "build: Dockerfile and docker-compose for the full system"
```

---

### Task 12: CI and README

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: npm scripts (Task 1), Compose (Task 11).
- Produces: the CI badge and the document a reviewer reads first.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:unit -- --coverage
      - run: npm run test:int
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: coverage, path: coverage }

  compose-smoke:
    # Proves the shipped containers start from a clean checkout, not just that the tests pass.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose up --build --wait
      - name: Place an order
        run: |
          curl -sf localhost:3000/graphql -H 'content-type: application/json' \
            -d '{"query":"mutation { createOrder(items: [{productId: \"11111111-1111-4111-8111-111111111111\", quantity: 1}]) { id } }"}' \
            | tee /tmp/out.json | grep -q '"id"'
      - if: failure()
        run: docker compose logs
```

- [ ] **Step 2: Write the README**

`README.md` (replace `lemmy-code` only if the GitHub owner differs):
````markdown
# orderflow

[![CI](https://github.com/lemmy-code/orderflow/actions/workflows/ci.yml/badge.svg)](https://github.com/lemmy-code/orderflow/actions/workflows/ci.yml)

Two NestJS services that process orders over Kafka: **orders** (GraphQL API) and **inventory** (stock). They never call
each other; every state change and the event announcing it are committed together, then published by an outbox.

```mermaid
flowchart LR
  client([GraphQL client]) -->|createOrder / payOrder / cancelOrder| orders
  subgraph orders service
    orders[orders API] --> odb[(orders DB<br/>orders · outbox · processed_events)]
  end
  subgraph inventory service
    inv[inventory] --> idb[(inventory DB<br/>products · reservations · outbox · processed_events)]
  end
  odb -. outbox publisher .-> oe[[order-events]]
  oe --> inv
  idb -. outbox publisher .-> se[[stock-events]]
  se --> orders
  oe -. after 3 failed attempts .-> oedlq[[order-events.dlq]]
  se -. after 3 failed attempts .-> sedlq[[stock-events.dlq]]
```

## Run it

```bash
docker compose up --build --wait
```

GraphQL at <http://localhost:3000/graphql>. Seeded products:

| Product | id | Price | Stock |
|---|---|---|---|
| Mechanical keyboard | `11111111-1111-4111-8111-111111111111` | 89.99 | 10 |
| Wireless mouse | `22222222-2222-4222-8222-222222222222` | 29.99 | 5 |
| 27-inch monitor | `33333333-3333-4333-8333-333333333333` | 249.99 | 1 |

```graphql
mutation { createOrder(items: [{ productId: "11111111-1111-4111-8111-111111111111", quantity: 2 }]) { id status } }
query    { order(id: "<id>") { status totalCents items { productId quantity unitPriceCents } } }
mutation { payOrder(id: "<id>") { status } }
```

An order starts `PENDING`, becomes `RESERVED` or `REJECTED` (with a reason) once inventory answers, then `PAID` or
`CANCELLED`. Errors carry `extensions.code`: `BAD_USER_INPUT`, `NOT_FOUND` or `INVALID_STATE`.

## Design decisions

- **Transactional outbox.** The order row and its `order.created` event are written in one transaction; a publisher
  loop sends unsent rows to Kafka. A crash can delay an event but never lose one or invent one. Inventory replies
  through its own outbox for the same reason.
- **Idempotent consumers.** Kafka delivers at least once. Each handler records the event id in `processed_events` in
  the same transaction as its change, so a redelivery is a no-op.
- **One topic per stream, keyed by order id.** `order.created` and `order.cancelled` share `order-events`, so Kafka
  keeps them in order for each order.
- **No overselling.** Inventory locks product rows (`SELECT … FOR UPDATE`, in id order to avoid deadlocks) before it
  checks and decrements stock.
- **Dead-letter topics.** A failing message is retried 3 times with backoff, then moved to `<topic>.dlq` with the error,
  so one bad message never blocks a partition. Invalid payloads skip the retries.
- **No config at import time.** Every env var is read when its module starts and has a local default. CI runs from a
  clean checkout with no `.env`.

## Testing strategy

| Layer | Question it answers | Runs against | Command |
|---|---|---|---|
| Unit | Is the logic right? (state machine, stock rules, retry policy, validation, contracts) | nothing | `npm run test:unit` |
| Integration | Do the pieces work with a real database? (atomic outbox, row locks under concurrency, duplicate events) | PostgreSQL (Testcontainers) | `npm run test:int` |
| End to end | Does the system work? Both services, real Kafka: reserve, reject, release, duplicate delivery, poison message → DLQ | PostgreSQL + Kafka (Testcontainers) | `npm run test:e2e` |

CI runs lint, typecheck and all three layers on every push, and a second job boots the Compose stack and places an
order. Docker must be running to run the integration and e2e tests locally.

## Stack

TypeScript · NestJS · GraphQL (Apollo, code-first) · PostgreSQL · TypeORM · Kafka (KafkaJS) · Jest · Supertest ·
Testcontainers · Docker Compose · GitHub Actions
````

- [ ] **Step 3: Verify from a clean checkout, like CI will**

Run:
```bash
rm -rf /tmp/orderflow-check && git clone -q . /tmp/orderflow-check && cd /tmp/orderflow-check \
  && npm ci && npm run lint && npm run typecheck && npm test
```
Expected: everything passes in the fresh clone (no `.env`, no uncommitted files). Then `cd ~/Documents/GitHub/orderflow && rm -rf /tmp/orderflow-check`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: test and compose-smoke workflows; docs: README with architecture and testing strategy"
```

Do not push. Creating the public GitHub repo and pushing is the user's call.
