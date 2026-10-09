---
"@executor-js/host-mcp": patch
---

Passthrough connections (`?mode=passthrough`) now search and invoke Executor's own configuration tools, such as `executor.mcp.addServer`, `executor.connections.createHandoff` and `executor.oauth.start`, so an agent on that surface can add an integration when asked. Block policies still hide them.
