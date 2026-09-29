/**
 * MM — the compile-time evaluator (kernel.md §8).
 *
 * Three properties are normative, and each is enforced rather than documented:
 *
 * - **Fuel-bounded.** The default budget is 1e6 steps; exhaustion is a compile
 *   error, never a hang.
 * - **Capability-free.** Every operation that would need an effect is rejected
 *   *before* evaluation — a pre-pass walks the body, so an effectful call is
 *   diagnosed without running anything.
 * - **Deterministic.** No clock, no randomness, and floats compare by bit
 *   pattern, so `NaN` and `±0` behave and evaluation is total.
 *
 * It reuses the interpreter's evaluator rather than reimplementing it: two
 * evaluators would drift, and const-eval bugs would then be invisible to the
 * normal test suite.
 */

import { diag, type Block, type Diagnostic, type Expr, type Stmt } from "../ast.ts";
import type { Program } from "../program.ts";
import { lex } from "../lexer.ts";
import type { LoweredConst } from "../lower.ts";
import { Interp, isBlockExpr } from "./interp.ts";
import { CAPABILITY_GATED } from "./prelude.ts";
import { intV, UNIT, type Value } from "./value.ts";

/** Narrow a `Block | Expr` union without an unchecked cast. */
function isBlock(v: Block | Expr): v is Block {
  return "stmts" in v;
}

/**
 * Recover a `const fn`'s parameter names from its source span.
 *
 * Parsing `const fn f(a: u32) -> u32 { .. }` discards the parameter list — the
 * const item keeps only the body — so the names have to come back out of the
 * source. They are read from the tokens between `fn NAME(` and its matching `)`,
 * taking every depth-1 identifier that is followed by `:`.
 *
 * Returns null when the span cannot be read, so the caller can report rather
 * than bind arguments to invented names.
 */
export function constFnParamNames(program: Program, item: LoweredConst): string[] | null {
  const file = program.files[item.span.file];
  if (!file) return null;
  const { tokens } = lex(file.text, item.span.file);
  const start = item.span.start;
  const end = item.span.end;
  const window = tokens.filter((t) => t.span.start >= start && t.span.start < end);
  const open = window.findIndex((t) => t.text === "(");
  if (open < 0) return [];
  const names: string[] = [];
  let depth = 0;
  for (let i = open; i < window.length; i++) {
    const t = window[i]!;
    if (t.text === "(" || t.text === "[") depth += 1;
    else if (t.text === ")" || t.text === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && window[i + 1]?.text === ":") {
      names.push(t.text);
    }
  }
  return names;
}

/** Steps a compile-time evaluation may take before it is a compile error. */
export const DEFAULT_CONST_FUEL = 1_000_000;

export interface ConstResult {
  readonly ok: boolean;
  readonly value: Value;
  readonly diagnostics: Diagnostic[];
}

/**
 * Reject effectful operations *before* evaluating anything. Returns the
 * diagnostics to report; empty means the body is capability-free.
 */
