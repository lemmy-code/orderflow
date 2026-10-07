-- Local development only. Each service gets its own login that owns only its own database,
-- so the database-per-service boundary holds at the credential level too.
CREATE ROLE orders_app LOGIN PASSWORD 'orders_app_local';
CREATE ROLE inventory_app LOGIN PASSWORD 'inventory_app_local';

ALTER DATABASE orders OWNER TO orders_app;
CREATE DATABASE inventory OWNER inventory_app;

REVOKE ALL ON DATABASE orders FROM PUBLIC;
REVOKE ALL ON DATABASE inventory FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE orders TO orders_app;
GRANT CONNECT, TEMPORARY ON DATABASE inventory TO inventory_app;
