import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { JEV_MODEL, JEV_STATE_CHAR_BUDGET, JevError, askJev } from "./jev";

interface RecordedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// Records the outgoing request so the wire contract can be asserted: the gateway
// path, the auth header, and the body shape are all things a silent change to
// would leave the ranker quietly returning nothing.
const recordingClient = (
  respond: () => Response = () => new Response(`{"answers":{}}`, { status: 200 }),
): Effect.Effect<{
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Ref.Ref<ReadonlyArray<RecordedRequest>>;
}> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<RecordedRequest>>([]);
    const layer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          // `bodyJsonUnsafe` encodes to bytes, so decode rather than expecting a
          // string — reading the wrong field silently captured "" and made every
          // body assertion vacuous.
          const raw =
            typeof request.body === "object" &&
            request.body !== null &&
            "body" in request.body
              ? request.body.body
              : undefined;
          const body =
            typeof raw === "string"
              ? raw
              : raw instanceof Uint8Array
                ? new TextDecoder().decode(raw)
                : "";
          yield* Ref.update(requests, (xs) => [
            ...xs,
            { url: request.url, headers: request.headers, body },
          ]);
          return HttpClientResponse.fromWeb(request, respond());
        }),
      ),
    );
    return { layer, requests };
  });

const CONFIG = {
  accountId: "acct",
  gatewayId: "staging-gateway",
  authToken: () => Promise.resolve("gw-token"),
};