function precheckEffects(
  program: Program, node: Expr | Block | Stmt, module: string,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  const seenFns = new Set<number>();

  const visitExpr = (e: Expr): void => {
    switch (e.kind) {
      case "call": {
        // A direct call to a named function: check its declared/inferred effects.
        if (e.callee.kind === "path") {
          const id = program.resolveFn(e.callee.value, module);
          const info = id === null ? undefined : program.fnInfo.get(id);
          if (info) {
            seenFns.add(info.id);
            if (info.effects.length > 0) {
              found.push(diag("E0503", "missing_capability",
                `\`${info.name}\` needs \`${info.effects.join(", ")}\`, which compile-time evaluation does not grant`,
                e.span, { data: { effects: [...info.effects], fn: info.name } }));
            }
          } else if (Object.prototype.hasOwnProperty.call(CAPABILITY_GATED, e.callee.value)) {
            const cap = CAPABILITY_GATED[e.callee.value]!;
            found.push(diag("E0503", "missing_capability",
              `\`${e.callee.value}\` needs the \`${cap}\` capability, which compile-time evaluation does not grant`,
              e.span, { data: { capability: cap } }));
          }
        }
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        return;
      }
      case "method":
        visitExpr(e.base);
        e.args.forEach(visitExpr);
        return;
      case "binary": visitExpr(e.lhs); visitExpr(e.rhs); return;
      case "unary": case "cast": case "try": case "move": case "tohandle":
        visitExpr(e.operand);
        return;
      case "is": visitExpr(e.base); return;
      case "view": visitExpr(e.operand); return;
      case "field": visitExpr(e.base); return;
      case "index": visitExpr(e.base); visitExpr(e.index); return;
      case "struct": e.fields.forEach((f) => visitExpr(f.value)); return;
      case "array": case "tuple": e.elems.forEach(visitExpr); return;
      case "block": visitBlock(e.block); return;
      case "consteval": visitBlock(e.body); return;
      case "unsafe": case "spawn": visitBlock(e.body); return;
      case "if":
        visitExpr(e.cond);
        visitBlock(e.then);
        if (e.else_ && isBlock(e.else_)) visitBlock(e.else_);
        else if (e.else_) visitExpr(e.else_);
        return;
      case "match":
        visitExpr(e.scrutinee);
        e.arms.forEach((a) => visitExpr(a.body));
        return;
      case "while": visitExpr(e.cond); visitBlock(e.body); return;
      case "loop": visitBlock(e.body); return;
      case "for": visitExpr(e.iter); visitBlock(e.body); return;
      case "return": case "break": if (e.value) visitExpr(e.value); return;
      default: return;
    }
  };

  const visitBlock = (b: Block): void => {
    b.stmts.forEach(visitStmt);
    if (b.tail) visitExpr(b.tail);
  };

  const visitStmt = (s: Stmt): void => {
    switch (s.kind) {
      case "let": if (s.init) visitExpr(s.init); return;
      case "expr": visitExpr(s.expr); return;
      case "assign": visitExpr(s.target); visitExpr(s.value); return;
      case "item": return;
    }
  };

  visitExpr(node as Expr);
  return found;
}

/**
 * Evaluate a `const` item's expression at compile time.
 *
 * Diagnostics land in the returned result and, for convenience, in
 * `program.diagnostics` so a driver that only reports the program's diagnostics
 * still surfaces the failure.
 */
export function evalConst(
  program: Program, expr: Expr, fuel = DEFAULT_CONST_FUEL, module = "",
): ConstResult {
  const effects = precheckEffects(program, expr, module);
  if (effects.length > 0) {
    effects.forEach((d) => program.diagnostics.push(d));
    // Rejected before evaluation: nothing ran.
    return { ok: false, value: UNIT, diagnostics: effects };
  }

  const interp = new Interp(program, { fuel });
  interp.constOnly = true;
  let value: Value = UNIT;
  try {
    value = interp.runBareBlock({ stmts: [], tail: expr, span: expr.span }, module);
  } catch (e) {
    // `Aborted` (fuel) and `Signal` (return/break) are already reported.
    if (!(e instanceof Error) || (e.name !== "Aborted" && e.name !== "Signal")) throw e;
  }
  const { leaks } = interp.finish();
  const diagnostics = [...interp.diagnostics];
  if (leaks.length > 0) {
    diagnostics.push(diag("E0903", "const_escape",
      `a compile-time value escaped its evaluation; shared #${leaks[0]} is still live`,
      expr.span));
  }
  diagnostics.forEach((d) => program.diagnostics.push(d));
  return { ok: diagnostics.every((d) => d.severity !== "error"), value, diagnostics };
}

