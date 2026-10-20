// ---------------------------------------------------------------------------
// Artifacts — saved generative-UI components. Row → public projection plus the
// operation inputs; the executor stitches these into `executor.artifacts` and
// the core `artifacts` HTTP group.
//
// An artifact IS the stored JSX source plus the title/description an agent
// matches against ("show me my active users dashboard"). Owner-scoped like a
// connection, and created at the `org` tier so every member of the tenant can
// read it through the same owner policy.
// ---------------------------------------------------------------------------

import { Option, Schema, type Effect } from "effect";

import type { ArtifactFullRow, ArtifactRow, ArtifactSummaryRow } from "./core-schema";
import { isArtifactPreviewImage } from "./artifact-preview";
import { ArtifactId, ConnectionName, IntegrationSlug, Owner } from "./ids";

/**
 * Which connection one integration role in the artifact's code resolves to.
 *
 * Artifact source names an integration and, when it needs two accounts of one,
 * a role — `tools.linear("prod").issues.list`. The three address segments that
 * were taken OUT of the source live here, so the host can put them back at
 * invoke time. Storing the tier and connection NAME (rather than a connection
 * row id) keeps this a pure address projection: it re-resolves against whoever
 * is viewing, which is what makes rebinding a shared artifact possible later.
 */
export const ArtifactBinding = Schema.Struct({
  integration: IntegrationSlug,
  owner: Owner,
  connection: ConnectionName,
}).annotate({
  description:
    "The connection one integration role in an artifact's code resolves to, as the three address segments the source omits.",
});
export type ArtifactBinding = typeof ArtifactBinding.Type;

/** `role -> connection` for every integration role the artifact's code uses. */
export const ArtifactBindings = Schema.Record(Schema.String, ArtifactBinding).annotate({
  description:
    "Every integration role an artifact's code uses, mapped to the connection it runs as.",
});
export type ArtifactBindings = typeof ArtifactBindings.Type;

const decodeBindings = Schema.decodeUnknownOption(ArtifactBindings);
const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/**
 * The stored column, as bindings.
 *
 * JSON arrives as an object on Postgres and as a string on SQLite, and is
 * absent entirely on rows written before bindings existed. Absent is `null`,
 * which is meaningful: it is what marks an artifact as pre-contract and lets
 * its old five-segment paths run as written.
 *
 * A column that is present but undecodable is therefore NOT null — it becomes
 * an empty binding set, so every role in the artifact fails closed with
 * `binding_unresolved` instead of falling through the pre-contract door. Only
 * this host writes the column, so the case means corruption; failing visibly
 * on the artifact is the honest outcome.
 */
const bindingsFromColumn = (value: unknown): ArtifactBindings | null => {
  if (value === null || value === undefined) return null;
  const json = typeof value === "string" ? decodeJsonString(value) : Option.some(value);
  return Option.flatMap(json, decodeBindings).pipe(Option.getOrElse(() => ({})));
};

/**
 * What the gallery draws for an artifact, when it has anything to draw.
 *
 * Always sanitized markup, produced at one of two moments:
 *
 *   - at CREATE, from the smoke render — the artifact's real composition in its
 *     LOADING state (frames, tables, skeletons), containing no data at all
 *     because nothing was fetched;
 *   - at OPEN, from the settled render in a viewer's browser — the same
 *     composition with real numbers, rows and labels in it.
 *
 * Pixels were the intent for the second one and are not achievable: the render
 * frame is sandboxed into an opaque origin, so every image it can build taints
 * a canvas and `toDataURL` throws. See `captureSettledHtml` in the shell's
 * inner renderer for the measurement. Markup keeps what the upgrade was FOR —
 * a card that shows the artifact's real content — and gives up only the
 * typeface and pixel-exact fidelity.
 *
 * The two are one type because the console renders them identically. They are
 * NOT interchangeable for sharing, which is why the source is recorded: see the
 * data-safety note on `Artifact.preview`.
 */
export type ArtifactPreview = {
  readonly kind: "layout";
  readonly markup: string;
};

/**
 * Read the stored column as a preview.
 *
 * Absent, empty, or anything that is not a string is `null`, and the caller
 * falls back to the schematic. Anything else is markup this host sanitized
 * before storing — nothing else writes the column.
 */
export const previewFromColumn = (value: unknown): ArtifactPreview | null =>
  typeof value === "string" && value !== "" ? { kind: "layout", markup: value } : null;

