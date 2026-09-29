/**
 * MM — effect checking.
 *
 * Effects are a set lattice ordered by inclusion only (kernel.md §4.3). There are no
 * effect *qualifiers* in v0.1: `fs.read ⊆ fs.write` is deliberately absent, because
 * qualifiers make the lattice non-monotone and produce exactly the permission-escalation
 * confusion the report warns about.
 *
 * Two rules give the report's "effects can turn into annotation noise" mitigation:
 *   - inside a module, a function's effect set is *inferred* from its body;
 *   - at a `pub` boundary it *must* be written (E0501), so the capability surface a
 *     module exposes is explicit even though ordinary code stays short.
 *
 * Inference is a least fixed point over the call graph: a function's effects are the union
 * of the effects of everything it calls, transitively. A recursive cycle is resolved by
 * seeding the strongly-connected component with the effects its members already declare,
 * which terminates because the component is finite.
 *
 * See docs/spec/kernel.md §4.
 */

import type { Block, Expr, Span, Stmt } from "./ast.ts";
import type { Ty } from "./types.ts";
import type { Checker } from "./scope.ts";
import { factKey, type ExprFacts } from "./typeexpr.ts";
import { builtinFnById } from "./builtins.ts";
import type { FnInfo } from "./program.ts";

/** Builtin effect vocabulary (kernel.md §4). */
export const BUILTIN_EFFECTS: Record<string, true> = {
  "fs.read": true,
  "fs.write": true,
  "fs.close": true,
  net: true,
  "net.tls": true,
  proc: true,
  "proc.exec": true,
  "os.vm": true,
  agent: true,
  nondet: true,
  unsafe: true,
  clock: true,
  random: true,
  env: true,
  "secret.read": true,
};

/** Effects that request host-granted authority, versus purely local safety. */
export const AUTHORITY_EFFECTS: Record<string, true> = {
  net: true,
  "net.tls": true,
  proc: true,
  "proc.exec": true,
  "fs.read": true,
  "fs.write": true,
  "fs.close": true,
  "secret.read": true,
  "os.vm": true,
  agent: true,
};

export function isSubset(inner: ReadonlySet<string>, outer: ReadonlySet<string>): boolean {
  for (const e of inner) if (!outer.has(e)) return false;
  return true;
}

/** Effects implied by attributes on an item (kernel.md A-6). */
export function attributeEffects(attrs: readonly string[]): string[] {
  if (attrs.includes("intent")) return ["agent", "nondet"];
  return [];
}

export function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

/** Direct callees of each function, from the type pass's recorded call edges. */
function buildCallGraph(
  program: import("./program.ts").Program,
  facts: ExprFacts,
): Map<number, Set<number>> {
  const graph = new Map<number, Set<number>>();
  for (const info of program.allFns()) graph.set(info.id, new Set());
  for (const unit of program.units) {
    for (const fn of unit.fns) {
      const callees = graph.get(fn.id);
      if (!callees) continue;
      for (const call of collectCalls(fn.body)) {
        const rec = facts.calls.get(factKey(call.span));
        if (rec) callees.add(rec.callee);
      }
    }
  }
  return graph;
}

