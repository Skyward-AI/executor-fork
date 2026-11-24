---
"executor": patch
"@executor-js/sdk": patch
"@executor-js/api": patch
---

The Cloudflare host checks every connection on an hourly schedule, workspace connections each hour and personal connections every six hours, refreshing any OAuth token that would expire before the next check, so a revoked or expired grant is found by the schedule instead of by the next call that needs it. Set `CONNECTION_HEALTH_WEBHOOK_URL` and the `CONNECTION_HEALTH_WEBHOOK_SECRET` (`whsec_`) secret to receive each failing or recovered connection as a signed Standard Webhook. `connections.checkHealth` accepts `refreshWithinMs` to refresh a token that expires within that window, `isFailingHealth` tells whether a verdict says the credential is not working, and `makeScopedExecutor` accepts `recordSighting: false` for background work done on a member's behalf.
