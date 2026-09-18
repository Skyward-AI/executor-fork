import { Effect } from "effect";

import {
  askJev,
  JEV_STATE_CHAR_BUDGET,
  type JevGatewayConfig,
  type JevQuestion,
} from "./jev";
import {
  defaultToolDiscoveryProvider,
  matchesNamespace,
  paginate,
  toSearchableTool,
  type SearchableTool,
  type ToolDiscoveryInput,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "./tool-invoker";

// ---------------------------------------------------------------------------
// Semantic ranking for tool search.
//
// Jev IS the ranker here; lexical is the fallback, not the first pass. The
// repo's users write Spanglish, and a token-overlap scorer is close to noise for
// that: it drops a tool entirely when nothing overlaps, and it "matches" on an
// incidental word like a namespace when something does. Ranking by meaning is
// the job, so the semantic scorer does it and the lexical one stands by for when
// Jev is unavailable.
//
// The catalog is scored in SHARDS sized by Jev's state budget rather than a
// guessed tool count, because what fills that budget is description length, not
// the number of tools: a handful of verbose MCP tools can outweigh a hundred
// terse ones. Shards run in parallel and their scores merge into one ranking, so
// growth costs more calls rather than a silently truncated catalog. Each shard is
// its own pass and passes are the part that costs, so the chunks are made as
// large as the budget allows rather than small and many.
// ---------------------------------------------------------------------------

/** Below this, Jev's opinion is too weak to be worth showing as a match. */
const MIN_PROBABILITY = 0.3;

/**
 * How much of Jev's state budget one shard may use. Headroom is left for the
 * questions, which are billed against a larger total but still share the state
 * ceiling with the longest one.
 */
const SHARD_CHAR_BUDGET = Math.floor(JEV_STATE_CHAR_BUDGET * 0.6);

/** A single tool's description is truncated to this before scoring: a verbose
 *  one would otherwise consume a shard on its own, and the opening sentence is
 *  what carries the meaning. */
const MAX_DESCRIPTION_CHARS = 300;

/** Shards scored at once. Enough to cover a large catalog in one round trip
 *  without opening an unbounded number of connections from a Worker. */
const SHARD_CONCURRENCY = 4;

export interface JevToolDiscoveryOptions {
  readonly gateway: JevGatewayConfig;
  /** The lexical provider to try first. Defaults to the built-in one. */
  readonly delegate?: ToolDiscoveryProvider;
  /** Injected for tests; `askJev` defaults to the platform fetch client. */
  readonly httpClientLayer?: JevToolDiscoveryHttpLayer;
}

/** The HTTP layer `askJev` accepts, re-exported so a caller can inject one. */
export type JevToolDiscoveryHttpLayer = NonNullable<
  Parameters<typeof askJev>[0]["httpClientLayer"]
>;

const describeTool = (tool: SearchableTool): string =>
  tool.description === undefined
    ? `${tool.path} (${tool.name})`
    : `${tool.path} (${tool.name}): ${tool.description.slice(0, MAX_DESCRIPTION_CHARS)}`;

export const makeJevToolDiscoveryProvider = (
  options: JevToolDiscoveryOptions,
): ToolDiscoveryProvider => {
  const delegate = options.delegate ?? defaultToolDiscoveryProvider;

  return {
    searchTools: (input: ToolDiscoveryInput) =>
      Effect.gen(function* () {
        const lexical = yield* delegate.searchTools(input);
        const query = input.query.trim();
        // Whether the rescue ran, and whether it helped, is the whole question
        // this feature exists to answer. Unannotated it is invisible: a search
        // that Jev saved looks exactly like one lexical got right.
        yield* Effect.annotateCurrentSpan({
          "executor.search.jev.lexical_total": lexical.total,
        });
        // An empty query is enumeration, not search: there is nothing to be
        // semantically closer to. Every other query gets scored.
        if (query.length === 0) {
          yield* Effect.annotateCurrentSpan({
            "executor.search.jev.attempted": false,
            "executor.search.jev.skipped_reason": "empty_query",
          });
          return lexical;
        }

        const all = yield* input.executor.tools
          .list({ includeAnnotations: false })
          .pipe(Effect.orElseSucceed(() => []));
        const namespace = input.namespace?.trim();
        // Normalised and scoped exactly as the lexical ranker does, so turning Jev
        // on cannot change WHICH tools a namespace search considers.
        const candidates = all
          .map(toSearchableTool)
          .filter((tool) => matchesNamespace(tool, namespace));
        if (candidates.length === 0) {
          yield* Effect.annotateCurrentSpan({
            "executor.search.jev.attempted": false,
            "executor.search.jev.skipped_reason": "no_candidates",
          });
          return lexical;
        }

        // Shard by CHARACTERS, not by tool count: what fills Jev's state budget
        // is description length, and a few verbose tools outweigh many terse ones.
        const shards: SearchableTool[][] = [];
        let shard: SearchableTool[] = [];
        let shardChars = 0;
        for (const tool of candidates) {
          const cost = describeTool(tool).length + 1;
          if (shard.length > 0 && shardChars + cost > SHARD_CHAR_BUDGET) {
            shards.push(shard);
            shard = [];
            shardChars = 0;
          }
          // push, not spread: rebuilding the array per tool is O(n^2) in exactly
          // the path that exists for large catalogs.
          shard.push(tool);
          shardChars += cost;
        }
        if (shard.length > 0) {
          shards.push(shard);
        }

        // Each shard carries its own question ids, so an answer is resolved
        // against the tools of the shard that asked — a global index would
        // misattribute every score past the first shard.
        const scoreShard = (tools: readonly SearchableTool[]) =>
          askJev({
            config: options.gateway,
            state: [
              "Each question asks whether one tool answers the user's request.",
              "The tools available:",
              ...tools.map(describeTool),
            ].join("\n"),
            questions: tools.map((tool, index) => ({
              id: String(index),
              instructions: `Would ${tool.path} answer this request: ${query}`,
            })) satisfies JevQuestion[],
            ...(options.httpClientLayer === undefined
              ? {}
              : { httpClientLayer: options.httpClientLayer }),
          }).pipe(
            // One failed shard must not lose the others: it contributes nothing
            // and the ranking is built from whatever came back.
            Effect.orElseSucceed(() => []),
            Effect.map((answers) =>
              answers.flatMap((answer) => {
                const tool = tools[Number(answer.id)];
                return tool === undefined
                  ? []
                  : [{ tool, probability: answer.probability }];
              }),
            ),
          );

        const scored = (
          yield* Effect.all(shards.map(scoreShard), {
            concurrency: SHARD_CONCURRENCY,
          })
        ).flat();

        // Jev IS the ranking. Lexical only stands in when Jev produced nothing,
        // which means the gateway failed or every shard came back empty.
        const ranked: ToolDiscoveryResult[] = scored
          .filter((entry) => entry.probability >= MIN_PROBABILITY)
          .map((entry) => ({
            path: entry.tool.path,
            name: entry.tool.name,
            integration: entry.tool.integration,
            score: Math.round(entry.probability * 100),
            ...(entry.tool.description === undefined
              ? {}
              : { description: entry.tool.description }),
          }));

        yield* Effect.annotateCurrentSpan({
          "executor.search.jev.attempted": true,
          "executor.search.jev.candidate_count": candidates.length,
          "executor.search.jev.shard_count": shards.length,
          "executor.search.jev.scored_count": scored.length,
          "executor.search.jev.ranked_count": ranked.length,
          "executor.search.jev.lexical_fallback": ranked.length === 0,
        });
        if (ranked.length === 0) {
          return lexical;
        }
        ranked.sort(
          (left, right) =>
            right.score - left.score || left.path.localeCompare(right.path),
        );
        return paginate(ranked, input.offset, input.limit);
      }),
  };
};