/** Every call expression in a body, including nested blocks and closures. */
function collectCalls(node: Block | Stmt | Expr): Expr[] {
  const out: Expr[] = [];
  const visitExpr = (e: Expr): void => {
    if (e.kind === "call" || e.kind === "method") {
      out.push(e);
      if (e.kind === "call") visitExpr(e.callee);
      else visitExpr(e.base);
      e.args.forEach(visitExpr);
      return;
    }
    switch (e.kind) {
      case "field": visitExpr(e.base); return;
      case "index": visitExpr(e.base); visitExpr(e.index); return;
      case "unary": case "try": case "move": case "view": case "tohandle":
        visitExpr(e.operand); return;
      case "is": visitExpr(e.base); return;
      case "cast": visitExpr(e.operand); return;
      case "binary": visitExpr(e.lhs); visitExpr(e.rhs); return;
      case "assign": visitExpr(e.target); visitExpr(e.value); return;
      case "struct": e.fields.forEach((f) => visitExpr(f.value)); return;
      case "array": case "tuple": e.elems.forEach(visitExpr); return;
      case "block": visitBlock(e.block); return;
      case "if":
        visitExpr(e.cond);
        visitBlock(e.then);
        // `Block` has no `kind`, so the union discriminates structurally, not nominally.
        if (e.else_) { if ("kind" in e.else_) visitExpr(e.else_); else visitBlock(e.else_); }
        return;
      case "match":
        visitExpr(e.scrutinee);
        e.arms.forEach((a) => visitExpr(a.body));
        return;
      case "while": visitExpr(e.cond); visitBlock(e.body); return;
      case "loop": visitBlock(e.body); return;
      case "for": visitExpr(e.iter); visitBlock(e.body); return;
      case "return": if (e.value) visitExpr(e.value); return;
      case "break": if (e.value) visitExpr(e.value); return;
      case "unsafe": case "consteval": visitBlock(e.body); return;
      case "spawn": visitBlock(e.body); return;
      default: return;
    }
  };
  const visitBlock = (b: Block): void => {
    b.stmts.forEach(visitStmt);
    if (b.tail) visitExpr(b.tail);
  };
  const visitStmt = (s: Stmt): void => {
    if (s.kind === "let") { if (s.init) visitExpr(s.init); return; }
    if (s.kind === "assign") { visitExpr(s.target); visitExpr(s.value); return; }
    if (s.kind === "expr") { visitExpr(s.expr); return; }
  };
  // `Block` is identified structurally; statement kinds are disjoint from expression
  // kinds, so the remaining branch is unambiguously an `Expr`.
  if ("stmts" in node) visitBlock(node);
  else if (node.kind === "let" || node.kind === "item" || node.kind === "assign" || node.kind === "expr") {
    visitStmt(node);
  } else visitExpr(node);
  return out;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Compute every function's effect set, then validate declarations against the result.
 *
 * `facts` comes from the type pass; without it a call's target is unknown and nothing can
 * be inferred, so the caller must run the type pass first.
 */
export function checkEffects(c: Checker, facts: ExprFacts): void {
  const program = c.program;
  const graph = buildCallGraph(program, facts);

  // Seed: a declared row is a claim, an attribute is a requirement, both are facts about
  // the function independent of its body.
  const effects = new Map<number, Set<string>>();
  for (const info of program.allFns()) {
    const set = new Set<string>(info.declaredEffects ?? []);
    for (const e of attributeEffects(info.attrs)) set.add(e);
    effects.set(info.id, set);
  }

  // Least fixed point: repeat until nothing grows. Bounded by the number of distinct
  // effect names, so it terminates even with recursion.
  for (let round = 0; round < 64; round++) {
    let changed = false;
    for (const info of program.allFns()) {
      const mine = effects.get(info.id)!;
      const before = mine.size;
      for (const call of collectCalls(info.fn.body)) {
        const rec = facts.calls.get(factKey(call.span));
        if (!rec) continue;
        if (rec.callee === info.id) continue;
        const builtin = builtinFnById(rec.callee);
        if (builtin) {
          for (const e of builtin.effects) mine.add(e);
          continue;
        }
        for (const e of effects.get(rec.callee) ?? []) mine.add(e);
      }
      // An `unsafe` fn spends the `unsafe` power it declared; a call into one from safe
      // code is the ownership pass's concern, not the effect pass's.
      if (info.unsafety && info.unsafety.length > 0 && info.module !== "<builtin>") mine.add("unsafe");
      if (mine.size !== before) changed = true;
    }
    if (!changed) break;
  }

  for (const info of program.allFns()) {
    info.effects = sortedUnique([...(effects.get(info.id) ?? [])]);
  }

  // -- validation ----------------------------------------------------------

  for (const info of program.allFns()) {
    if (info.declaredEffects !== null) {
      validateEffectNames(c, info.declaredEffects, info.nameSpan, info.name);
      // kernel.md A-6: `@intent` implies `agent`; omitting it from the row is E0704.
      for (const e of attributeEffects(info.attrs)) {
        if (!info.declaredEffects.includes(e)) {
          c.error(
            "E0704", "intent_missing_effect",
            `\`@intent fn ${info.name}\` must include the \`${e}\` effect in its row`,
            info.nameSpan,
          );
        }
      }
      // A declared row narrower than what the body needs would let a host grant less
      // authority than the program uses, so the declared set must cover the inferred set.
      const missing = info.effects.filter((e) => !info.declaredEffects!.includes(e));
      if (missing.length > 0) {
        c.error(
          "E0502", "undeclared_effect",
          `\`fn ${info.name}\` uses ${missing.map((e) => `\`${e}\``).join(", ")} but its effect row ${
            info.declaredEffects.length === 0 ? "is empty" : "does not list " + (missing.length === 1 ? "it" : "them")
          }`,
          info.nameSpan,
          {
            repairs: missing.map((e) => ({ op: "add_effect" as const, effect: e, confidence: 0.92 })),
            data: { inferred: info.effects, declared: info.declaredEffects },
          },
        );
      }
      continue;
    }

    if (info.visibility !== "pub") continue;
    if (info.isMethod) continue;
    if (info.fn.body.stmts.length === 0 && !info.fn.body.tail) continue;
    c.error(
      "E0501", "missing_effect_row",
      `\`pub fn ${info.name}\` must declare its effects: \`!{${info.effects.join(", ")}}\``,
      info.nameSpan,
      {
        repairs: [
          { op: "add_effect", effect: `{${info.effects.join(", ")}}`, confidence: 0.95 },
        ],
        data: { inferred: info.effects },
      },
    );
  }
}

function validateEffectNames(c: Checker, effects: readonly string[], span: Span, where: string): void {
  for (const e of effects) {
    if (e === "..") continue;
    if (BUILTIN_EFFECTS[e]) continue;
    // A user-scoped capability like `bank.transfer` is legal: the host grants it, and
    // the System IR lists it. Here it only has to look like a capability name.
    if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(e)) continue;
    c.error("E0504", "malformed_effect", `\`${e}\` in \`${where}\` is not a valid capability name`, span);
  }
}

/** Effects requested by a type, used by the System IR for schema derivation. */
export function effectsOfParam(ty: Ty): string[] {
  if (ty.k !== "named" || ty.args.length === 0) return [];
  return [];
}

export type { FnInfo };