/** Evaluate a block — the body of an inline `const { .. }`. */
export function evalConstBlock(
  program: Program, block: Block, fuel = DEFAULT_CONST_FUEL, module = "",
): ConstResult {
  const effects = precheckEffects(program, block, module);
  if (effects.length > 0) {
    effects.forEach((d) => program.diagnostics.push(d));
    return { ok: false, value: UNIT, diagnostics: effects };
  }
  const interp = new Interp(program, { fuel });
  interp.constOnly = true;
  let value: Value = UNIT;
  try {
    value = interp.runBareBlock(block, module);
  } catch (e) {
    if (!(e instanceof Error) || (e.name !== "Aborted" && e.name !== "Signal")) throw e;
  }
  interp.finish();
  const diagnostics = [...interp.diagnostics];
  diagnostics.forEach((d) => program.diagnostics.push(d));
  return { ok: diagnostics.every((d) => d.severity !== "error"), value, diagnostics };
}

/**
 * Call a `const fn` at compile time. Calling a non-`const fn` is `E0502`: a
 * compile-time evaluation has no capability to grant it one.
 */
export function evalConstFn(
  program: Program, constItemId: number, args: Value[], fuel = DEFAULT_CONST_FUEL,
): ConstResult {
  const item = program.consts.get(constItemId);
  if (!item) {
    const d = diag("E0118", "unknown_name", `no const item with id ${constItemId}`,
      { start: 0, end: 0, file: -1 });
    program.diagnostics.push(d);
    return { ok: false, value: UNIT, diagnostics: [d] };
  }
  if (!item.isConstFn) {
    const d = diag("E0301", "not_a_const_fn",
      `\`${item.name}\` is a \`const\` item, not a \`const fn\`; call it with evalConst`,
      item.span);
    program.diagnostics.push(d);
    return { ok: false, value: UNIT, diagnostics: [d] };
  }
  const body = item.value;
  if (!isBlockExpr(body)) {
    const d = diag("E0302", "malformed_const_fn",
      `\`${item.name}\` has no body to evaluate`, item.span);
    program.diagnostics.push(d);
    return { ok: false, value: UNIT, diagnostics: [d] };
  }
  const effects = precheckEffects(program, body, item.module);
  if (effects.length > 0) {
    effects.forEach((d) => program.diagnostics.push(d));
    return { ok: false, value: UNIT, diagnostics: effects };
  }
  const paramNames = constFnParamNames(program, item);
  if (paramNames === null) {
    const d = diag("E0304", "unreadable_const_fn",
      `cannot recover the parameter list of \`${item.name}\` from its source`,
      item.span);
    program.diagnostics.push(d);
    return { ok: false, value: UNIT, diagnostics: [d] };
  }
  const interp = new Interp(program, { fuel });
  interp.constOnly = true;
  let value: Value = UNIT;
  try {
    value = interp.callConstFn(item.name, body.block, paramNames, args, item.module);
  } catch (e) {
    if (!(e instanceof Error) || (e.name !== "Aborted" && e.name !== "Signal")) throw e;
  }
  interp.finish();
  const diagnostics = [...interp.diagnostics];
  diagnostics.forEach((d) => program.diagnostics.push(d));
  return { ok: diagnostics.every((d) => d.severity !== "error"), value, diagnostics };
}

/**
 * Evaluate an array length written as `[T; N]`. `N` is a const expression, so it
 * goes through exactly the same fuel-bounded, capability-free path.
 */
export function evalConstLen(program: Program, expr: Expr, module = ""): ConstResult {
  const result = evalConst(program, expr, DEFAULT_CONST_FUEL, module);
  if (!result.ok) return result;
  const v = result.value;
  if (v.k !== "int" || v.v < 0n) {
    const d = diag("E0303", "bad_array_length",
      `array length must be a non-negative integer, got \`${v.k === "int" ? v.v : v.k}\``,
      expr.span);
    program.diagnostics.push(d);
    return { ok: false, value: intV(0n), diagnostics: [d] };
  }
  return { ok: true, value: v, diagnostics: [] };
}

