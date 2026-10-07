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