describe("askJev", () => {
  it.effect("asks every question in ONE call, against one shared state", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient(
        () =>
          new Response(`{"answers":{"a":{"noul":0.9},"b":{"noul":0.1}}}`, {
            status: 200,
          }),
      );
      const answers = yield* askJev({
        config: CONFIG,
        state: "the catalog",
        questions: [
          { id: "a", instructions: "is this about linear?" },
          { id: "b", instructions: "is this about billing?" },
        ],
        httpClientLayer: layer,
      });

      // One call, N questions — the whole reason this is cheap enough to rank a catalog.
      expect(yield* Ref.get(requests)).toHaveLength(1);
      expect(answers).toEqual([
        { id: "a", probability: 0.9 },
        { id: "b", probability: 0.1 },
      ]);
    }));

  it.effect("posts to the gateway's custom-provider path, re-supplying the version segment", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      yield* askJev({
        config: CONFIG,
        state: "s",
        questions: [{ id: "a", instructions: "q" }],
        httpClientLayer: layer,
      });
      const [request] = yield* Ref.get(requests);
      expect(request?.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct/staging-gateway/custom-typesafe/v1/systemone",
      );
    }));

  it.effect("authenticates with cf-aig-authorization and NEVER an Authorization header", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      yield* askJev({
        config: CONFIG,
        state: "s",
        questions: [{ id: "a", instructions: "q" }],
        httpClientLayer: layer,
      });
      const [request] = yield* Ref.get(requests);
      expect(request?.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
      // An Authorization header would be forwarded to the provider and override
      // the gateway's stored BYOK key, so the request must never carry one.
      expect(request?.headers["authorization"]).toBeUndefined();
    }));

  it.effect("resolves the token per call, so a rotated secret is picked up without redeploying", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      let issued = 0;
      const rotating = {
        accountId: "acct",
        gatewayId: "staging-gateway",
        authToken: () => Promise.resolve(`token-${(issued += 1)}`),
      };
      const ask = () =>
        askJev({
          config: rotating,
          state: "s",
          questions: [{ id: "a", instructions: "q" }],
          httpClientLayer: layer,
        });
      yield* ask();
      yield* ask();

      const sent = yield* Ref.get(requests);
      expect(sent[0]?.headers["cf-aig-authorization"]).toBe("Bearer token-1");
      expect(sent[1]?.headers["cf-aig-authorization"]).toBe("Bearer token-2");
    }));

  it.effect("fails clearly when the secret cannot be resolved, instead of calling unauthenticated", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      const error = yield* Effect.flip(
        askJev({
          config: {
            accountId: "acct",
            gatewayId: "g",
            // A store read that fails, produced by Effect rather than a hand-rolled
            // rejection — the binding's `get()` returns a promise, so this is the
            // honest shape of the Secrets Store being unavailable.
            authToken: () =>
              Effect.runPromise(
                Effect.fail(new JevError({ message: "store unavailable" })),
              ),
          },
          state: "s",
          questions: [{ id: "a", instructions: "q" }],
          httpClientLayer: layer,
        }),
      );
      expect(Predicate.isTagged(error, "JevError")).toBe(true);
      // An unauthenticated call would 401 and read as "Jev is broken" rather
      // than "the secret could not be read".
      expect(yield* Ref.get(requests)).toHaveLength(0);
    }));

  it.effect("sends the model and keys questions by id", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      yield* askJev({
        config: CONFIG,
        state: "the state",
        questions: [{ id: "tool-1", instructions: "matches?" }],
        httpClientLayer: layer,
      });
      const [request] = yield* Ref.get(requests);
      expect(request?.body).toContain(`"model":"${JEV_MODEL}"`);
      expect(request?.body).toContain(`"state":"the state"`);
      expect(request?.body).toContain(`"tool-1":{"type":"noul","instructions":"matches?"}`);
    }));

  it.effect("refuses a duplicate question id instead of silently dropping one", () =>
    Effect.gen(function* () {
      const { layer } = yield* recordingClient();
      const error = yield* Effect.flip(
        askJev({
          config: CONFIG,
          state: "s",
          questions: [
            { id: "same", instructions: "first" },
            { id: "same", instructions: "second" },
          ],
          httpClientLayer: layer,
        }),
      );
      expect(Predicate.isTagged(error, "JevError")).toBe(true);
    }));

  it.effect("refuses a state over budget rather than paying for a rejected request", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      const error = yield* Effect.flip(
        askJev({
          config: CONFIG,
          state: "x".repeat(JEV_STATE_CHAR_BUDGET),
          questions: [{ id: "a", instructions: "q" }],
          httpClientLayer: layer,
        }),
      );
      expect(Predicate.isTagged(error, "JevError")).toBe(true);
      expect(yield* Ref.get(requests)).toHaveLength(0);
    }));

  it.effect("makes no call at all when there is nothing to ask", () =>
    Effect.gen(function* () {
      const { layer, requests } = yield* recordingClient();
      const answers = yield* askJev({
        config: CONFIG,
        state: "s",
        questions: [],
        httpClientLayer: layer,
      });
      expect(answers).toEqual([]);
      expect(yield* Ref.get(requests)).toHaveLength(0);
    }));

  it.effect("fails on a non-2xx instead of reporting no matches", () =>
    Effect.gen(function* () {
      const { layer } = yield* recordingClient(
        () => new Response("nope", { status: 500 }),
      );
      const error = yield* Effect.flip(
        askJev({
          config: CONFIG,
          state: "s",
          questions: [{ id: "a", instructions: "q" }],
          httpClientLayer: layer,
        }),
      );
      expect(error.status).toBe(500);
    }));

  it.effect("drops an answer Jev declined to score rather than reading it as zero", () =>
    Effect.gen(function* () {
      const { layer } = yield* recordingClient(
        () =>
          new Response(`{"answers":{"a":{"noul":0.5},"b":{}}}`, { status: 200 }),
      );
      const answers = yield* askJev({
        config: CONFIG,
        state: "s",
        questions: [
          { id: "a", instructions: "q" },
          { id: "b", instructions: "q" },
        ],
        httpClientLayer: layer,
      });
      // "no opinion" must not become "score 0" — that would rank a tool as a
      // confident non-match instead of an unknown.
      expect(answers).toEqual([{ id: "a", probability: 0.5 }]);
    }));
});
