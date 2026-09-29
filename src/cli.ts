#!/usr/bin/env bun
/**
 * MM — the command line.
 *
 * Every subcommand is a thin wrapper over the query layer. The CLI deliberately owns no
 * logic of its own: if `mm symbol` and the daemon's `mm.symbol` ever disagreed, the
 * agent would get two different answers to the same question, which is the failure mode
 * this whole design exists to prevent.
 *
 * Usage: `mm <command> [args]`
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { buildGraph } from "./graph.ts";
import { runFn, runTest } from "./interp/interp.ts";
import { renderPacket } from "./packet.ts";
import { lowerToSystem, verifySystem } from "./system.ts";
import { Checker, checkDeclarations } from "./scope.ts";
import { BodyChecker } from "./typeexpr.ts";
import { checkEffects } from "./effects.ts";
import { checkOwnership } from "./ownership.ts";
import { Program } from "./program.ts";
import { makeSession, type Session, dispatch, querySystem } from "./query.ts";
import type { SourceFile } from "./ast.ts";

const USAGE = `mm — the agent-first systems language

USAGE
  mm check <file.mm|dir>            Parse and check. Exit 1 on any error.
  mm run <file.mm> [fn] [--tests]   Run a function (default: the test items).
  mm symbol <ref> <file.mm|dir>     One symbol, with its effect row and call edges.
  mm refs <ref> <file.mm|dir>       Everything that depends on a symbol.
  mm type <ref> <file.mm|dir>       The resolved type of a symbol.
  mm slice <file.mm|dir> --goal=…   A dependency-closed context for a bounded task.
  mm packet <file.mm|dir>           A module as a semantic packet.
  mm system <file.mm|dir>           The System Plan and requested authority.
  mm explain <file.mm|dir>          Diagnostics in canonical machine form.
  mm verify <file.mm|dir>           Check the System Plan invariants.
  mm graph <file.mm|dir>            Content-hash identities for every definition.

A <ref> is a symbol id: \`module::name\`, or a trailing \`::name\` when unambiguous.
`;

/** Load every `.mm` file under a path into a checked program. */
export function loadPath(target: string): Program {
  const program = new Program();
  for (const file of collectSources(target)) {
    const text = readFileSync(file.path, "utf8");
    const source: SourceFile = {
      module: file.module,
      text,
      bytes: new TextEncoder().encode(text),
    };
    program.addFile(source);
  }
  // The same pass order the daemon uses, so a CLI answer and a daemon answer agree.
  const checker = new Checker(program);
  checkDeclarations(checker);
  const facts = { types: new Map(), calls: new Map(), constructions: new Map(), views: new Map() };
  const bodyChecker = new BodyChecker(checker);
  bodyChecker.checkAllFns();
  for (const [k, v] of bodyChecker.facts.types) facts.types.set(k, v);
  for (const [k, v] of bodyChecker.facts.calls) facts.calls.set(k, v);
  for (const [k, v] of bodyChecker.facts.constructions) facts.constructions.set(k, v);
  for (const [k, v] of bodyChecker.facts.views) facts.views.set(k, v);
  for (const [k, v] of facts.types) checker.facts.set(k, v);
  for (const [k, v] of facts.calls) checker.calls.set(k, v);
  checkEffects(checker, facts);
  checkOwnership(checker, bodyChecker);
  const system = lowerToSystem(checker);
  verifySystem(checker, system);
  (program as Program & { systemPlan?: unknown }).systemPlan = system;
  return program;
}

interface SourceFileRef { path: string; module: string }

/**
 * Directories that are never project sources.
 *
 * Matched on the directory *name*, not the path, so the rule is the same however the
 * tree is rooted. Hidden directories are skipped wholesale: a dot-prefixed directory is
 * by convention tooling state or version-control data, and `.harness/runs/` in
 * particular is gitignored, which made the semantic graph's contents -- and therefore
 * its content-hash-derived node ids -- depend on whether a local experiment had been run.
 */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true, scratch: true, dist: true, build: true,
  target: true, ".cache": true, coverage: true,
};

function collectSources(target: string): SourceFileRef[] {
  const out: SourceFileRef[] = [];
  const walk = (p: string, root: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) {
      const name = basename(p);
      if (p !== root && (name.startsWith(".") || SKIP_DIRS[name] === true)) return;
      for (const entry of readdirSync(p).sort()) walk(join(p, entry), root);
      return;
    }
    if (!p.endsWith(".mm")) return;
    const rel = relative(root, p).replace(/\.mm$/, "");
    out.push({ path: p, module: rel.split(sep).join("::") });
  };
  const st = statSync(target);
  walk(target, st.isDirectory() ? target : join(target, ".."));
  return out;
}

