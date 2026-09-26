---
"executor": patch
---

Background tool-catalog rebuilds share one executor-wide limit, set with the new `toolsSyncConcurrency` option, so reads that overlap cannot stack more rebuilds in one instance than the limit. A rebuild that is already queued is joined, not queued again, and a retry of a sync that never finished runs after the other stale catalogs.
