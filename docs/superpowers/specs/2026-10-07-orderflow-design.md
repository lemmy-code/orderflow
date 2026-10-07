# orderflow — design spec

*2026-10-07 · approved in conversation section by section; this file is the written version for final review.*

## 1. Purpose

A small but production-shaped portfolio project for Dimitrije's resume and GitHub (`lemmy-code/orderflow`, public).
Roughly ten job ads he couldn't pass screening for asked for **NestJS, Kafka, GraphQL and e2e tests** together; he has
not shipped a NestJS project before. orderflow exists to make each of those claims true and checkable in one repository.

**Success means:**
- `docker compose up` runs the whole system with one command.
- CI on every push runs lint plus unit, integration and e2e tests, and the README shows the passing badge.
- A reviewer can read the README in two minutes and see: the architecture diagram, the outbox, idempotent consumers,
  the DLQ, and the three test layers.
- The resume gets one honest project line (section 9).

**No deadline.** Quality over speed, but scope is fixed by section 8.

## 2. Architecture

One repository (NestJS monorepo), two services, and one shared library:

| Unit | What it does | Talks to |
|---|---|---|
| `apps/orders` | Public GraphQL API (Apollo, code-first). Owns orders and order items. Publishes order events through a transactional outbox. Consumes stock replies. | its own PostgreSQL DB, Kafka |
| `apps/inventory` | No public API. Owns products and stock reservations. Reserves stock on `order.created`, releases it on `order.cancelled`, and replies with `stock.reserved` / `stock.rejected`. | its own PostgreSQL DB, Kafka |
| `libs/contracts` | Event names, payload types and topic constants shared by both services, so a renamed field fails the build, not production. | — |

Each service owns its database (database-per-service). The services never call each other directly; Kafka is the only
link between them.

**Stack:** TypeScript (strict), NestJS, GraphQL (`@nestjs/graphql` + Apollo, code-first), PostgreSQL 16 with TypeORM
and migrations, Kafka through `@nestjs/microservices` (KafkaJS), Jest, Supertest, Testcontainers, Docker Compose,
GitHub Actions. Input validation through `class-validator`.

## 3. Data model

**orders DB**
- `orders`: `id` (uuid), `status` (`PENDING | RESERVED | REJECTED | PAID | CANCELLED`), `total_cents`, `created_at`, `updated_at`
- `order_items`: `id`, `order_id`, `product_id`, `quantity`, `unit_price_cents`
- `outbox`: `id` (uuid = event id), `topic`, `key` (orderId), `payload` (jsonb), `created_at`, `sent_at` (null until published)
- `processed_events`: `event_id` (pk), `processed_at`

**inventory DB**
- `products`: `id`, `sku`, `name`, `price_cents`, `stock_available`
- `reservations`: `id`, `order_id`, `product_id`, `quantity`, `status` (`ACTIVE | RELEASED`)
- `processed_events`: `event_id` (pk), `processed_at`

Products are seeded by a migration, so the system works without a product admin API.

## 4. Events (`libs/contracts`)

Every event carries `eventId` (uuid), `occurredAt` and `orderId`, and is **keyed by `orderId`** so all events for one
order land on the same partition and stay in order.

| Topic | Producer | Consumer | Payload |
|---|---|---|---|
| `order.created` | orders | inventory | items: `{productId, quantity}[]` |
| `order.paid` | orders | — (published for future consumers) | `totalCents` |
| `order.cancelled` | orders | inventory | — |
| `stock.reserved` | inventory | orders | — |
| `stock.rejected` | inventory | orders | `reason` (e.g. `INSUFFICIENT_STOCK`, `UNKNOWN_PRODUCT`) |
| `<topic>.dlq` | either | — (inspected in tests and logs) | original message plus error and attempt count |

## 5. The order flow

1. **`createOrder(items)`** validates input, saves the order as `PENDING` and writes an `order.created` row to `outbox`
   **in the same database transaction**.
2. The **outbox publisher** (a polling loop in `orders`, every ~500 ms) reads unsent rows in order, publishes them to
   Kafka, and sets `sent_at`. A crash between saving and publishing just means the row goes out on restart; an event
   for an order that was never saved can't exist. This is the **transactional outbox**.
3. **inventory** consumes `order.created`. In one transaction it locks the product rows (`SELECT … FOR UPDATE`, rows
   locked in a fixed `product_id` order to avoid deadlocks), checks stock, and either decrements `stock_available` and
   writes `ACTIVE` reservations, or changes nothing. It replies `stock.reserved` or `stock.rejected`.
4. **orders** consumes the reply and moves the order `PENDING → RESERVED` or `PENDING → REJECTED`.
5. **`payOrder(id)`** is simulated (no payment provider). It is allowed only from `RESERVED`: it sets `PAID` and emits
   `order.paid` through the outbox.
