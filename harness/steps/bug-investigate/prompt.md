Investigate whether the reported bug can be reproduced in the prepared workspace.

This is read-only bootstrap investigation before the execution workflow exists. Inspect the task,
repository, configured runtime, and available test or browser surfaces. Do not modify tracked files,
create commits, push branches, or update external systems.

Return an honest result:

- `reproduced` only when the observed behavior matches the report;
- `not_reproduced` when the tested scenario clearly behaves correctly;
- `inconclusive` when prerequisites, environment, or task ambiguity prevent a reliable verdict.

Record concise observations and durable evidence references. If a material ambiguity requires an
operator decision, block with one precise question instead of guessing.
