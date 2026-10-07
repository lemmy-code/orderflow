#!/usr/bin/env sh
# Places an order against a running stack and waits until inventory has reserved it:
# proves both services, Kafka and both databases work together, not just that the API answers.
set -eu
URL="${ORDERS_URL:-http://localhost:3000/graphql}"
gql() { curl -sf "$URL" -H 'content-type: application/json' -d "$1"; }

ID=$(gql '{"query":"mutation { createOrder(items: [{productId: \"11111111-1111-4111-8111-111111111111\", quantity: 1}]) { id } }"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ID" ] || { echo "createOrder failed"; exit 1; }
echo "order $ID created"

for i in $(seq 1 30); do
  STATUS=$(gql "{\"query\":\"{ order(id: \\\"$ID\\\") { status } }\"}" | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p')
  echo "attempt $i: ${STATUS:-?}"
  [ "$STATUS" = "RESERVED" ] && exit 0
  sleep 2
done
echo "order never reached RESERVED"; exit 1
