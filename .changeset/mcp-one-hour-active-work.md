---
"@executor-js/plugin-mcp": patch
---

An upstream MCP tool call now has one hour of active work before it is cut off, up from 60 seconds, so a single long tool call finishes. The deadline still pauses while an elicitation waits for input, and one hour still bounds a hung upstream.
