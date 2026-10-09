import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  type ConnectionRef,
} from "@executor-js/sdk";

import type { InternalIntegration } from "../config";

export const INTERNAL_CONNECTION_NAME = "main";

export type ReconcileOutcome = "created" | "skipped" | "failed";

export interface InternalIntegrationExecutor {
  readonly integrations: {
    readonly get: (slug: IntegrationSlug) => Effect.Effect<unknown, unknown>;
  };
  readonly mcp: {
    readonly addServer: (input: {
      readonly transport: "remote";
      readonly name: string;
      readonly slug: string;
      readonly description: string;
      readonly endpoint: string;
      readonly remoteTransport: "streamable-http";
      readonly auth: { readonly kind: "none" };
    }) => Effect.Effect<unknown, unknown>;
  };
  readonly connections: {
    readonly create: (input: {
      readonly owner: "org";
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly values: Record<string, never>;
    }) => Effect.Effect<unknown, unknown>;
    readonly refresh: (ref: ConnectionRef) => Effect.Effect<unknown, unknown>;
  };
}

const reconcileOne = (executor: InternalIntegrationExecutor, entry: InternalIntegration) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(entry.slug);
    const existing = yield* executor.integrations.get(slug);
    if (existing !== null && existing !== undefined) {
      yield* Effect.logInfo(`internal integration ${entry.slug} already exists, left untouched`);
      return "skipped" as const;
    }
    yield* executor.mcp.addServer({
      transport: "remote",
      name: entry.name,
      slug: entry.slug,
      description: entry.description,
      endpoint: entry.endpoint,
      remoteTransport: "streamable-http",
      auth: { kind: "none" },
    });
    const name = ConnectionName.make(INTERNAL_CONNECTION_NAME);
    yield* executor.connections.create({
      owner: "org",
      name,
      integration: slug,
      template: AuthTemplateSlug.make("none"),
      values: {},
    });
    yield* executor.connections.refresh({ owner: "org", integration: slug, name });
    return "created" as const;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`internal integration ${entry.slug} could not be reconciled`, cause).pipe(
        Effect.annotateLogs({ step: "reconcile-internal-integration", slug: entry.slug }),
        Effect.as("failed" as const),
      ),
    ),
  );

/**
 * Creates each declared integration that does not exist yet, with its org
 * connection `main`, and loads its tools. Never updates or deletes anything,
 * and never fails the caller.
 */
export const reconcileInternalIntegrations = (
  executor: InternalIntegrationExecutor,
  entries: readonly InternalIntegration[],
): Effect.Effect<ReadonlyArray<readonly [string, ReconcileOutcome]>> =>
  Effect.forEach(entries, (entry) =>
    reconcileOne(executor, entry).pipe(Effect.map((outcome) => [entry.slug, outcome] as const)),
  );