6. **`cancelOrder(id)`** is allowed from `PENDING` or `RESERVED`: it sets `CANCELLED` and emits `order.cancelled`.
   inventory releases any `ACTIVE` reservations for that order and restores stock. A cancel that arrives before the
   reservation does is handled by ordering: both events share the `orderId` key, so inventory always sees
   `order.created` first.

**State machine (orders).** Allowed: `PENDING→RESERVED`, `PENDING→REJECTED`, `PENDING→CANCELLED`,
`RESERVED→PAID`, `RESERVED→CANCELLED`. Anything else is refused with `INVALID_STATE`. A stock reply for an order that
is already `CANCELLED` is acknowledged and ignored.

**GraphQL surface:** mutations `createOrder`, `payOrder`, `cancelOrder`; queries `order(id)`,
`orders(status?, first?, after?)` (cursor pagination); query `products` for convenience.

## 6. Failure handling

- **Duplicate delivery.** Kafka is at-least-once. Every consumer inserts the `eventId` into `processed_events` **in the
  same transaction** as its state change; if the insert conflicts, the message is a repeat and is skipped.
- **Poison messages.** A handler failure is retried with exponential backoff (3 attempts). After that the message is
  published to `<topic>.dlq` with the error and attempt count, and the offset is committed, so one bad message never
  blocks the partition.
- **Contract violations.** Incoming payloads are validated against `libs/contracts` before handling; an invalid payload
  goes straight to the DLQ (retrying can't fix it).
- **API errors.** GraphQL errors carry a stable `extensions.code`: `BAD_USER_INPUT`, `NOT_FOUND`, `INVALID_STATE`.
  `INSUFFICIENT_STOCK` is visible as the order's `REJECTED` status plus a `rejectionReason` field, because stock is
  checked asynchronously, not inside the mutation.
- **Startup config.** Required env vars (DB URLs, Kafka brokers) are read when the module that uses them initialises,
  with defaults for local and test runs. A missing variable must never crash the app at import time.
- **Shutdown.** Both services enable NestJS shutdown hooks: the outbox loop stops and the Kafka consumers disconnect cleanly.

## 7. Testing

Three layers, each answering one question.

**Unit (Jest, no I/O): is the logic right?**
- The order state machine: every allowed and refused transition.
- Stock rules: can't reserve more than is available, a release restores stock, and an unknown product is rejected.
- The idempotency guard and the retry/DLQ decision.

**Integration (Testcontainers PostgreSQL): do the pieces work with a real database?**
- Saving an order and its outbox row is atomic: force a failure and check that neither row exists.
- The outbox publisher sends unsent rows once and marks them.
- Two concurrent reservations for the last unit: exactly one succeeds (proves the row lock prevents overselling).
- A duplicate `eventId` changes nothing.

**e2e (Testcontainers PostgreSQL + Kafka, both services running, Supertest against GraphQL): does the system work?**
1. Create an order: it becomes `RESERVED` and stock goes down.
2. Order more than is available: `REJECTED` with reason `INSUFFICIENT_STOCK`, and stock is unchanged.
3. Cancel a reserved order: `CANCELLED`, and stock is restored.
4. The same `order.created` event published twice: stock is reserved once.
5. A malformed message lands on `order.created.dlq`, and the next valid order still processes.
6. Pay a `REJECTED` order: refused with `INVALID_STATE`.

e2e tests poll with a timeout for the eventual state (no fixed sleeps).

**CI (GitHub Actions, on every push and PR):** install → lint → typecheck → unit → integration → e2e
(Docker is available on `ubuntu-latest`). There is no `.env` file in CI on purpose: the job must pass from a clean
checkout, which also proves the startup-config rule in section 6. A coverage report is uploaded, and the README shows
the CI badge.

## 8. Scope

**In:** everything above, `docker-compose.yml` (one PostgreSQL instance holding two databases, `orders` and `inventory`, Kafka in KRaft mode,
both services), seed products, and the README with a Mermaid architecture diagram, one-command run instructions, a
"testing strategy" section and a "design decisions" section (outbox, idempotency, DLQ, row locks).

**Out (deliberately):** real payments, authentication, a front end, Kubernetes, a schema registry, observability stacks
beyond structured logs, GraphQL federation, a product admin API.

## 9. Resume line (once CI is green)

> *orderflow — NestJS · GraphQL · Kafka · PostgreSQL · Testcontainers — two event-driven services with a transactional
> outbox, idempotent consumers and a DLQ; unit, integration and e2e tests in CI.*

It goes on the resume only after the repo is public and CI is passing, and its dates must match the GitHub history.
