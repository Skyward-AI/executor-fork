---
"@executor-js/sdk": patch
"@executor-js/api": patch
---

Requests to an internal host (a service binding) now carry the acting account in `x-executor-account-id`, so the bound Worker can authorize per caller. Any value the request already carried is replaced, and requests to other hosts never get it.
