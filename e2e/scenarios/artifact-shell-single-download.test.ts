// On a cold cache the artifact's shell document is downloaded exactly once, and
// that download starts before the artifact row has come back.
//
// The shell is the largest thing the page loads. A hint from the top frame does
// not make the iframe's own navigation free: the frame issues its own request,
// so a prefetch plus a frame is two downloads. The frame therefore mounts with
// the route and starts the one download itself, while the row is still in
// flight; the source reaches it over the bridge afterwards.
//
// The row response is held for a moment so "the shell request started first" is
// a property of the page rather than of how fast the API happened to answer.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([] as const);

const ROW_DELAY_MS = 1_500;

scenario(
  "Artifacts · a cold open downloads the shell once, before the row arrives",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const accountClient = yield* apiClient(AccountHttpApi, identity);
    const orgSlug = (yield* accountClient.account.me()).organization?.slug;

    const marker = `single-download-${randomBytes(4).toString("hex")}`;
    const saved = yield* client.artifacts.save({
      payload: {
        title: `Single download ${marker}`,
        code: `function App() { return <p data-testid="artifact-marker">${marker}</p>; }`,
      },
    });

    yield* Effect.gen(function* () {
      const detailPath = orgSlug ? `/${orgSlug}/artifacts/${saved.id}` : `/artifacts/${saved.id}`;

      yield* browser.session(identity, async ({ page, step }) => {
        const shellRequestTimes: Array<number> = [];
        let rowFinishedAt: number | null = null;

        await step(
          "Open the artifact by URL with an empty cache, row response delayed",
          async () => {
            const isRow = (url: string, resourceType: string) =>
              resourceType === "fetch" && url.includes(`/artifacts/${saved.id}`);

            await page.route(
              (url) => url.pathname.includes(`/artifacts/${saved.id}`),
              async (route) => {
                if (isRow(route.request().url(), route.request().resourceType())) {
                  await new Promise((resolve) => setTimeout(resolve, ROW_DELAY_MS));
                }
                await route.continue();
              },
            );
            page.on("request", (request) => {
              // Every request for the shell document counts, whatever started
              // it: a prefetch hint is a second download just like a second frame.
              if (/mcp-apps-shell.*\.html/.test(new URL(request.url()).pathname)) {
                shellRequestTimes.push(Date.now());
              }
            });
            page.on("requestfinished", (request) => {
              if (isRow(request.url(), request.resourceType())) rowFinishedAt = Date.now();
            });

            await page.goto(`${target.baseUrl}${detailPath}`, { waitUntil: "commit" });
            await page
              .frameLocator('[data-testid="artifact-shell-frame"]')
              .frameLocator("iframe")
              .getByTestId("artifact-marker")
              .waitFor({ timeout: 60_000 });
          },
        );

        await step("The shell document was requested once, before the row finished", async () => {
          expect(shellRequestTimes.length, "the shell document is downloaded exactly once").toBe(1);
          expect(rowFinishedAt, "the artifact row response was observed").not.toBeNull();
          expect(
            (rowFinishedAt ?? 0) - (shellRequestTimes[0] ?? 0),
            "the shell request started before the row response completed",
          ).toBeGreaterThan(0);
        });
      });
    }).pipe(
      Effect.ensuring(
        client.artifacts.remove({ params: { artifactId: saved.id } }).pipe(Effect.ignore),
      ),
    );
  }),
);
