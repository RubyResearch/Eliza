# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic ScheduledTask state machine, registries, runner, and the spine→reminders ports. See CLAUDE.md for the package contract.

> **Vocabulary:** a `ScheduledTask` record is a **scheduled item** (reminder / check-in / follow-up / …), distinct from a core **task**, an engine **workflow**, and an orchestrator **coding task**. The runner owns no timer — it is ticked by the single core `TaskService` clock via the `LIFEOPS_SCHEDULER` task.


Hosts may supply `executionBoundary` through the runner dependencies. It receives
an existing scheduled item and an `execute` callback spanning the fire claim,
dispatch, final persistence, and awaited follow-up work. A host can deny admission
before the claim or retain a durable operation until `execute` finishes. The host
must invoke the callback at most once and await it; rejected execution propagates
to the host so uncertain effects can remain available for reconciliation. The
atomic fire claim also checks the metadata observed by admission; a concurrent
metadata change returns `raced` so the next attempt obtains fresh admission. Task
creation and editing are separate persistence operations and are not covered by
this execution boundary.