export interface Artifact {
  readonly id: ArtifactId;
  readonly owner: Owner;
  readonly title: string;
  /** Model-supplied prose used for agent matching. Null when none was given. */
  readonly description: string | null;
  /** The JSX source. Only the full read carries it — lists stay light. */
  readonly code: string;
  /**
   * Which connection each integration role in `code` runs as.
   *
   * `null` means the artifact predates the binding contract: its source still
   * carries full `tools.<integration>.<tier>.<connection>.<tool>` addresses and
   * executes them as written. Every artifact saved since is bound, even if the
   * binding set is empty (code that calls no integration).
   */
  readonly bindings: ArtifactBindings | null;
  /**
   * What the gallery draws for this artifact, or `null` to fall back to the
   * schematic.
   *
   * DATA SAFETY. The create-time layout preview is derived from `code` alone
   * and is shared with every member. A settled capture holds its capturer's
   * data, so it is stored apart and only its creator is shown it; everyone else
   * gets the layout preview.
   */
  readonly preview: ArtifactPreview | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The result of precompiling an artifact's source, as stored on its row.
 *
 * `fingerprint` names the compiler that produced it; output whose fingerprint
 * differs from the host's current one is stale and is recomputed on the next
 * render read. `js` is the JSX transformed to plain JS and `css` the Tailwind
 * CSS for the classes the source uses. Each is `null` when the compiler could
 * not produce it, and the renderer then does that step itself: no `js` means
 * the frame compiles the source, no `css` means the frame runs Tailwind.
 */
export interface ArtifactCompiledOutput {
  readonly fingerprint: string;
  readonly js: string | null;
  readonly css: string | null;
}

/**
 * A host-supplied precompiler for artifact source (`ExecutorConfig.artifactCompiler`).
 *
 * Optional: a host without one stores no compiled output and every render
 * compiles in the frame, exactly as before. It must not fail; a failure is
 * logged and the artifact is saved without compiled output.
 */
export interface ArtifactCompiler {
  readonly fingerprint: string;
  readonly compile: (code: string) => Effect.Effect<ArtifactCompiledOutput>;
}

/** An artifact plus its precompiled output, for the renderer. `null` when no
 *  compiler is configured on this host. */
export interface ArtifactForRender extends Artifact {
  readonly compiled: ArtifactCompiledOutput | null;
}

/** The compiled output stored on a row, or `null` when it was never compiled. */
export const compiledFromRow = (
  row: Pick<ArtifactRow, "compiled_fingerprint" | "compiled_js" | "compiled_css">,
): ArtifactCompiledOutput | null =>
  typeof row.compiled_fingerprint === "string"
    ? {
        fingerprint: row.compiled_fingerprint,
        js: row.compiled_js ?? null,
        css: row.compiled_css ?? null,
      }
    : null;

/** What a list returns: everything except the source and the bindings that
 *  interpret it. Both are only meaningful to a renderer, and both are heavy.
 *  The preview stays, because the list is what draws it. */
export type ArtifactSummary = Omit<Artifact, "code" | "bindings">;

/** Create a new artifact, or overwrite an existing one in place when `id` names
 *  one. v1 has no version history: a save replaces the stored source. */
export interface SaveArtifactInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string | null;
  readonly code: string;
  /**
   * The connections `code`'s integration roles resolve to. Written on every
   * save, since code and bindings are one fact: replacing the source without
   * its bindings would leave the artifact interpreting new roles through old
   * connections.
   */
  readonly bindings?: ArtifactBindings | null;
  /**
   * The layout preview for this source, already sanitized.
   *
   * Written on every save for the same reason as `bindings`: it is an
   * interpretation of `code`, so carrying the old one forward under new source
   * would show the gallery an artifact that no longer exists. Omitted or
   * `null` clears it — including when a save supersedes an image preview,
   * which is correct, since that image is of the previous version.
   */
  readonly preview?: string | null;
}

export interface RenameArtifactInput {
  readonly id: string;
  readonly title: string;
}

export interface ShareArtifactInput {
  readonly id: string;
}

export interface RemoveArtifactInput {
  readonly id: string;
}

/**
 * Upgrade an artifact's preview to a raster snapshot of a settled render.
 *
 * Separate from `SaveArtifactInput` because it is a different act by a
 * different party: a save is the MODEL replacing the source, this is a VIEWER
 * reporting what the artifact actually looked like. It touches no other column
 * and deliberately does not move `updated_at` — being looked at is not an edit,
 * and the gallery sorts by that timestamp.
 */
export interface SetArtifactPreviewInput {
  readonly id: string;
  /** A `data:image/...` URL. Rejected by the handler if it is anything else. */
  readonly preview: string;
}

const asDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value);

/**
 * The preview this viewer may see. The creator gets their settled capture, else
 * the layout preview. Anyone else gets the layout preview only, and nothing
 * when that column holds an image snapshot written before captures were stored
 * apart.
 */
const previewForViewer = (
  row: Pick<ArtifactSummaryRow, "owner" | "created_by" | "preview" | "preview_capture">,
  viewer: string | null,
): ArtifactPreview | null => {
  if (isArtifactCreator(row, viewer)) {
    return previewFromColumn(row.preview_capture) ?? previewFromColumn(row.preview);
  }
  return typeof row.preview === "string" && isArtifactPreviewImage(row.preview)
    ? null
    : previewFromColumn(row.preview);
};

/** Whether `viewer` created the row: any personal row the policy let them
 *  read, or an org row recorded against their subject. */
export const isArtifactCreator = (
  row: Pick<ArtifactSummaryRow, "owner" | "created_by">,
  viewer: string | null,
): boolean => row.owner === "user" || (viewer !== null && row.created_by === viewer);

export const rowToArtifactSummary = (
  row: ArtifactSummaryRow,
  viewer: string | null,
): ArtifactSummary => ({
  id: ArtifactId.make(row.id),
  owner: row.owner as Owner,
  title: row.title,
  description: row.description ?? null,
  preview: previewForViewer(row, viewer),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

export const rowToArtifact = (row: ArtifactFullRow, viewer: string | null): Artifact => ({
  ...rowToArtifactSummary(row, viewer),
  code: row.code,
  bindings: bindingsFromColumn(row.bindings),
});
