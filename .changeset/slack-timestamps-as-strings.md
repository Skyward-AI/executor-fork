---
"@executor-js/plugin-openapi": patch
---

Slack tools accept message timestamps (`ts`, `thread_ts`, `latest`, `oldest` and other `*_ts` inputs) as strings, so history and thread lookups are no longer rejected. Refresh an existing Slack integration's spec to pick this up.
