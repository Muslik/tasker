# Store

SQLite schema, migrations, repositories, checksums, and domain persistence.

Depends only on shared values and outcomes.

Phase 3.4a domain tables serve transcripts, receipts, agent invocations, artifacts,
and the operator stream. Phase 3.4b adds a revisioned `documents` table for
low-volume domain stores that want immutable revisions, latest-by-id reads,
kind-scoped listing, and optimistic append without introducing new event streams.
The generic event, projection, aggregate-head, and snapshot tables are removed
from fresh databases.
