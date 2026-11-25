---
"executor": patch
"@executor-js/sdk": patch
"@executor-js/api": patch
---

The Cloudflare host checks every connection on an hourly schedule, workspace connections each hour and personal connections every six hours, refreshing any OAuth token that would expire before the next check, so a revoked or expired grant is found by the schedule instead of by the next call that needs it. Each pass hands a snapshot of the verdicts it produced, upstream error text excluded, to an optional `CONNECTION_HEALTH_REPORTS` service binding through its RPC `report(snapshot)` method; members not seen for 30 days (or never seen and recorded 30 days ago) are skipped. `connections.checkHealth` accepts `refreshWithinMs` to refresh a token that expires within that window, `healthEvidence` classifies a verdict as failing, healthy or inconclusive for an alerting reporter, `listSubjectsWithConnections` reads a page of up to 500 members in chunks a D1 statement accepts, and `makeScopedExecutor` accepts `recordSighting: false` for background work done on a member's behalf.
