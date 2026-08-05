# Tasker workspace runner

This image is the only production execution environment for subscription agents and
task workflow commands. Tasker itself remains the host control plane and invokes the
Docker daemon; no task command falls back to direct host execution.

The image intentionally contains provider CLIs and system dependencies, not project
language versions. A pinned workspace runtime policy installs those versions through
`mise` and prepares project dependencies in task-scoped Docker volumes.
