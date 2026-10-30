---
"executor": patch
---

Reads and unreached writes to D1 are retried for up to 20 seconds instead of five attempts in under four seconds, so a D1 outage of about 15 seconds no longer fails `search` and `invoke` with `Internal tool error`.
