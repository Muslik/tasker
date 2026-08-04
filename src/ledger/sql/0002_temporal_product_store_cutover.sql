INSERT INTO schema_metadata (key, value)
VALUES ('schema_baseline', 'product-store-v1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS leases;
DROP TABLE IF EXISTS signals;
