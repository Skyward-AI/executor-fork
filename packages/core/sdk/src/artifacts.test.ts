import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { createExecutor } from "./executor";
import { makeTestExecutor, makeTestWorkspaceHarness } from "./testing";
import type { ArtifactBinding } from "./artifact";
import { ConnectionName, IntegrationSlug, Subject, Tenant } from "./ids";

const binding = (integration: string, owner: "user" | "org", name: string): ArtifactBinding => ({
  integration: IntegrationSlug.make(integration),
  owner,
  connection: ConnectionName.make(name),
});

// The `executor.artifacts` surface against the real SQLite test db. Artifacts
// are owner-scoped rows with no plugin involvement, so the default test
// executor (one tenant + one bound subject) is the whole fixture.

const CODE = "export default function App() { return <div>hi</div>; }";

describe("executor.artifacts", () => {
  it.effect("list is empty when nothing is saved", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      expect(yield* executor.artifacts.list()).toEqual([]);
    }),
  );

  it.effect("save mints an id and stores the source", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Active users",
        description: "Daily active users over time",
        code: CODE,
      });
      expect(saved.id).not.toBe("");
      expect(saved.owner).toBe("org");
      expect(saved.title).toBe("Active users");
      expect(saved.description).toBe("Daily active users over time");
      expect(saved.code).toBe(CODE);

      const fetched = yield* executor.artifacts.get(saved.id);
      expect(fetched).toEqual(saved);
    }),
  );

  it.effect("round-trips connection bindings through the json column", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const bindings = {
        vercel: binding("vercel", "user", "personalVercel"),
        prod: binding("linear", "org", "linearProd"),
      };
      const saved = yield* executor.artifacts.save({ title: "Domains", code: CODE, bindings });
      expect(saved.bindings).toEqual(bindings);
      expect((yield* executor.artifacts.get(saved.id)).bindings).toEqual(bindings);
    }),
  );

  it.effect("saves an artifact that binds nothing as bound-but-empty, not unbound", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Static", code: CODE, bindings: {} });
      // `{}` and `null` are different facts: `{}` is an artifact that calls no
      // integration, `null` is one written before bindings existed and whose
      // code still carries full addresses.
      expect(saved.bindings).toEqual({});
      expect((yield* executor.artifacts.get(saved.id)).bindings).toEqual({});
    }),
  );

  it.effect("leaves bindings null when a save omits them", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Legacy", code: CODE });
      expect(saved.bindings).toBe(null);
    }),
  );

  it.effect("overwrites bindings along with the source", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Domains",
        code: CODE,
        bindings: { vercel: binding("vercel", "user", "old") },
      });
      const updated = yield* executor.artifacts.save({
        id: saved.id,
        title: "Domains",
        code: CODE,
        bindings: { vercel: binding("vercel", "user", "new") },
      });
      expect(updated.bindings).toEqual({ vercel: binding("vercel", "user", "new") });
      expect((yield* executor.artifacts.get(saved.id)).bindings).toEqual({
        vercel: binding("vercel", "user", "new"),
      });
    }),
  );

  it.effect("save defaults a missing description to null", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Untitled", code: CODE });
      expect(saved.description).toBe(null);
    }),
  );

  it.effect("list omits the source", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Active users",
        description: "described",
        code: CODE,
      });

      const listed = yield* executor.artifacts.list();
      // The list projection is deliberately code-free: a saved component can be
      // large and a picker only needs title/description to match on. The
      // preview is the one exception — the gallery is the surface that draws
      // it — and it is null here because this save supplied none.
      expect(listed).toEqual([
        {
          id: saved.id,
          owner: "org",
          title: "Active users",
          description: "described",
          preview: null,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        },
      ]);
    }),
  );

  // `it.live` (real clock) with a full-second gap: `dateColumn` lands in SQLite
  // as a SECOND-resolution integer, so two artifacts saved inside one second
  // carry the same `updated_at` and only the id tiebreak separates them. This
  // pins the ordering the picker actually depends on, at the resolution the
  // storage layer really has.
  it.live("list returns the most recently updated artifact first", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const first = yield* executor.artifacts.save({ title: "First", code: CODE });
      yield* Effect.sleep("1100 millis");
      const second = yield* executor.artifacts.save({ title: "Second", code: CODE });
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

      expect((yield* executor.artifacts.list()).map((a) => a.id)).toEqual([second.id, first.id]);

      // Touching the OLDER artifact floats it back to the top — the list is
      // keyed on `updated_at`, not on creation order.
      yield* Effect.sleep("1100 millis");
      yield* executor.artifacts.rename({ id: first.id, title: "First, touched" });
      expect((yield* executor.artifacts.list()).map((a) => a.id)).toEqual([first.id, second.id]);
    }),
  );

  it.effect("save with an id overwrites in place", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Draft", code: CODE });
      const updated = yield* executor.artifacts.save({
        id: saved.id,
        title: "Final",
        description: "now described",
        code: "export default function App() { return null; }",
      });

      expect(updated.id).toBe(saved.id);
      expect(updated.title).toBe("Final");
      expect(updated.description).toBe("now described");
      expect(updated.code).toBe("export default function App() { return null; }");
      expect(updated.createdAt.getTime()).toBe(saved.createdAt.getTime());

      // Overwrite, not append: still exactly one row.
      const listed = yield* executor.artifacts.list();
      expect(listed.map((a) => a.id)).toEqual([saved.id]);
    }),
  );

  it.effect("save fails for an id that names no visible artifact", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* Effect.result(
        executor.artifacts.save({ id: "art_missing", title: "Ghost", code: CODE }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("get fails for an unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* Effect.result(executor.artifacts.get("art_missing"));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("rename changes only the title", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Old name",
        description: "kept",
        code: CODE,
      });
      const renamed = yield* executor.artifacts.rename({ id: saved.id, title: "New name" });
      expect(renamed.title).toBe("New name");
      expect(renamed.description).toBe("kept");
      expect(renamed.code).toBe(CODE);
    }),
  );

  it.effect("rename fails for an unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* Effect.result(
        executor.artifacts.rename({ id: "art_missing", title: "Nope" }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("remove hard-deletes the artifact", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Temp", code: CODE });
      yield* executor.artifacts.remove({ id: saved.id });

      expect(yield* executor.artifacts.list()).toEqual([]);
      const result = yield* Effect.result(executor.artifacts.get(saved.id));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("remove is idempotent", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.artifacts.remove({ id: "art_missing" });
    }),
  );

  it.effect("an executor with no subject can save an artifact", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ subject: null });
      const saved = yield* executor.artifacts.save({ title: "Shared", code: CODE });
      expect(saved.owner).toBe("org");
      expect((yield* executor.artifacts.list()).map((a) => a.title)).toEqual(["Shared"]);
    }),
  );

  it.effect("another member of the tenant can open, rename and delete a saved artifact", () =>
    Effect.gen(function* () {
      const { config, executor: alice } = yield* makeTestWorkspaceHarness();
      const bob = yield* createExecutor({
        ...config,
        subject: Subject.make("bob"),
        db: withQueryContext(config.testDb.db, { tenant: String(config.tenant), subject: "bob" }),
      });
      yield* Effect.addFinalizer(() => bob.close().pipe(Effect.ignore));

      const saved = yield* alice.artifacts.save({ title: "Revenue", code: CODE });

      expect(yield* bob.artifacts.list()).toEqual([]);
      expect((yield* bob.artifacts.get(saved.id)).code).toBe(CODE);

      yield* bob.artifacts.rename({ id: saved.id, title: "Revenue by month" });
      expect((yield* alice.artifacts.get(saved.id)).title).toBe("Revenue by month");

      yield* bob.artifacts.remove({ id: saved.id });
      expect(yield* alice.artifacts.list()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("another tenant cannot see a saved artifact", () =>
    Effect.gen(function* () {
      const { config, executor: alice } = yield* makeTestWorkspaceHarness();
      const outsider = yield* createExecutor({
        ...config,
        tenant: Tenant.make("other-tenant"),
        subject: Subject.make("mallory"),
        db: withQueryContext(config.testDb.db, { tenant: "other-tenant", subject: "mallory" }),
      });
      yield* Effect.addFinalizer(() => outsider.close().pipe(Effect.ignore));

      yield* alice.artifacts.save({ title: "Revenue", code: CODE });

      expect(yield* outsider.artifacts.list()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  describe("sharing", () => {
    const makeMember = (
      config: Parameters<typeof createExecutor>[0] & {
        readonly testDb: { readonly db: Parameters<typeof withQueryContext>[0] };
      },
      name: string,
    ) =>
      Effect.gen(function* () {
        const member = yield* createExecutor({
          ...config,
          subject: Subject.make(name),
          db: withQueryContext(config.testDb.db, { tenant: String(config.tenant), subject: name }),
        });
        yield* Effect.addFinalizer(() => member.close().pipe(Effect.ignore));
        return member;
      });

    // Insert a row straight through the storage layer, bypassing `save`, so a
    // test can pin the tier and creator that `save` would never produce.
    const insertRow = (
      config: { readonly testDb: { readonly db: Parameters<typeof withQueryContext>[0] } },
      context: { readonly tenant: string; readonly subject: string },
      row: {
        readonly id: string;
        readonly owner: "org" | "user";
        readonly subject: string;
        readonly createdBy: string | null;
        readonly preview?: string | null;
      },
    ) =>
      Effect.promise(() =>
        withQueryContext(config.testDb.db, context).create("artifact", {
          tenant: context.tenant,
          owner: row.owner,
          subject: row.subject,
          id: row.id,
          title: "Legacy",
          description: null,
          code: CODE,
          bindings: null,
          preview: row.preview ?? null,
          preview_capture: null,
          compiled_fingerprint: null,
          compiled_js: null,
          compiled_css: null,
          created_by: row.createdBy,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

    it.effect("lists only the artifacts the member created, yet others can still open them", () =>
      Effect.gen(function* () {
        const { config, executor: alice } = yield* makeTestWorkspaceHarness();
        const bob = yield* makeMember(config, "bob");

        const saved = yield* alice.artifacts.save({ title: "Revenue", code: CODE });

        expect((yield* alice.artifacts.list()).map((a) => a.id)).toEqual([saved.id]);
        expect(yield* bob.artifacts.list()).toEqual([]);
        expect((yield* bob.artifacts.get(saved.id)).code).toBe(CODE);
      }).pipe(Effect.scoped),
    );

    it.effect("lists an org artifact with no recorded creator for every member", () =>
      Effect.gen(function* () {
        const { config, executor: alice } = yield* makeTestWorkspaceHarness();
        const bob = yield* makeMember(config, "bob");
        yield* insertRow(
          config,
          { tenant: String(config.tenant), subject: "bob" },
          { id: "art_legacy", owner: "org", subject: "", createdBy: null },
        );

        expect((yield* alice.artifacts.list()).map((a) => a.id)).toEqual(["art_legacy"]);
        expect((yield* bob.artifacts.list()).map((a) => a.id)).toEqual(["art_legacy"]);
      }).pipe(Effect.scoped),
    );

    it.effect("an executor with no subject lists every org artifact", () =>
      Effect.gen(function* () {
        const { config, executor: alice } = yield* makeTestWorkspaceHarness();
        const orgOnly = yield* createExecutor({
          ...config,
          subject: undefined,
          db: withQueryContext(config.testDb.db, {
            tenant: String(config.tenant),
            subject: null,
          }),
        });
        yield* Effect.addFinalizer(() => orgOnly.close().pipe(Effect.ignore));

        const saved = yield* alice.artifacts.save({ title: "Revenue", code: CODE });

        expect((yield* orgOnly.artifacts.list()).map((a) => a.id)).toEqual([saved.id]);
      }).pipe(Effect.scoped),
    );

    it.effect("sharing a personal artifact makes it openable by others but not listed", () =>
      Effect.gen(function* () {
        const { config, executor: alice } = yield* makeTestWorkspaceHarness();
        const bob = yield* makeMember(config, "bob");
        yield* insertRow(
          config,
          { tenant: String(config.tenant), subject: "test-subject" },
          { id: "art_mine", owner: "user", subject: "test-subject", createdBy: null },
        );

        const before = yield* Effect.result(bob.artifacts.get("art_mine"));
        expect(
          Result.isFailure(before) && Predicate.isTagged("ArtifactNotFoundError")(before.failure),
        ).toBe(true);
        expect((yield* alice.artifacts.get("art_mine")).owner).toBe("user");

        const shared = yield* alice.artifacts.share({ id: "art_mine" });

        expect(shared.owner).toBe("org");
        expect((yield* bob.artifacts.get("art_mine")).owner).toBe("org");
        expect((yield* bob.artifacts.list()).map((a) => a.id)).toEqual([]);
        expect((yield* alice.artifacts.list()).map((a) => a.id)).toEqual(["art_mine"]);
      }).pipe(Effect.scoped),
    );

    it.effect("another member cannot share a personal artifact", () =>
      Effect.gen(function* () {
        const { config, executor: alice } = yield* makeTestWorkspaceHarness();
        const bob = yield* makeMember(config, "bob");
        yield* insertRow(
          config,
          { tenant: String(config.tenant), subject: "test-subject" },
          { id: "art_mine", owner: "user", subject: "test-subject", createdBy: null },
        );

        const result = yield* Effect.result(bob.artifacts.share({ id: "art_mine" }));

        expect(
          Result.isFailure(result) && Predicate.isTagged("ArtifactNotFoundError")(result.failure),
        ).toBe(true);
        expect((yield* alice.artifacts.get("art_mine")).owner).toBe("user");
        expect((yield* alice.artifacts.list()).map((a) => a.id)).toEqual(["art_mine"]);
      }).pipe(Effect.scoped),
    );

    it.effect("sharing an artifact that is already org-tier fails", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({ title: "Revenue", code: CODE });

        const result = yield* Effect.result(executor.artifacts.share({ id: saved.id }));

        expect(
          Result.isFailure(result) && Predicate.isTagged("ArtifactNotFoundError")(result.failure),
        ).toBe(true);
      }),
    );

    it.effect("overwriting another member's artifact does not change who lists it", () =>
      Effect.gen(function* () {
        const { config, executor: alice } = yield* makeTestWorkspaceHarness();
        const bob = yield* makeMember(config, "bob");
        const saved = yield* alice.artifacts.save({ title: "Revenue", code: CODE });

        yield* bob.artifacts.save({ id: saved.id, title: "Revenue v2", code: CODE });
        yield* bob.artifacts.rename({ id: saved.id, title: "Revenue v3" });

        expect((yield* alice.artifacts.list()).map((a) => a.title)).toEqual(["Revenue v3"]);
        expect(yield* bob.artifacts.list()).toEqual([]);
      }).pipe(Effect.scoped),
    );

    describe("capture privacy", () => {
      const LAYOUT = '<div class="p-4"><h2>Revenue</h2></div>';
      const LAYOUT_V2 = '<div class="p-4"><h2>Revenue v2</h2></div>';
      const CAPTURE = '<div class="p-4"><h2>Revenue</h2><p>12,480 active</p></div>';
      const BOB_CAPTURE = '<div class="p-4"><h2>Revenue</h2><p>3 active</p></div>';
      const IMAGE = "data:image/png;base64,AAAA";
      const markup = (value: string) => ({ kind: "layout", markup: value });

      it.effect("the creator sees their capture while another member keeps the layout", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          const bob = yield* makeMember(config, "bob");
          const saved = yield* alice.artifacts.save({
            title: "Revenue",
            code: CODE,
            preview: LAYOUT,
          });

          const result = yield* alice.artifacts.setPreview({ id: saved.id, preview: CAPTURE });

          expect(result).toEqual({ stored: true });
          expect((yield* alice.artifacts.get(saved.id)).preview).toEqual(markup(CAPTURE));
          expect((yield* bob.artifacts.get(saved.id)).preview).toEqual(markup(LAYOUT));
        }).pipe(Effect.scoped),
      );

      it.effect("another member's capture is not stored and changes nobody's preview", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          const bob = yield* makeMember(config, "bob");
          const saved = yield* alice.artifacts.save({
            title: "Revenue",
            code: CODE,
            preview: LAYOUT,
          });

          const result = yield* bob.artifacts.setPreview({ id: saved.id, preview: BOB_CAPTURE });

          expect(result).toEqual({ stored: false });
          expect((yield* alice.artifacts.get(saved.id)).preview).toEqual(markup(LAYOUT));
          expect((yield* bob.artifacts.get(saved.id)).preview).toEqual(markup(LAYOUT));
        }).pipe(Effect.scoped),
      );

      it.effect("a capture on an org artifact with no recorded creator is not stored", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          const bob = yield* makeMember(config, "bob");
          yield* insertRow(
            config,
            { tenant: String(config.tenant), subject: "bob" },
            { id: "art_legacy", owner: "org", subject: "", createdBy: null, preview: LAYOUT },
          );

          expect(yield* alice.artifacts.setPreview({ id: "art_legacy", preview: CAPTURE })).toEqual(
            { stored: false },
          );
          expect(yield* bob.artifacts.setPreview({ id: "art_legacy", preview: CAPTURE })).toEqual({
            stored: false,
          });
          expect((yield* alice.artifacts.get("art_legacy")).preview).toEqual(markup(LAYOUT));
        }).pipe(Effect.scoped),
      );

      it.effect("the owner of a personal artifact stores and sees their capture", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          yield* insertRow(
            config,
            { tenant: String(config.tenant), subject: "test-subject" },
            {
              id: "art_mine",
              owner: "user",
              subject: "test-subject",
              createdBy: null,
              preview: LAYOUT,
            },
          );

          const result = yield* alice.artifacts.setPreview({ id: "art_mine", preview: CAPTURE });

          expect(result).toEqual({ stored: true });
          expect((yield* alice.artifacts.get("art_mine")).preview).toEqual(markup(CAPTURE));
        }).pipe(Effect.scoped),
      );

      it.effect("sharing a personal artifact keeps the owner's capture", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          const bob = yield* makeMember(config, "bob");
          yield* insertRow(
            config,
            { tenant: String(config.tenant), subject: "test-subject" },
            {
              id: "art_mine",
              owner: "user",
              subject: "test-subject",
              createdBy: null,
              preview: LAYOUT,
            },
          );
          yield* alice.artifacts.setPreview({ id: "art_mine", preview: CAPTURE });

          yield* alice.artifacts.share({ id: "art_mine" });

          expect((yield* alice.artifacts.get("art_mine")).preview).toEqual(markup(CAPTURE));
          expect((yield* bob.artifacts.get("art_mine")).preview).toEqual(markup(LAYOUT));
        }).pipe(Effect.scoped),
      );

      it.effect("an overwrite clears the capture and falls back to the new layout", () =>
        Effect.gen(function* () {
          const { executor: alice } = yield* makeTestWorkspaceHarness();
          const saved = yield* alice.artifacts.save({
            title: "Revenue",
            code: CODE,
            preview: LAYOUT,
          });
          yield* alice.artifacts.setPreview({ id: saved.id, preview: CAPTURE });

          yield* alice.artifacts.save({
            id: saved.id,
            title: "Revenue",
            code: CODE,
            preview: LAYOUT_V2,
          });

          expect((yield* alice.artifacts.get(saved.id)).preview).toEqual(markup(LAYOUT_V2));
        }).pipe(Effect.scoped),
      );

      it.effect("an image snapshot left in the layout column is shown to its creator only", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          const bob = yield* makeMember(config, "bob");
          const saved = yield* alice.artifacts.save({
            title: "Revenue",
            code: CODE,
            preview: IMAGE,
          });

          expect((yield* alice.artifacts.get(saved.id)).preview).toEqual(markup(IMAGE));
          expect((yield* bob.artifacts.get(saved.id)).preview).toBe(null);
        }).pipe(Effect.scoped),
      );

      it.effect("lists the creator's capture, and hides an image from non-creators", () =>
        Effect.gen(function* () {
          const { config, executor: alice } = yield* makeTestWorkspaceHarness();
          const bob = yield* makeMember(config, "bob");
          const saved = yield* alice.artifacts.save({
            title: "Revenue",
            code: CODE,
            preview: LAYOUT,
          });
          yield* alice.artifacts.setPreview({ id: saved.id, preview: CAPTURE });
          yield* insertRow(
            config,
            { tenant: String(config.tenant), subject: "bob" },
            { id: "art_legacy", owner: "org", subject: "", createdBy: null, preview: IMAGE },
          );

          const aliceList = yield* alice.artifacts.list();
          const bobList = yield* bob.artifacts.list();

          expect(aliceList.find((a) => a.id === saved.id)?.preview).toEqual(markup(CAPTURE));
          expect(bobList.map((a) => a.id)).toEqual(["art_legacy"]);
          expect(bobList[0]?.preview).toBe(null);
        }).pipe(Effect.scoped),
      );
    });
  });

  describe("previews", () => {
    const MARKUP = '<div class="p-4"><h2>Revenue</h2></div>';
    const SETTLED = '<div class="p-4"><h2>Revenue</h2><p>12,480 active</p></div>';

    it.effect("round-trips layout markup, and reads it back as a layout preview", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({
          title: "Revenue",
          code: CODE,
          preview: MARKUP,
        });
        expect(saved.preview).toEqual({ kind: "layout", markup: MARKUP });
        // The gallery reads it from the LIST, so that is the projection that
        // has to carry it.
        expect((yield* executor.artifacts.list())[0]?.preview).toEqual({
          kind: "layout",
          markup: MARKUP,
        });
      }),
    );

    it.effect("leaves the preview null when a save omits one", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({ title: "Plain", code: CODE });
        expect(saved.preview).toBe(null);
      }),
    );

    it.effect("overwrites the preview along with the source", () =>
      Effect.gen(function* () {
        // The preview interprets `code`, so a save that replaces the source
        // must replace the picture — including back to null. Carrying it
        // forward would advertise a version of the artifact that is gone.
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({
          title: "Revenue",
          code: CODE,
          preview: MARKUP,
        });
        const updated = yield* executor.artifacts.save({
          id: saved.id,
          title: "Revenue",
          code: CODE,
        });
        expect(updated.preview).toBe(null);
        expect((yield* executor.artifacts.get(saved.id)).preview).toBe(null);
      }),
    );

    it.effect("setPreview upgrades the preview to the settled render", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({
          title: "Revenue",
          code: CODE,
          preview: MARKUP,
        });
        yield* executor.artifacts.setPreview({ id: saved.id, preview: SETTLED });
        expect((yield* executor.artifacts.get(saved.id)).preview).toEqual({
          kind: "layout",
          markup: SETTLED,
        });
      }),
    );

    it.effect("setPreview does not reorder the gallery", () =>
      Effect.gen(function* () {
        // `updated_at` is the gallery's sort key. Opening an artifact must not
        // move it to the front — being looked at is not an edit.
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({ title: "Revenue", code: CODE });
        yield* executor.artifacts.setPreview({ id: saved.id, preview: SETTLED });
        expect((yield* executor.artifacts.get(saved.id)).updatedAt).toEqual(saved.updatedAt);
      }),
    );

    it.effect("setPreview fails for an artifact that is not visible", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const result = yield* Effect.result(
          executor.artifacts.setPreview({ id: "art_missing", preview: SETTLED }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
      }),
    );
  });
});
