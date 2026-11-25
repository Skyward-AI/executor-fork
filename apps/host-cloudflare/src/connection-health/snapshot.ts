import { Schema } from "effect";

import { HealthCheckReason, HealthStatus } from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// The contract of `ExecutorInternal.connectionHealth()`. A snapshot is the
// latest stored verdict for each workspace connection and each active member's
// personal connection; a connection never checked is omitted. Upstream error
// text never crosses: only the classified status and reason.
// ---------------------------------------------------------------------------

export const ConnectionHealthVerdict = Schema.Struct({
  owner: Schema.Literals(["org", "user"]),
  /** The owning member's external id for a personal connection; null for a
   *  workspace connection. */
  subject: Schema.NullOr(Schema.String),
  integration: Schema.String,
  integrationName: Schema.String,
  name: Schema.String,
  /** The connection's page in the console, when a public base URL is set. */
  url: Schema.NullOr(Schema.String),
  /** What the receiver may act on; see `healthEvidence`. */
  evidence: Schema.Literals(["failing", "healthy", "inconclusive"]),
  status: HealthStatus,
  reason: Schema.NullOr(HealthCheckReason),
  /** When the evidence was produced; a recorded dead grant keeps its time. */
  checkedAt: Schema.Number,
});
export type ConnectionHealthVerdict = typeof ConnectionHealthVerdict.Type;

export const ConnectionHealthSnapshot = Schema.Struct({
  tenant: Schema.String,
  verdicts: Schema.Array(ConnectionHealthVerdict),
});
export type ConnectionHealthSnapshot = typeof ConnectionHealthSnapshot.Type;
