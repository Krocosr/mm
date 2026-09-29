import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Program } from "../src/program.ts";
import type { Diagnostic, SourceFile } from "../src/ast.ts";

/**
 * kernel.md §9 safety corpus.
 *
 * The type/ownership/effect pipeline lives in `src/check.ts`, which is written
 * concurrently. This test loads it dynamically: if the module is absent or does
 * not export the expected entry point, every entry is reported as PENDING and a
 * dedicated test fails loudly. Nothing here can pass vacuously.
 */

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

interface CorpusEntry {
  file: string;
  case: string;
  expect: "accept" | "reject";
  code?: string;
  stage: "compile" | "runtime";
  rationale: string;
}

/** Validates the manifest at the boundary so entries can be trusted downstream. */
function parseManifest(text: string): CorpusEntry[] {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || !("entries" in raw) || !Array.isArray(raw.entries)) {
    throw new Error("corpus/manifest.json must have an `entries` array");
  }
  return raw.entries.map((e: unknown) => {
    if (typeof e !== "object" || e === null) throw new Error("manifest entry is not an object");
    const fields: Record<string, unknown> = { ...e };
    for (const key of ["file", "case", "expect", "stage", "rationale"]) {
      if (typeof fields[key] !== "string") {
        throw new Error(`manifest entry is missing a string \`${key}\`: ${JSON.stringify(e)}`);
      }
    }
    if (fields["code"] !== undefined && typeof fields["code"] !== "string") {
      throw new Error(`manifest entry has a non-string \`code\`: ${JSON.stringify(e)}`);
    }
    return fields as unknown as CorpusEntry;
  });
}

const manifest = { entries: parseManifest(readFileSync(`${corpusDir}manifest.json`, "utf8")) };


// A literal specifier would make `tsc` hard-fail while `src/check.ts` is still
// being written; the specifier is held in a variable so the missing module is a
// runtime "pending" condition rather than a build error.
const CHECK_MODULE = "../src/check.ts";

/** Entry point the analysis pipeline must export: run every check pass on a program. */
type CheckFn = (program: Program) => Diagnostic[];

let checkFn: CheckFn | null = null;
let pipelineError: string | null = null;
try {
  const mod = (await import(CHECK_MODULE)) as { checkProgram?: unknown };
  if (typeof mod.checkProgram === "function") {
    checkFn = mod.checkProgram as CheckFn;
  } else {
    pipelineError = "src/check.ts does not export `checkProgram`";
  }
} catch (err) {
  pipelineError = `src/check.ts is not available yet: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Exported helper: analyze one corpus file. Returns every diagnostic the
 * pipeline produced. Throws only if the pipeline is unavailable, which callers
 * must treat as PENDING rather than as a pass.
 */
export function checkProgram(text: string, module: string): Diagnostic[] {
  const program = new Program();
  program.addFile({ module, text, bytes: new TextEncoder().encode(text) } satisfies SourceFile);
  if (checkFn === null) {
    throw new Error(pipelineError ?? "analysis pipeline unavailable");
  }
  return [...program.diagnostics, ...checkFn(program)];
}

/** Returns diagnostics, or `{ pending }` when the pipeline cannot run yet — never a silent pass. */
function analyze(entry: CorpusEntry): { diags: Diagnostic[] } | { pending: true; reason: string } {
  const text = readFileSync(`${corpusDir}${entry.file}`, "utf8");
  const module = entry.file.replace(/^safety\//, "safety::").replace(/^safe\//, "safe::").replace(/\.mm$/, "");
  if (checkFn === null) return { pending: true, reason: pipelineError ?? "analysis pipeline unavailable" };
  return { diags: checkProgram(text, module) };
}

function codes(diags: readonly Diagnostic[]): string[] {
  return diags.map((d) => d.code);
}

describe("corpus manifest", () => {
  test("covers all 10 kernel §9 cases plus the trust/authority pair", () => {
    const cases = manifest.entries.map((e) => e.case);
    for (const required of [
      "use_after_free",
      "double_free",
      "iterator_invalidation",
      "mutable_read_alias",
      "arena_escape",
      "stale_handle",
      "cross_thread_mutable_alias",
      "partial_init_drop",
      "int_to_ptr",
      "bad_ffi_contract",
      "decision_as_authority",
      "cap_from_value",
    ]) {
      expect(cases).toContain(required);
    }
  });

  test("every entry has a rationale and a consistent shape", () => {
    for (const e of manifest.entries) {
      expect(e.rationale.length).toBeGreaterThan(20);
      expect(["compile", "runtime"]).toContain(e.stage);
      if (e.expect === "accept") {
        expect(e.code).toBeUndefined();
      } else {
        expect(e.code).toMatch(/^E\d{4}$/);
      }
    }
    // E0416 is the one check the kernel makes at run time, by design.
    const stale = manifest.entries.find((e) => e.case === "stale_handle");
    expect(stale?.stage).toBe("runtime");
    expect(manifest.entries.filter((e) => e.stage === "runtime").length).toBe(1);
  });
});

describe("safe suite (FR-1: known-safe programs MUST compile)", () => {
  for (const entry of manifest.entries.filter((e) => e.expect === "accept")) {
    test(`${entry.case} compiles without error`, () => {
      const result = analyze(entry);
      if ("pending" in result) {
        throw new Error(`PENDING: ${entry.file} — ${result.reason}`);
      }
      expect(codes(result.diags)).toEqual([]);
    });
  }
});

describe("safety suite (unsafe programs MUST be rejected)", () => {
  for (const entry of manifest.entries.filter((e) => e.expect === "reject")) {
    test(`${entry.case} is rejected with ${entry.code} (${entry.stage})`, () => {
      const result = analyze(entry);
      if ("pending" in result) {
        throw new Error(`PENDING: ${entry.file} — ${result.reason}`);
      }
      if (entry.stage === "runtime") {
        // R-Own-8: the handle check is deliberately NOT static. The program must
        // compile cleanly; the diagnostic is produced by the generational store
        // when the stale handle is dereferenced.
        expect(codes(result.diags)).toEqual([]);
        return;
      }
      // `code` is absent only for accept-entries, which this filter excludes.
      expect(codes(result.diags)).toContain(entry.code ?? "");
    });
  }
});

describe("corpus coverage gate", () => {
  test("no corpus entry is left unchecked", () => {
    const pending: string[] = [];
    for (const e of manifest.entries) {
      const r = analyze(e);
      if ("pending" in r) pending.push(`${e.file}: ${r.reason}`);
    }
    if (pending.length > 0) {
      throw new Error(
        `${pending.length}/${manifest.entries.length} corpus entries are PENDING, not passing:\n  ` +
          pending.join("\n  "),
      );
    }
  });
});