function sessionFor(target: string): Session {
  const program = loadPath(target);
  const system = (program as Program & { systemPlan?: Session["system"] }).systemPlan ?? null;
  return makeSession(program, buildGraph(program), system);
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function fail(message: string): never {
  console.error(`mm: ${message}`);
  process.exit(1);
}

/** Colour-free diagnostic rendering: the machine form, with the human sentence beneath. */
function renderDiagnostics(session: Session): string {
  const lines: string[] = [];
  for (const d of session.diagnostics) {
    const file = session.program.files[d.span.file];
    const line = file ? file.text.slice(0, d.span.start).split("\n").length : 0;
    const where = file ? `${file.module}:${line}` : "<input>";
    lines.push(`${d.severity === "error" ? "error" : "warn "} ${d.code} ${where}: ${d.message}`);
    if (d.repairs && d.repairs.length > 0) {
      lines.push(`        repairs: ${d.repairs.map((r) => r.op).join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const a of rest) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else flags.set(a.slice(2), "true");
      continue;
    }
    positional.push(a);
  }
  const target = positional[positional.length - 1] ?? ".";
  const ref = positional.length >= 2 ? positional[0]! : "";

  switch (command) {
    case "check": {
      const session = sessionFor(target);
      const errors = session.diagnostics.filter((d) => d.severity === "error");
      const text = renderDiagnostics(session);
      if (text) console.log(text);
      if (errors.length > 0) {
        console.error(`mm: ${errors.length} error${errors.length === 1 ? "" : "s"}`);
        return 1;
      }
      console.log("ok");
      return 0;
    }
    case "run": {
      const program = loadPath(target);
      const wantTests = flags.get("tests") === "true" || positional.length === 1;
      if (wantTests) {
        let failed = 0;
        for (const test of program.tests.values()) {
          const r = runTest(program, test.id, {});
          const name = `${test.module}::${test.name}`;
          if (r.ok && r.diagnostics.filter((d) => d.severity === "error").length === 0) {
            console.log(`ok   ${name}`);
          } else {
            failed += 1;
            console.log(`FAIL ${name}`);
            for (const d of r.diagnostics) console.log(`       ${d.code} ${d.message}`);
          }
        }
        if (program.tests.size === 0) {
          console.log("no tests");
          return 0;
        }
        return failed === 0 ? 0 : 1;
      }
      const fnName = positional[0]!;
      const info = program.allFns().find((f) => f.name === fnName);
      if (!info) fail(`no function named \`${fnName}\``);
      const r = runFn(program, info.id, [], {});
      for (const d of r.diagnostics) console.log(`${d.code} ${d.message}`);
      print(r.value);
      return r.ok ? 0 : 1;
    }
    case "symbol":
    case "refs":
    case "type": {
      const s = sessionFor(target);
      const r = dispatch(s, `mm.${command}`, { ref });
      print(r);
      return r.ok ? 0 : 1;
    }
    case "slice": {
      const s = sessionFor(target);
      const include = (flags.get("include") ?? "definitions,affected_calls").split(",");
      const r = dispatch(s, "mm.slice", {
        goal: flags.get("goal") ?? "inspect the package",
        include,
        budgetTokens: Number(flags.get("budget") ?? 4000),
      });
      print(r);
      return r.ok ? 0 : 1;
    }
    case "packet": {
      const s = sessionFor(target);
      const nodes = s.graph.byKind("fn").map((n) => n.hash);
      print(renderPacket(s.graph, { nodes }));
      return 0;
    }
    case "system": {
      const s = sessionFor(target);
      print(querySystem(s));
      return 0;
    }
    case "explain": {
      const s = sessionFor(target);
      print(dispatch(s, "mm.diagnostics", {}));
      return 0;
    }
    case "verify": {
      const s = sessionFor(target);
      const hashes = s.graph.byKind("fn").map((n) => n.hash);
      const r = dispatch(s, "mm.verify", { hashes });
      print(r);
      return r.ok ? 0 : 1;
    }
    case "graph": {
      const s = sessionFor(target);
      print([...s.graph.nodes.values()].map((n) => ({
        hash: n.hash, id: n.sourceId, kind: n.kind, deps: n.deps.length,
      })));
      return 0;
    }
    default:
      console.error(`mm: unknown command \`${command}\`\n`);
      console.log(USAGE);
      return 2;
  }
}

// `import.meta.main` is true only when this file is the process entry point, so the CLI
// stays importable from tests without running on import.
if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

