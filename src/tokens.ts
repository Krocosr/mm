/**
 * MM — token measurement.
 *
 * The research report is emphatic, and correctly so: **token count is not
 * character count.** A BPE vocabulary is a property of a specific model, and the
 * same text can cost very different numbers of tokens in different models (and in
 * the same model across releases). Any MM claim of the form "we saved N% of the
 * tokens" is therefore meaningless unless it names the tokenizer that produced the
 * number. This module exists to make that naming structurally unavoidable:
 *
 *  - Every `measure` result carries `tokenizerId` and `approximate`. There is no
 *    field that can be filled in without also saying where the number came from.
 *  - The real BPE adapter (`TiktokenTokenizer`) reports `status: "unavailable"`
 *    with a reason when `js-tiktoken` is not installed. It never falls back to the
 *    heuristic, and the heuristic is never returned in its place.
 *  - `compare` refuses to produce a ratio for two measurements taken with
 *    different tokenizers, so a heuristic number can never be quietly divided
 *    into a real one.
 *
 * `R_token = T_candidate / T_baseline` is the report's metric. `R < 1` is a
 * saving, `R > 1` is a cost. A caller quoting an `R` has to decide what to do
 * about `approximate: true`, and the field is right there next to the ratio.
 */

// ---------------------------------------------------------------------------
// Tokenizer interface
// ---------------------------------------------------------------------------

export interface Tokenizer {
  /** Stable identifier recorded with every measurement, e.g. `tiktoken/cl100k_base`. */
  readonly id: string;
  /**
   * True when the count is an approximation rather than the output of a real
   * vocabulary. Callers must surface this; a number without it is not evidence.
   */
  readonly approximate: boolean;
  /** One line describing what produced the counts, for report provenance. */
  readonly describe: string;
  /** Number of model tokens `text` encodes to. */
  count(text: string): number;
}

/**
 * The outcome of asking for a tokenizer. Unavailability is a first-class result:
 * not an error to be swallowed, and not a licence to substitute another
 * tokenizer for the one that was asked for.
 */
export type TokenizerResult =
  | { readonly status: "ready"; readonly tokenizer: Tokenizer }
  | { readonly status: "unavailable"; readonly id: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Heuristic tokenizer
// ---------------------------------------------------------------------------

/**
 * An explicitly approximate tokenizer, for when no real vocabulary is available.
 *
 * It is NOT a BPE implementation and does not pretend to be one. It segments text
 * into word runs, whitespace runs and single punctuation characters, charging
 * each run `ceil(length / 4)` tokens, floored at one. That tracks the shape of a
 * BPE merge table closely enough to rank two texts of similar style against each
 * other, and it is nowhere near good enough to quote an absolute token count.
 *
 * Every measurement it produces is stamped `approximate: true`, and its id says
 * so in the string itself, so provenance cannot be lost downstream.
 */
export class HeuristicTokenizer implements Tokenizer {
  readonly id = "heuristic/v1";
  readonly approximate = true;
  readonly describe =
    "heuristic/v1: word/whitespace/punctuation runs charged at ceil(len/4) tokens; NOT a BPE vocabulary";

  count(text: string): number {
    let tokens = 0;
    let i = 0;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      const start = i;
      if (isWordChar(c)) {
        while (i < text.length && isWordChar(text.charCodeAt(i))) i += 1;
      } else if (isSpaceChar(c)) {
        while (i < text.length && isSpaceChar(text.charCodeAt(i))) i += 1;
      } else {
        i += 1;
        tokens += 1;
        continue;
      }
      tokens += Math.max(1, Math.ceil((i - start) / 4));
    }
    return tokens;
  }
}

function isWordChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
}

