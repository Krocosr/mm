import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Program } from "../src/program.ts";
import type { SourceFile } from "../src/ast.ts";

const examplesDir = new URL("../examples", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const EXPECTED_EXAMPLES = 30;

interface ExampleDiagnostic {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly line: number;
}

interface LoadedExample {
  readonly name: string;
  readonly module: string;
  readonly lines: number;
  readonly tests: readonly string[];
  readonly diagnostics: readonly ExampleDiagnostic[];
}

/** Load one example as its own module, so a name shared by two files cannot hide an error. */
function loadExample(program: Program, name: string): LoadedExample {
  const text = readFileSync(join(examplesDir, name), "utf8");
  const module = name.replace(/\.mm$/, "");
  const before = program.diagnostics.length;
  const unit = program.addFile({ module, text, bytes: new TextEncoder().encode(text) } satisfies SourceFile);
  const diagnostics = program.diagnostics.slice(before).map((d) => ({
    code: d.code,
    kind: d.kind,
    message: d.message,
    line: text.slice(0, d.span.start).split("\n").length,
  }));
  return {
    name,
    module,
    lines: text.split("\n").length,
    tests: unit.tests.map((t) => t.name),
    diagnostics,
  };
}

function loadAll(): LoadedExample[] {
  const program = new Program();
  const names = readdirSync(examplesDir).filter((n) => n.endsWith(".mm")).sort();
  return names.map((name) => loadExample(program, name));
}

function sourceOf(name: string): string {
  return readFileSync(join(examplesDir, name), "utf8");
}

const examples = loadAll();

describe("example corpus", () => {
  test("holds exactly thirty example programs", () => {
    expect(examples.length).toBe(EXPECTED_EXAMPLES);
  });

  test("every example parses with zero diagnostics", () => {
    const failures = examples
      .filter((e) => e.diagnostics.length > 0)
      .map((e) => `${e.name}: ${e.diagnostics.map((d) => `${d.code} ${d.kind} at line ${d.line}: ${d.message}`).join("; ")}`);
    expect(failures).toEqual([]);
  });

  test("every example declares at least one test item", () => {
    expect(examples.filter((e) => e.tests.length === 0).map((e) => e.name)).toEqual([]);
  });

  test("every example is a small program of its own module", () => {
    for (const e of examples) {
      expect(e.module).toBe(e.name.replace(/\.mm$/, ""));
      expect(e.lines).toBeGreaterThanOrEqual(15);
      expect(e.lines).toBeLessThanOrEqual(140);
    }
  });

  test("files that share a definition name still load clean", () => {
    // bubble_sort and quicksort both define `is_sorted`; a shared module would
    // report E0202, so the clean load above already proves the modules are distinct.
    expect(sourceOf("bubble_sort.mm")).toContain("fn is_sorted");
    expect(sourceOf("quicksort.mm")).toContain("fn is_sorted");
  });
});

describe("construct coverage", () => {
  const COVERAGE: readonly (readonly [string, readonly string[]])[] = [
    ["integers", ["fib_iterative.mm", "checksum_crc32.mm"]],
    ["floats", ["matrix_mul.mm", "routing_intent.mm"]],
    ["bytes", ["hash_fnv1a.mm", "base64.mm", "tiny_vm.mm"]],
    ["text", ["csv_parse.mm", "word_count.mm", "caesar_cipher.mm"]],
    ["maps", ["graph_traverse.mm", "word_count.mm"]],
    ["records", ["merge_intervals.mm", "arena_alloc.mm"]],
    ["unions", ["json_parser.mm", "state_machine.mm", "event_sourcing.mm"]],
    ["choices", ["state_machine.mm", "routing_intent.mm"]],
    ["generics", ["bubble_sort.mm", "quicksort.mm"]],
    ["recursion", ["linked_list.mm", "quicksort.mm"]],
    ["view and view mut", ["bubble_sort.mm", "sieve.mm", "binary_search.mm"]],
    ["shared", ["shared_graph.mm"]],
    ["arena", ["arena_alloc.mm"]],
    ["handle", ["handle_store.mm", "btree_minimal.mm"]],
    ["@resource", ["resource_file.mm"]],
    ["@wire", ["json_parser.mm", "event_sourcing.mm"]],
    ["@intent and Decision", ["routing_intent.mm"]],
  ];

  test("every construct in the matrix is exercised by a named example", () => {
    const names = examples.map((e) => e.name);
    for (const [, files] of COVERAGE) {
      for (const file of files) expect(names).toContain(file);
    }
  });

  test("ownership wrappers and attributes appear in the sources that claim them", () => {
    expect(sourceOf("bubble_sort.mm")).toContain("view mut [T]");
    expect(sourceOf("shared_graph.mm")).toContain("shared Node");
    expect(sourceOf("arena_alloc.mm")).toContain("arena Arena");
    expect(sourceOf("handle_store.mm")).toContain("handle Entry");
    expect(sourceOf("resource_file.mm")).toContain("@resource(close = fs.close)");
    expect(sourceOf("json_parser.mm")).toContain("@wire");
    expect(sourceOf("event_sourcing.mm")).toContain("@wire");
    expect(sourceOf("routing_intent.mm")).toContain("@intent");
    expect(sourceOf("routing_intent.mm")).toContain("Decision<Route>");
    expect(sourceOf("routing_intent.mm")).toContain("choice {");
  });

  test("effect rows are declared on exactly the effectful examples", () => {
    const effectful = examples.filter((e) => sourceOf(e.name).includes("!{")).map((e) => e.name).sort();
    expect(effectful).toEqual(["json_parser.mm", "resource_file.mm", "routing_intent.mm"]);
  });

  test("the README documents every example", () => {
    const readme = readFileSync(join(examplesDir, "README.md"), "utf8");
    for (const e of examples) expect(readme).toContain(`\`${e.name}\``);
  });
});
