/**
 * MM — the analysis pipeline.
 *
 * One entry point, `checkProgram`, runs the passes in the order their inputs require and
 * stops early only where a later pass would be reading garbage. The order is load-bearing:
 *
 *   resolve/declarations → types (bodies) → effects → ownership → system IR → graph
 *
 * Each pass annotates the `Program` in place, so the semantic graph can answer a query
 * without re-running anything, and `mm.check` on an unchanged package is a cache hit.
 *
 * See docs/spec/kernel.md §4 (effect order), §5 (Type→System), §7 (graph).
 */

import type { Diagnostic, SourceFile } from "./ast.ts";
import { Program } from "./program.ts";
import { Checker, checkDeclarations } from "./scope.ts";
import { BodyChecker, type ExprFacts } from "./typeexpr.ts";
import { checkEffects } from "./effects.ts";
import { checkOwnership } from "./ownership.ts";
import { lowerToSystem, type SystemPlan, verifySystem } from "./system.ts";
import { buildGraph, type SemanticGraph } from "./graph.ts";

export interface CheckResult {
  program: Program;
  graph: SemanticGraph;
  /** The System Plan, derived from the program's `@`-attributes and effect rows. */
  system: SystemPlan | null;
  errors: Diagnostic[];
}

export interface PassResult {
  program: Program;
  system: SystemPlan | null;
  errors: Diagnostic[];
}

/** Load a set of sources into a program. Module identity comes from the file name. */
export function loadProgram(sources: ReadonlyArray<{ module: string; text: string }>): Program {
  const program = new Program();
  for (const s of sources) {
    const file: SourceFile = {
      module: s.module,
      text: s.text,
      bytes: new TextEncoder().encode(s.text),
    };
    program.addFile(file);
  }
  return program;
}

/**
 * Run every pass. Returns the annotated program; never throws for user error.
 *
 * A pass that cannot run because an earlier pass failed is skipped and its absence is
 * recorded as an internal diagnostic, so a broken program yields one clear error rather
 * than a cascade of consequences of the first one.
 */
/**
 * Run the analysis passes over an already-loaded program and return the diagnostics they
 * produced. This is the entry point the harness and the corpus suite use.
 *
 * Passes run in the order their inputs require:
 *
 *   resolve/declarations → types (bodies) → effects → ownership → Type→System
 *
 * A pass whose input is already broken is skipped rather than run against `<error>`, so a
 * single mistake yields one clear diagnostic instead of a cascade of consequences.
 */
export function checkProgram(program: Program): Diagnostic[] {
  const before = program.diagnostics.length;
  runPasses(program);
  return program.diagnostics.slice(before);
}

/** The full pipeline, minus the semantic graph, annotating `program` in place. */
function runPasses(program: Program): { system: SystemPlan | null } {
  const checker = new Checker(program);

  // 1. Declarations. Lexer/parser diagnostics are already in `program.diagnostics`.
  checkDeclarations(checker);

  // 2. Function bodies. Skipped when signature resolution already failed, because every
  //    body check would then compare against `<error>` and report noise.
  const facts: ExprFacts = { types: new Map(), calls: new Map(), constructions: new Map(), views: new Map() };
  const signatureFailed = program.diagnostics.some(
    (d) => d.severity === "error" && d.code.startsWith("E02"),
  );
  let bodyChecker: BodyChecker | null = null;
  if (!signatureFailed) {
    bodyChecker = new BodyChecker(checker);
    bodyChecker.checkAllFns();
    for (const [k, v] of bodyChecker.facts.types) facts.types.set(k, v);
    for (const [k, v] of bodyChecker.facts.calls) facts.calls.set(k, v);
    for (const [k, v] of bodyChecker.facts.constructions) facts.constructions.set(k, v);
    for (const [k, v] of bodyChecker.facts.views) facts.views.set(k, v);
    // Publish resolved types so ownership and System IR read the same answer the type
    // pass reached, rather than re-deriving one that could disagree.
    for (const [k, v] of facts.types) checker.facts.set(k, v);
    for (const [k, v] of facts.calls) checker.calls.set(k, v);
  }

  // 3. Effects. Needs signatures and call edges, both now available.
  checkEffects(checker, facts);

  // 4. Ownership. Needs resolved types and the view/call facts.
  checkOwnership(checker, bodyChecker);

  // 5. Type→System and its invariants.
  const system = lowerToSystem(checker);
  verifySystem(checker, system);
  return { system };
}

/**
 * Load sources, run every pass, and build the semantic graph.
 *
 * This is what tooling and the harness use: the graph is the agent-facing projection of
 * everything the passes just established.
 */
export function analyze(sources: ReadonlyArray<{ module: string; text: string }>): CheckResult {
  const program = loadProgram(sources);
  const { system } = runPasses(program);
  return { program, graph: buildGraph(program), system, errors: program.errors() };
}

/**
 * The analysis passes alone, without the graph.
 *
 * Judging a program's correctness does not require building the tool-facing projection,
 * so this is the cheaper entry point and the one the corpus suite uses.
 */
export function analyzePasses(sources: ReadonlyArray<{ module: string; text: string }>): PassResult {
  const program = loadProgram(sources);
  const { system } = runPasses(program);
  return { program, system, errors: program.errors() };
}
