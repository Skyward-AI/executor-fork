// A stand-in for the monorepo worker that pulls connection health: the e2e
// starts it beside the real Worker so the call crosses a real service binding
// to the `ExecutorInternal` entrypoint, as in production.
interface Env {
  readonly EXECUTOR: { connectionHealth(): Promise<unknown> };
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    return Response.json(await env.EXECUTOR.connectionHealth());
  },
};
