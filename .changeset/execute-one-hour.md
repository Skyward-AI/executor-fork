---
"@executor-js/runtime-dynamic-worker": patch
"@executor-js/runtime-quickjs": patch
"@executor-js/runtime-deno-subprocess": patch
"@executor-js/runtime-workerd-subprocess": patch
---

Code run through `execute` now has sixty minutes by default before it is stopped, up from five, so a script that waits on a long job (polling a machine run, a long upstream call) finishes in one call. A caller can still pass a shorter `timeoutMs`.
