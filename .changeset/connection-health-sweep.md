---
"executor": patch
"@executor-js/sdk": patch
"@executor-js/api": patch
---

The Cloudflare host checks every connection on an hourly schedule, workspace connections each hour and personal connections every six hours, refreshing any OAuth token that would expire before the next check, so a revoked or expired grant is found by the schedule instead of by the next call that needs it. Each check is stored on the connection; members not seen for 30 days (or never seen and recorded 30 days ago) are skipped, and a pass that has run for 10 minutes starts no further owner, leaving it for the next pass. Nothing is pushed and no binding is needed: the internal door, the `ExecutorInternal` entrypoint, gains an RPC method `connectionHealth()` that returns the latest stored verdict for each workspace connection and each active member's personal connection (a connection never checked is omitted), without upstream error text, and rejects when storage cannot be read. `connections.checkHealth` accepts `refreshWithinMs` to refresh a token that expires within that window, `healthEvidence` classifies a verdict as failing, healthy or inconclusive, `listSubjectsWithConnections` reads a page of up to 500 members in chunks a D1 statement accepts, and `makeScopedExecutor` accepts `recordSighting: false` for background work done on a member's behalf.
