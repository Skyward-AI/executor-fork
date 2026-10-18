/**
 * Candidate class names for the server-side Tailwind build.
 *
 * The in-frame compiler observes the DOM; the server only has the source text.
 * So this scans the source for anything that could be a utility and lets
 * `build()` drop the rest: emitting too many candidates is harmless (invalid
 * ones are discarded, valid words found in prose create rules that match
 * nothing), emitting too few leaves an element unstyled.
 */

const SPLIT_QUOTES = /["'`]/;
const WHITESPACE = /\s/;
const PIECE_SEPARATORS = /[{}()<>=;,!]+/;
const EDGE_PUNCTUATION = /^[^\w[\-!@*]+|[^\w\])%]+$/g;

/**
 * Split on whitespace and quotes outside `[...]`; inside brackets keep quotes,
 * `=`, `>`, `,` and parentheses so arbitrary values and variants survive, and
 * end the token at whitespace.
 */
export function extractCandidates(code: string): ReadonlyArray<string> {
  const out = new Set<string>();
  let current = "";
  let depth = 0;

  const flush = () => {
    if (current.length > 0) {
      out.add(current);
      for (const piece of current.split(PIECE_SEPARATORS)) {
        if (piece.length > 0) out.add(piece);
      }
      const trimmed = current.replace(EDGE_PUNCTUATION, "");
      if (trimmed.length > 0) out.add(trimmed);
    }
    current = "";
  };

  for (const ch of code) {
    if (ch === "[") depth++;
    if (ch === "]" && depth > 0) depth--;
    if (depth === 0 && (WHITESPACE.test(ch) || SPLIT_QUOTES.test(ch))) {
      flush();
      continue;
    }
    if (depth > 0 && WHITESPACE.test(ch)) {
      depth = 0;
      flush();
      continue;
    }
    current += ch;
  }
  flush();

  return [...out];
}

// `${` glued to a token end, or `}` glued to a token start, inside a template.
const TEMPLATE_INTERPOLATION_AFTER_TOKEN = /[-:[/]\$\{/;
const TEMPLATE_INTERPOLATION_BEFORE_TOKEN = /\}[-:[/]/;
// "bg-" + tone, tone + "-500".
const CONCAT_AFTER_TOKEN = /(["'])[^"'\n]*[-:]\1\s*\+/;
const CONCAT_BEFORE_TOKEN = /\+\s*(["'])-/;

/**
 * Whether the code appears to build class names from pieces. The extractor
 * cannot see those classes, so such an artifact keeps the runtime compiler.
 * Conservative: a false positive only costs the runtime path.
 */
export function hasDynamicClassConstruction(code: string): boolean {
  const segments = code.split("`");
  for (let i = 1; i < segments.length; i += 2) {
    const segment = segments[i] ?? "";
    if (
      TEMPLATE_INTERPOLATION_AFTER_TOKEN.test(segment) ||
      TEMPLATE_INTERPOLATION_BEFORE_TOKEN.test(segment)
    ) {
      return true;
    }
  }
  return CONCAT_AFTER_TOKEN.test(code) || CONCAT_BEFORE_TOKEN.test(code);
}
