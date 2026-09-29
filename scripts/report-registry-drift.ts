#!/usr/bin/env bun
/**
 * Print the drift between the prelude's builtin table and the checker's `methodType`.
 *
 * Two directions, and both are defects:
 *   - the prelude implements a method the checker rejects  -> a correct program is
 *     refused at compile time (E0203), a false rejection;
 *   - the checker types a method the prelude does not implement -> a program typechecks
 *     and then fails at run time, which is worse because nothing caught it.
 *
 * Run with `bun run scripts/report-registry-drift.ts`.
 */
import { BUILTIN_NAMES } from "../src/interp/prelude.ts";
import { BodyChecker } from "../src/typeexpr.ts";
import { Checker } from "../src/scope.ts";
import { Program } from "../src/program.ts";
import { BUILTIN, type Ty } from "../src/types.ts";

const RECEIVERS: { prefix: string; ty: Ty }[] = [
  { prefix: "slice", ty: { k: "slice", elem: { k: "prim", name: "u8" } } },
  { prefix: "array", ty: { k: "array", elem: { k: "prim", name: "u8" }, len: 0 } },
  { prefix: "text", ty: { k: "named", def: BUILTIN.Text_, args: [] } },
  { prefix: "bytes", ty: { k: "named", def: BUILTIN.Bytes_, args: [] } },
  { prefix: "map", ty: { k: "named", def: BUILTIN.Map, args: [{ k: "prim", name: "u8" }, { k: "prim", name: "u8" }] } },
  { prefix: "set", ty: { k: "named", def: BUILTIN.Set, args: [{ k: "prim", name: "u8" }] } },
];

const NO_SPAN = { start: 0, end: 0, file: -1 } as const;
const program = new Program();
program.addFile({ module: "drift_probe", text: "", bytes: new TextEncoder().encode("") });
const body = new BodyChecker(new Checker(program));

// Every method name the checker might answer for a receiver, discovered by probing the
// whole prelude vocabulary plus the names the language documents. Probing a fixed list
// cannot prove absence in general; it pins the ones we know about.
/**
 * Methods the prelude provides *for a receiver*, by `<tag>_<name>` key.
 *
 * Deliberately not counting bare builtins. `evalMethod` does fall back to a bare
 * `<name>`, so `s.min()` would dispatch at run time — but `min` is a free function, not
 * a method on `Text`, and treating that fallback as an implementation turns every
 * builtin into a method on every type, which makes the question meaningless. The
 * fallback is an untyped escape hatch, and the checker being stricter than it is the
 * safe direction to be wrong in.
 */
function implementedFor(prefix: string): string[] {
  return BUILTIN_NAMES.filter((n) => n.startsWith(`${prefix}_`)).map((n) => n.slice(prefix.length + 1));
}

const CANDIDATES = new Set<string>([
  ...BUILTIN_NAMES.flatMap((n) => n.split("_").slice(1)),
  "len", "is_empty", "get", "set", "insert", "remove", "contains", "keys", "values",
  "new", "push", "pop", "clone", "to_upper", "to_lower", "trim", "split", "concat",
  "starts_with", "ends_with", "as_bytes", "bytes", "chars", "slice", "to_hex", "eq",
  "is_some", "is_none", "unwrap", "unwrap_or", "take", "map", "is_ok", "is_err", "ok", "err", "map_err",
  // The rest of the names `methodType` switches on. Without these the report silently
  // undercounts phantoms, which is the more dangerous direction: an unprobed method
  // reads as agreement nobody actually checked.
  "first", "last", "clear", "iter", "reverse", "sort",
  // Multi-word builtin keys do not survive the split above: `map_get_opt` contributes
  // "get" and "opt", never "get_opt", so a method with an underscore in its name is
  // invisible to the probe unless it is named here.
  "get_opt",
]);

let falseRejections = 0;
let phantomMethods = 0;

for (const { prefix, ty } of RECEIVERS) {
  const implemented = implementedFor(prefix);
  const known = [...CANDIDATES].filter((m) => body.methodType(ty, m, NO_SPAN) !== null);

  const missing = implemented.filter((m) => !known.includes(m));
  const phantom = known.filter((m) => !implemented.includes(m));

  falseRejections += missing.length;
  phantomMethods += phantom.length;

  console.log(`\n${prefix}:`);
  console.log(`  implemented by the prelude (${implemented.length}): ${implemented.join(", ")}`);
  console.log(`  known to the checker      (${known.length}): ${known.join(", ")}`);
  if (missing.length > 0) {
    console.log(`  FALSE REJECTION — implemented but rejected by the checker (${missing.length}): ${missing.join(", ")}`);
  }
  if (phantom.length > 0) {
    console.log(`  PHANTOM — typed by the checker but not implemented (${phantom.length}): ${phantom.join(", ")}`);
  }
}

console.log(`\ntotals: ${falseRejections} methods the runtime implements that the checker rejects,`);
console.log(`        ${phantomMethods} methods the checker accepts that the runtime does not implement.`);
