import { describe, expect, test } from "bun:test";
import {
  HeuristicTokenizer, TOKENIZER_IDS, compare, measure, resolveTokenizer,
  type Measurement, type Tokenizer,
} from "../src/tokens.ts";

/** A tokenizer with known counts, so the `R_token` arithmetic can be checked exactly. */
function fixed(id: string, approximate: boolean, counts: Readonly<Record<string, number>>): Tokenizer {
  return {
    id,
    approximate,
    describe: `fixed/${id}`,
    count: (text) => {
      const known = counts[text];
      if (known === undefined) throw new Error(`fixed tokenizer has no count for ${JSON.stringify(text)}`);
      return known;
    },
  };
}

const exact = fixed("test/exact", false, { baseline: 400, candidate: 100, empty: 0 });

describe("measure", () => {
  test("records where the count came from, not just the count", () => {
    const m = measure("candidate", exact);
    expect(m).toEqual({ tokens: 100, tokenizerId: "test/exact", approximate: false, chars: 9 });
  });

  test("marks a heuristic count as approximate and names the heuristic", () => {
    const m = measure("fn f() {}", new HeuristicTokenizer());
    expect(m.approximate).toBe(true);
    expect(m.tokenizerId).toBe("heuristic/v1");
    expect(m.tokenizerId).not.toBe(m.approximate.toString());
  });

  test("is deterministic", () => {
    const tk = new HeuristicTokenizer();
    expect(measure("fn f() { 1 }", tk)).toEqual(measure("fn f() { 1 }", tk));
  });
});

describe("compare", () => {
  test("computes R_token = T_candidate / T_baseline", () => {
    const r = compare(measure("baseline", exact), measure("candidate", exact));
    expect(r.valid).toBe(true);
    expect(r.ratio).toBeCloseTo(0.25, 12);
    expect(r.baselineTokens).toBe(400);
    expect(r.candidateTokens).toBe(100);
    expect(r.approximate).toBe(false);
  });

  test("reports R_token = 1 for a condition measured against itself", () => {
    const m = measure("baseline", exact);
    expect(compare(m, m).ratio).toBe(1);
  });

  test("reports R_token > 1 when the candidate costs more", () => {
    const r = compare(measure("candidate", exact), measure("baseline", exact));
    expect(r.ratio).toBeCloseTo(4, 12);
  });

  test("propagates the approximation flag to the ratio", () => {
    const approx = fixed("test/approx", true, { a: 10, b: 5 });
    const r = compare(measure("a", approx), measure("b", approx));
    expect(r.valid).toBe(true);
    expect(r.ratio).toBeCloseTo(0.5, 12);
    expect(r.approximate).toBe(true);
  });

  test("refuses to divide two different vocabularies", () => {
    const r = compare(measure("baseline", exact), measure("candidate", new HeuristicTokenizer()));
    expect(r.valid).toBe(false);
    expect(r.ratio).toBeNull();
    expect(r.reason).toContain("test/exact");
    expect(r.reason).toContain("heuristic/v1");
  });

  test("refuses a ratio against an empty baseline", () => {
    const r = compare(measure("empty", exact), measure("candidate", exact));
    expect(r.valid).toBe(false);
    expect(r.ratio).toBeNull();
    expect(r.reason).toContain("zero tokens");
  });
});

describe("tokenizer adapters", () => {
  test("an id that does not exist is unavailable, not a fallback", async () => {
    const result = await resolveTokenizer("nope/v9");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.id).toBe("nope/v9");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("a tiktoken adapter either loads or says why — it never substitutes the heuristic", async () => {
    for (const id of ["tiktoken/cl100k_base", "tiktoken/o200k_base"]) {
      const result = await resolveTokenizer(id);
      if (result.status === "unavailable") {
        expect(result.id).toBe(id);
        expect(result.reason.length).toBeGreaterThan(0);
        continue;
      }
      // Available: it must be the exact vocabulary that was asked for, and a
      // measurement through it must not be flagged approximate.
      expect(result.tokenizer.id).toBe(id);
      expect(result.tokenizer.approximate).toBe(false);
      expect(measure("fn f() {}", result.tokenizer).approximate).toBe(false);
    }
  });

  test("the heuristic is always available and always says it is approximate", async () => {
    const result = await resolveTokenizer("heuristic/v1");
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.tokenizer.approximate).toBe(true);
      expect(result.tokenizer.describe).toContain("NOT a BPE vocabulary");
    }
  });

  test("every registered id resolves, and the registry is stable", async () => {
    expect([...TOKENIZER_IDS]).toEqual([...TOKENIZER_IDS].sort());
    for (const id of TOKENIZER_IDS) {
      const result = await resolveTokenizer(id);
      expect(["ready", "unavailable"]).toContain(result.status);
    }
  });
});

describe("an approximate result is distinguishable from an exact one", () => {
  test("the same text can produce different verdicts, and both are labelled", () => {
    const text = "fn classify(v: i32) -> bool { v > 0 }";
    const approx: Measurement = measure(text, new HeuristicTokenizer());
    const exactish: Measurement = { ...approx, tokenizerId: "tiktoken/cl100k_base", approximate: false };
    expect(approx.approximate).toBe(true);
    expect(exactish.approximate).toBe(false);
    // Same count, different provenance: the flag is what tells them apart, and it
    // is part of the record rather than a property of the caller.
    expect(exactish.tokens).toBe(approx.tokens);
    expect(compare(approx, exactish).valid).toBe(false);
  });

  test("a character count is never presented as a token count", () => {
    const text = "fn f() { 1 }";
    const m = measure(text, new HeuristicTokenizer());
    expect(m.chars).toBe(text.length);
    // The approximation is not the character count, and it is not claimed to be.
    expect(m.approximate).toBe(true);
    expect(new HeuristicTokenizer().count(text)).toBeGreaterThan(0);
  });
});
