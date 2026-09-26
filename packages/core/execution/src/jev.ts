import * as Data from "effect/Data";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Layer } from "effect";

// ---------------------------------------------------------------------------
// Jev (TypeSafe System One) — a classifier, not a chat model.
//
// It answers many small questions about one shared `state` in a single call, and
// returns a probability per question. That shape is what makes it cheap enough to
// score a whole tool catalog: the questions are nearly free, it is the extra
// PASSES that cost, so one call with N questions beats N calls.
//
// Reached through the Cloudflare AI Gateway like every other provider, as an
// account-level CUSTOM provider (`custom-typesafe`). Two consequences of that
// which are easy to get wrong:
//   - the gateway does not carry through the configured base_url's trailing
//     version segment, so the request path re-supplies `/v1/systemone`;
//   - auth is `cf-aig-authorization` ONLY. An `Authorization` header would be
//     forwarded to the provider and override the gateway's stored BYOK key.
// ---------------------------------------------------------------------------

export const JEV_MODEL = "jev-1.13.0";

// Jev caps the state it reasons over; questions are billed against a larger total.
// Both are in CHARACTERS here (~3 per token) because that is what a caller can
// cheaply measure before paying for a request that would be rejected.
export const JEV_STATE_CHAR_BUDGET = 32_000 * 3;
export const JEV_TOTAL_CHAR_BUDGET = 64_000 * 3;

export class JevError extends Data.TaggedError("JevError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export interface JevGatewayConfig {
  /** Cloudflare account that owns the gateway. */
  readonly accountId: string;
  /** Gateway id, e.g. `staging-gateway`. */
  readonly gatewayId: string;
  /**
   * Resolves the `cf-aig-authorization` bearer, per call. A function rather than
   * a string because the token comes from the Secrets Store: it is fetched on
   * demand and never held in the worker's configuration.
   */
  readonly authToken?: () => Promise<string>;
}

export interface JevQuestion {
  readonly id: string;
  readonly instructions: string;
}

export interface JevAnswer {
  readonly id: string;
  readonly probability: number;
}

export interface AskJevOptions {
  readonly config: JevGatewayConfig;
  /** The shared context every question is asked against. */
  readonly state: string;
  readonly questions: readonly JevQuestion[];
  /** Injected for tests. Defaults to the platform fetch-backed client. */
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}

export const jevGatewayUrl = (config: JevGatewayConfig): string =>
  `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/custom-typesafe/v1/systemone`;

const overBudget = (state: string, questions: readonly JevQuestion[]): string | null => {
  const longest = questions.reduce(
    (max, question) => Math.max(max, question.instructions.length),
    0,
  );
  if (state.length + longest > JEV_STATE_CHAR_BUDGET) {
    return `state plus the longest question exceeds ${JEV_STATE_CHAR_BUDGET} characters`;
  }
  const total = questions.reduce(
    (sum, question) => sum + question.instructions.length,
    state.length,
  );
  return total > JEV_TOTAL_CHAR_BUDGET
    ? `state plus all questions exceeds ${JEV_TOTAL_CHAR_BUDGET} characters`
    : null;
};

// The body keys questions by id, so a duplicate id would silently drop one
// question and misattribute its answer to the other.
const duplicateId = (questions: readonly JevQuestion[]): string | null => {
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) {
      return question.id;
    }
    seen.add(question.id);
  }
  return null;
};

const readAnswers = (body: unknown): readonly JevAnswer[] => {
  if (typeof body !== "object" || body === null || !("answers" in body)) {
    return [];
  }
  const answers = (body as { readonly answers: unknown }).answers;
  if (typeof answers !== "object" || answers === null) {
    return [];
  }
  return Object.entries(answers).flatMap(([id, answer]) => {
    const noul =
      typeof answer === "object" && answer !== null && "noul" in answer
        ? (answer as { readonly noul: unknown }).noul
        : undefined;
    return typeof noul === "number" ? [{ id, probability: noul }] : [];
  });
};

/**
 * Score every question against one state. Returns an answer per question Jev
 * scored; a question it declines to score is simply absent rather than zero, so
 * a caller can tell "not relevant" from "no opinion".
 */
export const askJev = (options: AskJevOptions): Effect.Effect<readonly JevAnswer[], JevError> =>
  Effect.gen(function* () {
    if (options.questions.length === 0) {
      return [];
    }
    const duplicate = duplicateId(options.questions);
    if (duplicate !== null) {
      return yield* new JevError({
        message: `Duplicate Jev question id "${duplicate}"`,
      });
    }
    const tooBig = overBudget(options.state, options.questions);
    if (tooBig !== null) {
      return yield* new JevError({ message: `Jev request rejected: ${tooBig}` });
    }

    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    for (const question of options.questions) {
      questions[question.id] = {
        type: "noul",
        instructions: question.instructions,
      };
    }

    const resolveToken = options.config.authToken;
    const token =
      resolveToken === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => resolveToken(),
            catch: (cause) =>
              new JevError({
                message: "Could not resolve the AI Gateway token",
                cause,
              }),
          });

    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(jevGatewayUrl(options.config)).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { "cf-aig-authorization": `Bearer ${token}` }),
      }),
      HttpClientRequest.bodyJsonUnsafe({
        model: JEV_MODEL,
        state: options.state,
        questions,
      }),
    );

    const requestStartedAt = Date.now();
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new JevError({ message: "Jev request failed", cause })));
    yield* Effect.logInfo("jev call answered", {
      status: response.status,
      durationMs: Date.now() - requestStartedAt,
      stateChars: options.state.length,
      questions: options.questions.length,
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* new JevError({
        message: `Jev returned ${response.status}`,
        status: response.status,
      });
    }
    const body = yield* response.json.pipe(
      Effect.mapError((cause) => new JevError({ message: "Jev response was not JSON", cause })),
    );
    const answers = readAnswers(body);
    yield* Effect.logInfo("jev call parsed", {
      answers: answers.length,
      questions: options.questions.length,
    });
    return answers;
  }).pipe(Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer));
