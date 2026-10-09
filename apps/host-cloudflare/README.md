# @executor-js/host-cloudflare

Executor as a single Cloudflare Worker. The fourth app on the shared
`ExecutorApp.make` facade (alongside cloud, self-host, and local) — same code
paths, different injected providers:

| Seam         | Cloudflare provider                                              |
| ------------ | ---------------------------------------------------------------- |
| **identity** | Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) — no app login |
| **db**       | D1 (SQLite) via the shared FumaDB assembly                       |
| **engine**   | QuickJS-WASM, in-Worker (no extra binding)                       |
| **mcp**      | Access-JWT auth + the shared in-process session store            |
| **account**  | `/account/me` from the Access principal (members/keys → Access)  |
| **web**      | the shared multiplayer SPA (Workers Static Assets)               |

Single-tenant: every Access-verified principal belongs to the one configured
org. Members and credentials are managed in Cloudflare Access, not in-app.

## Surfaces

- `GET /` — the shared Executor web UI (Sources, Connections, Secrets,
  Policies) — the same shell as cloud/self-host, built by `vite build` into
  `dist/` and served via Workers Static Assets (`single-page-application`
  fallback for client routes).
- `/api/*` — the full Executor API (scopes, sources, secrets, account, …).
- `/mcp` — streamable-HTTP MCP with an `execute` tool.

`run_worker_first` in `wrangler.jsonc` keeps `/api/*` + `/mcp` on the Worker;
everything else is the SPA. Every API/MCP route is gated by the Access JWT (401
without). The SPA's auth context reads `/api/account/me`.

### Internal tools over service bindings

The surfaces above are inbound. Outbound, a private MCP server in another Worker
is reached over a service binding, never the internet. `INTERNAL_MCP_HOSTS` is a
comma-separated list of `host=BINDING` pairs (host ends in `.internal`), and each
BINDING is a service binding on this Worker:

```jsonc
"services": [{ "binding": "TOOLS", "service": "my-tools", "entrypoint": "ToolsMcp" }],
"vars": { "INTERNAL_MCP_HOSTS": "tools.internal=TOOLS" }
```

An MCP integration with endpoint `https://tools.internal/mcp/websearch` is then
served by `env.TOOLS.fetch(request)`, for the MCP transport and for the plain
fetch (OAuth discovery, probes, `/.well-known/*`; the bound Worker should answer
404 for paths it does not serve). The match is on the exact hostname, outside the
SSRF guard. Every other host takes the guarded path unchanged, any other
`*.internal` host is refused, and an external server redirecting to an internal
host stays blocked. Requests to a binding go out with `redirect: "manual"`, so a
redirect answered by the bound Worker reaches the caller as is and is never
followed. A host naming a missing binding fails config load: the Worker answers
503 with a message naming the host and the binding. Both the Worker and
`McpSessionDO` read the same config, so both paths route.

`INTERNAL_MCP_REGISTRIES` declares what each internal host serves, as a JSON
array of `{ "host", "servers": [{ "slug", "name", "description", "route" }] }`
with `route` equal to `/mcp/<slug>` and every `host` present in
`INTERNAL_MCP_HOSTS` (otherwise config load fails). Once per isolate, each
declared server whose slug does not exist yet is created as an org-level MCP
integration at `https://<host><route>` (no auth) with an org connection named
`main`, and its tools are loaded. An existing integration with the same slug is
never changed, and nothing is ever deleted.

**Trust boundary.** The boundary is the Cloudflare account, not Executor: any
Worker in the same account could bind the target Worker, so the bound Worker
must be private (no public route, `workers_dev` and preview URLs off) and
Executor is its only intended caller. Hosts match exactly (`tools.internal`, not
`x.tools.internal`), and a redirect from an external server into `*.internal` is
refused. Because an integration pointing at an internal host reaches code that
skips the SSRF guard, only admins should create such integrations, never
end users.

## Deploy

```bash
bunx wrangler login
bun run deploy:setup    # apps/host-cloudflare — provisions D1 + secret + deploys
```

`deploy:setup` (scripts/deploy.sh) is idempotent. It creates or reuses the
`executor` D1 database, writes its id into `wrangler.jsonc`, generates and
uploads `EXECUTOR_SECRET_KEY`, then deploys. It then prints the one manual step.

### The one manual step — Cloudflare Access

After the first deploy, API and MCP requests return 503 and name the missing
Access variables until configuration is complete. In the Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted**
2. Application domain: `executor-cloudflare.<your-subdomain>.workers.dev`
3. Add an Access policy (e.g. _Emails ending in `@yourcompany.com`_)
4. Copy the Application **Audience (AUD)** tag, then:
   ```bash
   bunx wrangler deploy \
     --var ACCESS_AUD:<aud> \
     --var ACCESS_TEAM_DOMAIN:<your-team>.cloudflareaccess.com \
     --var ADMIN_EMAILS:<admin@example.com>
   ```

Now visiting the Worker prompts an Access login; the Worker validates the issued
JWT on every request. Unauthenticated requests return 401. MCP clients present
an Access JWT or `Cf-Access-Client-Id`/`-Secret` service-token headers.

The Access values are live Worker variables, not values in `wrangler.jsonc`.
Wrangler's `keep_vars` option preserves them during later code deploys. Run the
command above again whenever you need to change them.

### Redeploy after a merge

There is no automatic deploy. To ship a merged change:

```bash
git checkout skyward && git pull --ff-only
bun install
cd apps/host-cloudflare
bun run deploy   # vite build -> assert-shell-asset -> wrangler deploy
```

If the deployment declares internal service bindings, deploy through the
monorepo that owns them (`pnpm executor:deploy`) instead of `bun run deploy`
here. A deploy from this directory does not carry those bindings, and internal
integrations then fail until it is redeployed the right way.

Requires `bunx wrangler login` to the Skyward account. `keep_vars` preserves
the Access variables set above, so there is nothing else to pass. Do not
re-run `deploy:setup` for a routine deploy; that script is for first-time
provisioning.

Verify with `bunx wrangler deployments list` (run from `apps/host-cloudflare`),
which lists the new version. Logs and traces are in Cloudflare Workers
Observability for `executor-cloudflare`.

## Local development

```bash
# .dev.vars
EXECUTOR_SECRET_KEY=dev-secret-key-0123456789abcdef
ENABLE_DEV_AUTH=true     # bypass Access; every request is a fixed dev admin

bun run build            # vite build -> dist/ (the SPA)
bunx wrangler dev --local   # serves the SPA + Worker API together
```

`bun run dev:web` runs the Vite dev server (HMR) for UI work; point its API at a
running `wrangler dev` if you need live data.

`ENABLE_DEV_AUTH` is a dev-only escape hatch — never set it in a deployed
environment (it disables the Access gate).

## Notes

- The QuickJS engine WASM is vendored into `src/quickjs-engine.wasm` (Workers
  forbid runtime WASM compilation; it must be statically imported). Refresh it
  after bumping the engine with `bun run vendor-wasm`.
- MCP sessions live in-process (one isolate owns a session). The cross-isolate
  upgrade is a Durable Object behind the same `McpSessionStore` seam.
- When Cloudflare's dynamic Worker Loader leaves closed beta, the QuickJS code
  substrate swaps for the dynamic-worker executor behind the `engine` seam — a
  one-Layer change.