function isSpaceChar(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

// ---------------------------------------------------------------------------
// Tiktoken adapter
// ---------------------------------------------------------------------------

interface TiktokenEncoder {
  encode(text: string): number[];
}

/**
 * A real BPE tokenizer, loaded on demand from `js-tiktoken`.
 *
 * The import is dynamic and the package is optional: no model file is downloaded
 * and nothing is bundled. If the package is absent, `load` returns
 * `{ status: "unavailable", reason }` — it does not fall back to the heuristic,
 * because an unreported fallback is how a character-count result ends up
 * published as a token result.
 */
export class TiktokenTokenizer implements Tokenizer {
  readonly approximate = false;
  readonly describe: string;

  private constructor(readonly id: string, private readonly encoder: TiktokenEncoder, describe: string) {
    this.describe = describe;
  }

  count(text: string): number {
    return this.encoder.encode(text).length;
  }

  static async load(encodingName: string): Promise<TokenizerResult> {
    const id = `tiktoken/${encodingName}`;
    // A static import is impossible here: `js-tiktoken` is an optional extra
    // rather than a dependency, and importing it unconditionally would stop the
    // compiler from loading at all on a machine that does not have it. The
    // specifier is computed so the type checker does not require the package
    // either; the resolution failure below is reported, not swallowed.
    const specifier = "js-tiktoken";
    let mod: unknown;
    try {
      mod = await import(/* @vite-ignore */ specifier);
    } catch (err) {
      return {
        status: "unavailable",
        id,
        reason: `js-tiktoken is not installed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
      };
    }
    // Validate the foreign module before trusting it. The package is optional and
    // its shape is only known at run time, so this is the one place in the
    // compiler where a cast is unavoidable; each one is preceded by the check
    // that justifies it.
    const factory = (mod as { getEncoding?: unknown }).getEncoding;
    if (typeof factory !== "function") {
      return { status: "unavailable", id, reason: "js-tiktoken is installed but exports no getEncoding()" };
    }
    let encoder: unknown;
    try {
      // `getEncoding` is async in current `js-tiktoken`: calling it and not awaiting
      // yields a Promise, and every later `encode` then fails deep inside the package.
      encoder = await (factory as (name: string) => unknown)(encodingName);
    } catch (err) {
      return {
        status: "unavailable",
        id,
        reason: `js-tiktoken could not load '${encodingName}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (typeof encoder !== "object" || encoder === null || !("encode" in encoder) || typeof encoder.encode !== "function") {
      return { status: "unavailable", id, reason: `js-tiktoken returned no encoder for '${encodingName}'` };
    }
    // `encode` is called *through* the encoder, never detached: the package's method
    // reads `this.specialTokens`, so an unbound call throws rather than counting.
    const bound = encoder as { encode: (text: string) => number[] };
    return {
      status: "ready",
      tokenizer: new TiktokenTokenizer(id, { encode: (text: string) => bound.encode(text) }, `tiktoken ${encodingName} (exact BPE)`),
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Tokenizers this compiler can measure with, keyed by id. The heuristic is always
 * present; the real vocabularies resolve to whatever `js-tiktoken` can provide,
 * which may be nothing at all. A static lookup table, so a plain record.
 */
export const TOKENIZERS: Record<string, () => Promise<TokenizerResult>> = {
  "heuristic/v1": async () => ({ status: "ready", tokenizer: new HeuristicTokenizer() }),
  "tiktoken/cl100k_base": () => TiktokenTokenizer.load("cl100k_base"),
  "tiktoken/o200k_base": () => TiktokenTokenizer.load("o200k_base"),
};

/** Ids in a stable order, so a report's rows do not shuffle between runs. */
export const TOKENIZER_IDS: readonly string[] = Object.keys(TOKENIZERS).sort();

export function resolveTokenizer(id: string): Promise<TokenizerResult> {
  const load = TOKENIZERS[id];
  if (!load) {
    return Promise.resolve({ status: "unavailable", id, reason: `unknown tokenizer id '${id}'` });
  }
  return load();
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface Measurement {
  readonly tokens: number;
  /** Which tokenizer produced `tokens`. */
  readonly tokenizerId: string;
  /** True when `tokens` is an approximation. Must be surfaced to the reader. */
  readonly approximate: boolean;
  /** Character count, recorded for diagnostics only. Never a token proxy. */
  readonly chars: number;
}

export function measure(text: string, tokenizer: Tokenizer): Measurement {
  return {
    tokens: tokenizer.count(text),
    tokenizerId: tokenizer.id,
    approximate: tokenizer.approximate,
    chars: text.length,
  };
}

export interface TokenComparison {
  /** `R_token = T_candidate / T_baseline`. Null when it cannot be computed. */
  readonly ratio: number | null;
  readonly baselineTokens: number;
  readonly candidateTokens: number;
  readonly tokenizerId: string;
  /** True when either side came from an approximation. */
  readonly approximate: boolean;
  /** False when the ratio would be meaningless; `reason` says why. */
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * `R_token` — the report's ratio. Both sides must come from the same tokenizer;
 * otherwise the quotient is not a ratio of token counts at all, so this returns
 * `valid: false` with a reason instead of a number that would read like one.
 */
export function compare(baseline: Measurement, candidate: Measurement): TokenComparison {
  const shared = {
    baselineTokens: baseline.tokens,
    candidateTokens: candidate.tokens,
    tokenizerId: baseline.tokenizerId,
    approximate: baseline.approximate || candidate.approximate,
  };
  if (baseline.tokenizerId !== candidate.tokenizerId) {
    return {
      ...shared,
      ratio: null,
      valid: false,
      reason: `tokenizer mismatch: '${baseline.tokenizerId}' vs '${candidate.tokenizerId}'; a ratio between two vocabularies is not a token saving`,
    };
  }
  if (baseline.tokens <= 0) {
    return { ...shared, ratio: null, valid: false, reason: "baseline measured zero tokens, so R_token is undefined" };
  }
  return { ...shared, ratio: candidate.tokens / baseline.tokens, valid: true };
}
