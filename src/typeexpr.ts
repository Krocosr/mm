/**
 * MM — expression and statement type checking.
 *
 * Walks every function body once, producing the resolved type of each expression and
 * recording the types of expressions the later passes need (calls, constructions, views).
 * Ownership violations are *not* diagnosed here — those are the ownership pass's job, and
 * duplicating them would produce two codes for one bug.
 *
 * See docs/spec/kernel.md §3, §4.5, §6.3.
 */

import type { Block, Diagnostic, Expr, MatchArm, Pattern, Span, Stmt } from "./ast.ts";
import {
  type Ty, TY_ERR, TY_UNIT, BUILTIN, deepResolve, isCopy, isFloat, isInteger, isNumeric,
  deepUnown, owned, unown, unify,
} from "./types.ts";
import { type FnInfo, type Program, isNominal } from "./program.ts";
import { builtinFnById, builtinFnId, resolveMiniType } from "./builtins.ts";
import { type Binder, type Checker, genericScope, resolveTypeExpr } from "./scope.ts";

/** What the expression pass records for the ownership pass and the graph. */
export interface ExprFacts {
  /** Types by expression identity is not available on a plain AST, so facts are keyed
   *  by the (file, start) offset of the node, which is stable within one compilation. */
  readonly types: Map<number, Ty>;
  /** Call sites: callee fn id, the call's span, and the resolved argument types. */
  readonly calls: Map<number, { callee: number; span: Span; argTys: Ty[] }>;
  /** Constructions of nominal types that must not be buildable from a value. */
  readonly constructions: Map<number, { typeName: string; span: Span }>;
  /** Every `view` expression created, for the ownership pass to track regions. */
  readonly views: Map<number, { mutable: boolean; span: Span }>;
}

export function factKey(span: Span): number {
  return span.start * 4096 + span.end;
}

export class BodyChecker {
  readonly facts: ExprFacts = {
    types: new Map(),
    calls: new Map(),
    constructions: new Map(),
    views: new Map(),
  };
  /** Locals declared in the current function, innermost declaration order. */
  locals: Binder[] = [];
  /**
   * Fresh variables created for unsuffixed integer literals, so they can be defaulted to
   * `i64` at the end of a function if nothing ever constrained them.
   */
  intLiterals: Ty[] = [];
  /** Fresh variables for unsuffixed float literals; defaulted to `f64` if unconstrained. */
  floatLiterals: Ty[] = [];
  /** Nesting depth of `unsafe` blocks; 0 means safe context. */
  unsafeDepth = 0;

  constructor(readonly c: Checker) {}

  // -- driver --------------------------------------------------------------

  checkAllFns(): void {
    for (const info of this.c.program.allFns()) {
      if (info.fn.body.stmts.length === 0 && !info.fn.body.tail) continue;
      this.checkFn(info);
    }
  }

  private checkFn(info: FnInfo): void {
    const c = this.c;
    c.currentFn = info.id;
    c.subst.clear();
    this.intLiterals = [];
    this.floatLiterals = [];
    this.generics = genericScope(c, info.fn.generics);
    c.scope.push();
    c.scope.push(); // parameter frame
    info.fn.params.forEach((p, i) => {
      c.scope.define({
        name: p.name,
        ty: info.paramTys[i] ?? TY_ERR,
        kind: "param",
        span: p.span,
        fnId: info.id,
        mutable: p.ownership === "viewmut" || p.ownership === "owned",
      });
    });

    const ret = info.retTy;
    const blockTy = this.checkBlock(info.fn.body, ret);

    for (const v of this.intLiterals) {
      if (v.k === "var" && v.bound === null) v.bound = { k: "prim", name: "i64" };
    }
    for (const v of this.floatLiterals) {
      if (v.k === "var" && v.bound === null) v.bound = { k: "prim", name: "f64" };
    }

    // A body whose tail is not a unit value must match the declared return type.
    if (ret.k !== "err" && blockTy.k !== "err" && !blockTyIsUnit(blockTy)) {
      const m = unify(blockTy, ret, c.subst);
      if (m) {
        c.error("E0204", "return_type_mismatch", `this function returns \`${m.reason}\``, info.fn.body.span, {
          data: { expected: m.expected, actual: m.actual },
        });
      }
    }

    c.scope.pop();
    c.scope.pop();
  }

  // -- blocks and statements ----------------------------------------------

  /** Returns the block's value type (`TY_UNIT` when it has no tail). */
  checkBlock(block: Block, expected: Ty): Ty {
    const c = this.c;
    c.scope.push();
    let tailTy: Ty = TY_UNIT;
    for (const stmt of block.stmts) {
      const t = this.checkStmt(stmt, expected);
      if (t) tailTy = t;
    }
    if (block.tail) tailTy = this.checkExpr(block.tail, expected);
    c.scope.pop();
    return tailTy;
  }

  /** Returns the expression's type when the statement produces a value, else null. */
  private checkStmt(stmt: Stmt, expected: Ty): Ty | null {
    const c = this.c;
    switch (stmt.kind) {
      case "let": {
        const initTy = stmt.init ? this.checkExpr(stmt.init, stmt.ty ? undefined : undefined) : TY_ERR;
        if (stmt.ty) {
          const declared = resolveTypeExpr(c, stmt.ty, this.currentGenerics(), c.moduleFor(stmt.span), stmt.span);
          if (stmt.init) {
            const m = unify(initTy, declared, c.subst);
            if (m) {
              c.error("E0204", "let_type_mismatch", `\`${patternName(stmt.pat)}\` is declared \`${m.reason}\``, stmt.span, {
                repairs: [],
              });
            }
          }
          this.bindPattern(stmt.pat, declared, stmt.mutable, stmt.span);
          this.facts.types.set(factKey(stmt.span), declared);
          return null;
        }
        this.bindPattern(stmt.pat, initTy, stmt.mutable, stmt.span);
        this.facts.types.set(factKey(stmt.span), initTy);
        return null;
      }

      case "assign": {
        const targetTy = this.checkExpr(stmt.target, undefined);
        // Augmented assignment desugars to `assign(x, binary(x, op, v))`; the read of
        // the target is intentional, so the ownership pass treats this shape as in-place.
        const valueTy = this.checkExpr(stmt.value, targetTy);
        const m = unify(targetTy, valueTy, c.subst);
        if (m) {
          c.error("E0205", "assign_type_mismatch", `cannot assign here: ${m.reason}`, stmt.span, {
            data: { expected: m.expected, actual: m.actual },
          });
        }
        return null;
      }

      case "expr": {
        const t = this.checkExpr(stmt.expr, expected);
        this.facts.types.set(factKey(stmt.span), t);
        return t;
      }

      case "item":
        // A nested item shares the enclosing function's generics for lookup purposes;
        // the declaration pass already resolved its signature.
        return null;
    }
  }

  // -- patterns -----------------------------------------------------------

  /**
   * Bind a pattern's names into the current scope and report arity/type mismatches.
   * Returns the type the pattern *consumes*, so a `let` can report a mismatch once.
   */
  bindPattern(pat: Pattern, valueTy: Ty, mutable: boolean, span: Span): void {
    const c = this.c;
    switch (pat.kind) {
      case "wildcard":
        return;
      case "bind": {
        // A bare name that matches a variant of the value's type is that variant, not a
        // fresh binding — the same resolution Rust performs. Without it, `Empty => 0`
        // binds a variable named `Empty` and every such `match` reads as
        // non-exhaustive even though it covers the union.
        const variants = variantNamesOf(c, valueTy);
        if (variants?.has(pat.name) && !pat.ty) {
          this.checkVariantPath(pat.name, valueTy, 0, pat.span);
          return;
        }
        let ty = valueTy;
        if (pat.ty) ty = resolveTypeExpr(c, pat.ty, this.currentGenerics(), c.moduleFor(span), span);
        this.defineLocal(pat.name, ty, mutable, pat.span, "local");
        return;
      }
      case "at":
        this.defineLocal(pat.name, valueTy, false, pat.span, "local");
        this.bindPattern(pat.sub, valueTy, mutable, pat.span);
        return;
      case "or": {
        for (const alt of pat.alts) this.bindPattern(alt, valueTy, mutable, pat.span);
        return;
      }
      case "lit":
        this.checkExpr(pat.value, valueTy);
        return;
      case "unit": {
        // `Variant` — resolves against the scrutinee's union.
        this.checkVariantPath(pat.path, valueTy, 0, pat.span);
        return;
      }
      case "tuple": {
        const elems = tupleOrVariantElems(this.c, pat.path, valueTy, pat.span);
        if (!elems) return;
        if (elems.length !== pat.elems.length) {
          c.error(
            "E0206", "pattern_arity",
            `\`${pat.path}\` has ${elems.length} field${elems.length === 1 ? "" : "s"}, pattern binds ${pat.elems.length}`,
            pat.span,
          );
          return;
        }
        pat.elems.forEach((p, i) => this.bindPattern(p, elems[i]!, mutable, pat.span));
        return;
      }
      case "record": {
        const fields = recordOrVariantFields(this.c, pat.path, valueTy, pat.span);
        if (!fields) return;
        for (const f of pat.fields) {
          const ft = fields.get(f.name);
          if (ft === undefined) {
            if (!pat.rest) {
              c.error("E0207", "unknown_field", `\`${pat.path}\` has no field \`${f.name}\``, f.span);
            }
            continue;
          }
          this.bindPattern(f.pat, ft, mutable, f.span);
        }
        return;
      }
    }
  }

  private checkVariantPath(path: string, valueTy: Ty, arity: number, span: Span): void {
    const variants = variantNamesOf(this.c, valueTy);
    if (variants && !variants.has(path)) {
      this.c.error("E0208", "unknown_variant", `\`${path}\` is not a variant of this union`, span);
    }
  }

  private defineLocal(name: string, ty: Ty, mutable: boolean, span: Span, kind: Binder["kind"]): void {
    const existing = this.c.scope.lookupAll(name);
    if (existing.length > 0) {
      this.c.warn("E0209", "shadowed_binding", `\`${name}\` shadows an earlier binding`, span, );
    }
    const binder: Binder = { name, ty, kind, span, fnId: this.c.currentFn, mutable };
    this.c.scope.define(binder);
    this.locals.push(binder);
  }

  // -- expressions --------------------------------------------------------

  checkExpr(expr: Expr, expected: Ty | undefined): Ty {
    // Publish the expectation so value-position constructors can read it. The previous
    // value is restored afterwards, so a nested expression cannot see a stale context.
    const saved = this.c.currentExpected;
    this.c.currentExpected = expected;
    const ty = this.checkExprInner(expr, expected);
    this.c.currentExpected = saved;
    const resolved = deepResolve(ty);
    this.facts.types.set(factKey(expr.span), resolved);
    return resolved;
  }

  private checkExprInner(expr: Expr, expected: Ty | undefined): Ty {
    const c = this.c;
    switch (expr.kind) {
      // -- literals ------------------------------------------------------
      case "int": {
        if (expr.ty) return resolveTypeExpr(c, expr.ty, this.currentGenerics(), c.moduleFor(expr.span), expr.span);
        if (expected && isInteger(expected)) return expected;
        // An unsuffixed literal is *not* an `i64`. Defaulting it here would make
        // `let total = 0` poison every later `u32` operation it takes part in. It gets a
        // fresh variable that unification pins down, defaulting to `i64` only if nothing
        // ever constrains it (see `defaultIntLiterals`).
        const v = c.freshVar("int");
        this.intLiterals.push(v);
        return v;
      }
      case "float": {
        if (expr.ty) return resolveTypeExpr(c, expr.ty, this.currentGenerics(), c.moduleFor(expr.span), expr.span);
        if (expected && isFloat(expected)) return expected;
        // Same reasoning as an integer literal: `let mut s = 0.0` in an `f32` function
        // must not silently become `f64`, or every accumulator in the body would widen.
        const v = c.freshVar("float");
        this.floatLiterals.push(v);
        return v;
      }
      case "bool":
        return { k: "prim", name: "bool" };
      case "string":
        return { k: "named", def: BUILTIN.Text_, args: [] };
      case "bytes":
        return { k: "named", def: BUILTIN.Bytes_, args: [] };
      case "char":
        return { k: "prim", name: "char" };
      case "effectset":
        return TY_UNIT;

      // -- paths ---------------------------------------------------------
      case "path": {
        // A bare enum variant used as a value: `Route.fast`.
        const binder = c.scope.lookup(expr.value);
        if (binder) return binder.ty;
        // `None` is the one variant that stands alone without a type to qualify it, so
        // it takes its type from context. The expected type may be wrapped in an
        // ownership discipline (`arena Node?`), so the option is looked for underneath.
        if (expr.value === "None") {
          // Look *through* the ownership discipline to decide whether an option is
          // expected, but return the expected type with its wrapper intact: a field
          // declared `arena Node?` needs `arena (Node?)`, not a bare `Node?`.
          const want = expected ? deepResolve(deepUnown(expected)) : null;
          if (want?.k === "option" && expected) return deepResolve(expected);
          return { k: "option", inner: TY_ERR };
        }
        const enumTy = this.checkEnumVariantValue(expr.value, expr.span);
        if (enumTy) return enumTy;
        return this.pathValueType(expr.value, expr.span);
      }

      // -- access --------------------------------------------------------
      case "field": {
        // `NetErr.Timeout` names a *variant*, not a field: the base is a type, not a
        // value. Constructing a nullary variant is the only legal position for a path
        // that resolves to a type in expression position.
        if (expr.base.kind === "path") {
          const asType = c.program.resolveType(expr.base.value, c.moduleFor(expr.span));
          const inScope = c.scope.lookup(expr.base.value);
          if (asType !== null && !inScope) {
            return this.checkVariantConstructor(asType, expr.name, expr.span);
          }
        }
        const baseTy = deepResolve(deepUnown(this.checkExpr(expr.base, undefined)));
        const ft = this.fieldType(baseTy, expr.name, expr.span);
        return ft ?? TY_ERR;
      }

      case "index": {
        const baseTy = deepResolve(deepUnown(this.checkExpr(expr.base, undefined)));
        const idxTy = this.checkExpr(expr.index, { k: "prim", name: "usize" });
        if (!isInteger(idxTy)) {
          c.error("E0205", "index_type", `slice index must be an integer, found \`${renderish(idxTy)}\``, expr.index.span);
        }
        if (baseTy.k === "slice") return baseTy.elem;
        if (baseTy.k === "array") return baseTy.elem;
        if (baseTy.k === "ptr") return baseTy.inner;
        c.error("E0205", "not_indexable", `\`${renderish(baseTy)}\` cannot be indexed`, expr.span);
        return TY_ERR;
      }

      // -- calls ---------------------------------------------------------
      case "call":
        return this.checkCall(expr);
      case "method":
        return this.checkMethod(expr);

      // -- operators -----------------------------------------------------
      case "unary": {
        const operand = deepResolve(this.checkExpr(expr.operand, expected));
        if (expr.op === "&" || expr.op === "&mut") {
          if (expr.op === "&mut" && this.unsafeDepth === 0) {
            c.error("E0431", "unsafe_required", "forming a raw `&mut` pointer requires an `unsafe` context", expr.span);
          }
          return { k: "ptr", mutable: expr.op === "&mut", inner: operand };
        }
        if (expr.op === "*") {
          if (this.unsafeDepth === 0) {
            c.error("E0431", "unsafe_required", "dereferencing a raw pointer requires an `unsafe` context", expr.span);
          }
          if (operand.k === "ptr") return operand.inner;
          c.error("E0430", "deref_non_pointer", `cannot dereference \`${renderish(operand)}\``, expr.span);
          return TY_ERR;
        }
        if (expr.op === "-") {
          if (!isNumeric(operand)) {
            c.error("E0205", "bad_operand", `cannot negate \`${renderish(operand)}\``, expr.span);
            return TY_ERR;
          }
          return operand;
        }
        if (expr.op === "!") {
          if (!isInteger(operand) && operand.k !== "prim" || (operand.k === "prim" && operand.name !== "bool")) {
            c.error("E0205", "bad_operand", `cannot apply \`!\` to \`${renderish(operand)}\``, expr.span);
            return TY_ERR;
          }
          return operand;
        }
        return TY_ERR;
      }

      case "binary":
        return this.checkBinary(expr);
      case "assign": {
        const target = this.checkExpr(expr.target, undefined);
        const value = this.checkExpr(expr.value, target);
        const m = unify(target, value, c.subst);
        if (m) c.error("E0205", "assign_type_mismatch", `cannot assign here: ${m.reason}`, expr.span);
        return TY_UNIT;
      }
      case "try": {
        const inner = deepResolve(this.checkExpr(expr.operand, undefined));
        if (inner.k === "result") return inner.ok;
        c.error(
          "E0205", "try_non_result",
          `\`?\` propagates an error, so it needs a \`Result\`; found \`${renderish(inner)}\``,
          expr.span,
        );
        return TY_ERR;
      }
      case "cast": {
        const operand = this.checkExpr(expr.operand, undefined);
        const target = resolveTypeExpr(c, expr.ty, this.currentGenerics(), c.moduleFor(expr.span), expr.span);
        // kernel.md §9 case 9: integer-to-pointer misuse must not pass in safe code.
        if (target.k === "ptr" && isInteger(operand) && this.unsafeDepth === 0) {
          c.error(
            "E0430", "int_to_ptr",
            "converting an integer directly to a pointer requires an `unsafe` context",
            expr.span,
            { repairs: [] },
          );
        }
        return target;
      }
      case "is": {
        this.checkExpr(expr.base, undefined);
        resolveTypeExpr(c, expr.ty, this.currentGenerics(), c.moduleFor(expr.span), expr.span);
        return { k: "prim", name: "bool" };
      }

      // -- aggregates ----------------------------------------------------
      case "struct":
        return this.checkStructLiteral(expr);
      case "array": {
        const elemExpected = expected && (expected.k === "array" || expected.k === "slice") ? expected.elem : undefined;
        const elems = expr.elems.map((e) => this.checkExpr(e, elemExpected));
        if (elems.length === 0) {
          if (expected && (expected.k === "array" || expected.k === "slice")) {
            return { k: "array", elem: expected.elem, len: 0 };
          }
          c.error("E0205", "empty_array", "cannot infer the element type of an empty array", expr.span);
          return { k: "array", elem: TY_ERR, len: 0 };
        }
        for (const e of elems) unify(elems[0]!, e, c.subst);
        return { k: "array", elem: elems[0]!, len: elems.length };
      }
      case "tuple": {
        const elems = expr.elems.map((e) => this.checkExpr(e, undefined));
        return { k: "tuple", elems };
      }
      case "block":
        return this.checkBlock(expr.block, expected ?? TY_UNIT);

      // -- control flow --------------------------------------------------
      case "if": {
        const cond = deepResolve(this.checkExpr(expr.cond, { k: "prim", name: "bool" }));
        if (cond.k !== "err" && cond.k !== "prim") {
          c.error("E0205", "non_bool_condition", `condition must be \`bool\`, found \`${renderish(cond)}\``, expr.cond.span);
        } else if (cond.k === "prim" && cond.name !== "bool") {
          c.error("E0205", "non_bool_condition", `condition must be \`bool\`, found \`${cond.name}\``, expr.cond.span);
        }
        const thenTy = this.checkBlock(expr.then, expected ?? TY_UNIT);
        if (!expr.else_) {
          if (expected) unify(thenTy, expected, c.subst);
          return TY_UNIT;
        }
        // `Block` carries no `kind`, so the union discriminates structurally.
        const elseTy = "kind" in expr.else_
          ? this.checkExpr(expr.else_, expected ?? TY_UNIT)
          : this.checkBlock(expr.else_, expected ?? TY_UNIT);
        const m = unify(thenTy, elseTy, c.subst);
        if (m) c.error("E0204", "branch_mismatch", `\`if\` and \`else\` disagree: ${m.reason}`, expr.span);
        return thenTy;
      }
      case "match":
        return this.checkMatch(expr);
      case "while": {
        const cond = this.checkExpr(expr.cond, { k: "prim", name: "bool" });
        if (cond.k === "prim" && cond.name !== "bool") {
          c.error("E0205", "non_bool_condition", `loop condition must be \`bool\`, found \`${cond.name}\``, expr.cond.span);
        }
        this.checkBlock(expr.body, TY_UNIT);
        return TY_UNIT;
      }
      case "loop":
        this.checkBlock(expr.body, TY_UNIT);
        return TY_UNIT;
      case "for": {
        const iterTy = deepResolve(this.checkExpr(expr.iter, undefined));
        const elem = iterableElem(this.c, iterTy, expr.iter.span);
        this.c.scope.push();
        this.bindPattern(expr.pat, elem, true, expr.pat.span);
        this.checkBlock(expr.body, TY_UNIT);
        this.c.scope.pop();
        return TY_UNIT;
      }
      case "return": {
        // The function's return type is what `return` yields; recorded for the graph.
        const info = c.program.fnInfo.get(c.currentFn);
        const ret = info?.retTy ?? TY_UNIT;
        if (expr.value) this.checkExpr(expr.value, ret);
        return TY_UNIT;
      }
      case "break":
      case "continue":
        return TY_UNIT;

      // -- explicit ownership --------------------------------------------
      case "move": {
        // `move x` takes the value itself. If `x` is already a borrow, moving it means
        // moving the place it borrows *from*, so the wrapper is replaced, not stacked.
        return owned(unown(this.checkExpr(expr.operand, expected)));
      }
      case "view": {
        // A view reads *through* whatever it borrows, so `view a` on an `arena T` is a
        // view of `T` rather than a view of an arena. The ownership pass still records
        // the borrow against `a`, which is what the region and escape rules inspect.
        const inner = deepUnown(this.checkExpr(expr.operand, undefined));
        this.facts.views.set(factKey(expr.span), { mutable: expr.mutable, span: expr.span });
        return { k: "own", ownership: expr.mutable ? "viewmut" : "view", inner };
      }
      case "unsafe": {
        if (expr.caps.length === 0) {
          c.error(
            "E0432", "unlabelled_unsafe",
            "an `unsafe` block must name the powers it uses, e.g. `unsafe[ffi] { .. }`",
            expr.span,
          );
        }
        this.unsafeDepth += 1;
        const t = this.checkBlock(expr.body, TY_UNIT);
        this.unsafeDepth -= 1;
        return t;
      }
      case "consteval": {
        this.unsafeDepth += 1; // const fns may not reach effects; the effect pass enforces that
        const t = this.checkBlock(expr.body, TY_UNIT);
        this.unsafeDepth -= 1;
        return t;
      }
      case "spawn": {
        // kernel.md §9 case 7: a `view mut` may not cross into a task boundary.
        this.c.scope.push();
        const t = this.checkBlock(expr.body, TY_UNIT);
        this.c.scope.pop();
        if (expr.transfer === "shared") {
          c.error(
            "E0420", "cross_thread_alias",
            "a task body may only capture `shared` values, not exclusive borrows",
            expr.span,
          );
        }
        return t;
      }
      case "tohandle": {
        const inner = this.checkExpr(expr.operand, undefined);
        return { k: "own", ownership: "handle", inner };
      }
    }
  }

  // -- specific forms ------------------------------------------------------

  private checkBinary(expr: Extract<Expr, { kind: "binary" }>): Ty {
    const c = this.c;
    const lhs = deepResolve(this.checkExpr(expr.lhs, undefined));
    const rhs = deepResolve(this.checkExpr(expr.rhs, lhs.k !== "err" ? lhs : undefined));

    switch (expr.op) {
      case "==": case "!=": case "<": case "<=": case ">": case ">=":
        return { k: "prim", name: "bool" };
      case "&&": case "||":
        if (lhs.k === "prim" && lhs.name !== "bool") {
          c.error("E0205", "non_bool_operand", `\`${expr.op}\` needs \`bool\` operands`, expr.span);
        }
        if (rhs.k === "prim" && rhs.name !== "bool") {
          c.error("E0205", "non_bool_operand", `\`${expr.op}\` needs \`bool\` operands`, expr.span);
        }
        return { k: "prim", name: "bool" };
      case "+": case "-": case "*": case "/": case "%": {
        if (lhs.k === "err" || rhs.k === "err") return TY_ERR;
        // Concatenation is a `+` the runtime has always had: `arith` joins two `Text`
        // values, and `"" + word` is how a program builds a string. Rejecting it here
        // made every string-building program fail to typecheck while running fine.
        if (expr.op === "+"
          && ((lhs.k === "named" && lhs.def === BUILTIN.Text_
                && ((rhs.k === "named" && rhs.def === BUILTIN.Text_)
                  || (rhs.k === "prim" && rhs.name === "char")))
            || (lhs.k === "prim" && lhs.name === "char"
                && rhs.k === "named" && rhs.def === BUILTIN.Text_))) return lhs.k === "prim" ? rhs : lhs;
        if (!isNumeric(lhs) || !isNumeric(rhs)) {
          c.error(
            "E0205", "bad_operand",
            `cannot apply \`${expr.op}\` to \`${renderish(lhs)}\` and \`${renderish(rhs)}\``,
            expr.span,
          );
          return TY_ERR;
        }
        const m = unify(lhs, rhs, c.subst);
        // Same width on both sides — including `f32 op f32`, which must stay `f32`
        // rather than silently widening a geometry program to double precision.
        if (!m) return lhs;
        // A float/int width mismatch widens to `f64`; every other numeric mismatch is a
        // genuine type error, because mixing signedness or width silently is not.
        if (isFloat(lhs) || isFloat(rhs)) return { k: "prim", name: "f64" };
        c.error("E0205", "bad_operand", `cannot apply \`${expr.op}\`: ${m.reason}`, expr.span);
        return TY_ERR;
      }
      case "|": case "&": case "^": case "<<": case ">>":
        if (!isInteger(lhs) || !isInteger(rhs)) {
          c.error("E0205", "bad_operand", `\`${expr.op}\` needs integer operands`, expr.span);
          return TY_ERR;
        }
        return lhs;
    }
  }

  private checkCall(expr: Extract<Expr, { kind: "call" }>): Ty {
    const c = this.c;
    if (expr.callee.kind !== "path") {
      this.checkExpr(expr.callee, undefined);
      c.error("E0205", "not_callable", "this expression is not callable", expr.span);
      for (const a of expr.args) this.checkExpr(a, undefined);
      return TY_ERR;
    }
    const name = expr.callee.value;

    // A `Cap<E>` is never constructed from a value (kernel.md §6.3, E0602).
    if (name === BUILTIN_BY_NAME_CAP) {
      c.error(
        "E0602", "cap_not_constructible",
        "a capability cannot be constructed; it is granted by a trusted host and only ever passed as a parameter",
        expr.span,
        { repairs: [] },
      );
      for (const a of expr.args) this.checkExpr(a, undefined);
      return TY_ERR;
    }

    // A `use`d capability builtin called by its bare name, e.g. `use fs; open(path)`.
    const bid = builtinFnId(name);
    if (bid !== Number.MIN_SAFE_INTEGER) {
      return this.checkBuiltinCall(expr.args, expr.span, name, bid);
    }

    const binder = c.scope.lookup(name);
    if (binder) {
      // A variable holding a closure-like value: check arguments against its type.
      const t = deepResolve(binder.ty);
      if (t.k === "fnptr") {
        expr.args.forEach((a, i) => this.checkExpr(a, t.params[i]));
        return t.ret;
      }
      this.checkExpr(expr.callee, undefined);
      for (const a of expr.args) this.checkExpr(a, undefined);
      c.error("E0205", "not_callable", `\`${name}\` is not a function`, expr.span);
      return TY_ERR;
    }

    const fnId = c.program.resolveFn(name, c.moduleFor(expr.span));
    if (fnId === null) {
      // `Ok(x)` / `Err(e)` / `Some(x)` are value constructors for the builtin wrappers,
      // not functions: they carry no authority and resolve purely structurally.
      const constructed = this.checkBuiltinConstructor(name, expr.args, expr.span);
      if (constructed) return constructed;
      // A zero-argument enum variant used as a value, e.g. `Route.fast` written bare.
      const enumTy = this.checkEnumVariantValue(name, expr.span);
      if (enumTy) return enumTy;
      c.error("E0203", "unknown_function", `cannot find function \`${name}\``, expr.span, {
        data: { name, module: c.moduleFor(expr.span) },
        repairs: [],
      });
      for (const a of expr.args) this.checkExpr(a, undefined);
      return TY_ERR;
    }

    const info = c.program.fnInfo.get(fnId);
    if (!info) return TY_ERR;

    // A `pub` fn with an explicit effect row is a capability boundary; a call to it from
    // a pure context is the effect pass's job, not ours. We only check arity and types.
    const params = info.paramTys;
    if (params.length !== expr.args.length) {
      c.error(
        "E0206", "call_arity",
        `\`${name}\` takes ${params.length} argument${params.length === 1 ? "" : "s"}, found ${expr.args.length}`,
        expr.span,
      );
    }
    const argTys: Ty[] = [];
    expr.args.forEach((a, i) => {
      const want = i < params.length ? deepResolve(params[i]!) : undefined;
      const got = this.checkExpr(a, want);
      argTys.push(got);
      if (want) {
        const m = unify(want, got, c.subst);
        if (m) {
          c.error(
            "E0205", "argument_type",
            `argument ${i + 1} of \`${name}\`: ${m.reason}`,
            a.span,
            { data: { expected: m.expected, actual: m.actual } },
          );
        }
      }
    });
    this.facts.calls.set(factKey(expr.span), { callee: fnId, span: expr.span, argTys });
    return deepResolve(info.retTy);
  }

  private checkMethod(expr: Extract<Expr, { kind: "method" }>): Ty {
    const c = this.c;
    // `fs.open(path)` parses as a method call on a path, so the capability builtins are
    // resolved here. They are compiler-known, not user code: nothing a module defines
    // can change what `fs.open` costs.
    if (expr.base.kind === "path") {
      const qualified = `${expr.base.value}.${expr.name}`;
      const bid = builtinFnId(qualified);
      if (bid !== Number.MIN_SAFE_INTEGER) {
        return this.checkBuiltinCall(expr.args, expr.span, qualified, bid);
      }
    }
    // Resolve twice: once keeping the ownership wrapper, once without. `deepUnown` is
    // right for most lookups — a method should see the underlying value type — but it
    // erases exactly the fact that tells a handle from any other named type, so every
    // `h.index()` was rejected on `type#5` with no way to tell what `h` was.
    const owned = deepResolve(this.checkExpr(expr.base, undefined));
    const baseTy = deepResolve(deepUnown(owned));
    const t = this.methodType(owned, expr.name, expr.span) ?? this.methodType(baseTy, expr.name, expr.span);
    if (!t) {
      for (const a of expr.args) this.checkExpr(a, undefined);
      c.error("E0203", "unknown_method", `no method \`${expr.name}\` on \`${renderish(baseTy)}\``, expr.nameSpan);
      return TY_ERR;
    }
    expr.args.forEach((a, i) => this.checkExpr(a, i < t.params.length ? t.params[i] : undefined));
    return t.ret;
  }

  /**
   * Type-check a call to a capability builtin against its fixed signature.
   *
   * Takes the argument list rather than a whole call expression, because a builtin can be
   * reached both as `fs.open(p)` (a method-shaped call) and as `open(p)` after a `use`.
   */
  private checkBuiltinCall(args: Expr[], span: Span, qualified: string, id: number): Ty {
    const c = this.c;
    const def = builtinFnById(id)!;
    if (def.params.length !== args.length) {
      c.error(
        "E0206", "call_arity",
        `\`${qualified}\` takes ${def.params.length} argument${def.params.length === 1 ? "" : "s"}, found ${args.length}`,
        span,
      );
    }

    // A builtin's `T` binds to its first argument with the ownership wrapper stripped:
    // `shared_clone` and `handle_of` *wrap* a value, so they receive the underlying type
    // and re-apply their own discipline in the declared result.
    const firstTy = args.length > 0 ? this.checkExpr(args[0]!, undefined) : TY_ERR;
    const seed = deepResolve(deepUnown(firstTy));
    const params = def.params.map((p) => resolveMiniType(p, [seed]));

    const argTys: Ty[] = [];
    args.forEach((a, i) => {
      const want = i < params.length ? params[i]! : undefined;
      // The first argument was already checked above; only unify it against the
      // parameter here, so no diagnostic is emitted twice.
      const got = i === 0 ? seed : this.checkExpr(a, want);
      argTys.push(got);
      if (want) {
        const m = unify(want, got, c.subst);
        if (m) c.error("E0205", "argument_type", `argument ${i + 1} of \`${qualified}\`: ${m.reason}`, a.span);
      }
    });
    this.facts.calls.set(factKey(span), { callee: id, span, argTys });
    return resolveMiniType(def.ret, [seed]);
  }

  /**
   * Construct a nullary variant of a union, e.g. `NetErr.Timeout`.
   *
   * Only a variant with no fields can be built this way; a payload-carrying variant
   * needs a struct literal, so `Shape.Circle { r: 1 }` stays the single form for those.
   */
  private checkVariantConstructor(def: number, variant: string, span: Span): Ty {
    const c = this.c;
    const info = c.program.typeInfo.get(def);
    const name = info?.name ?? `type#${def}`;

    // A builtin union (`NetErr`, `IoErr`) has no AST declaration to look through, so its
    // variant list on `TypeInfo` is the authority.
    if (info?.module === "<builtin>") {
      if (!info.fieldNames.includes(variant)) {
        c.error("E0208", "unknown_variant", `\`${name}\` has no variant \`${variant}\``, span);
        return TY_ERR;
      }
      return { k: "named", def, args: [] };
    }

    if (info?.form === "choice") {
      if (!info.fieldNames.includes(variant)) {
        c.error("E0208", "unknown_variant", `\`${name}\` has no choice \`${variant}\``, span);
        return TY_ERR;
      }
      return { k: "named", def, args: [] };
    }

    const owner = c.program.units.find((u) => u.types.some((t) => t.id === def))?.types.find((t) => t.id === def);
    const decl = owner?.def.form === "union" ? owner.def.variants.find((v) => v.name === variant) : undefined;
    if (!decl) {
      c.error("E0208", "unknown_variant", `\`${name}\` has no variant \`${variant}\``, span);
      return TY_ERR;
    }
    if (decl.fields.length > 0) {
      c.error(
        "E0206", "variant_needs_fields",
        `\`${variant}\` carries ${decl.fields.length} field(s); build it as \`${name}.${variant} { .. }\``,
        span,
      );
      return TY_ERR;
    }
    return { k: "named", def, args: [] };
  }

  /**
   * `Ok`/`Err`/`Some`/`None` in value position.
   *
   * These are the builtin wrappers' constructors rather than functions, so they resolve
   * structurally and never enter the call graph. The payload type comes from the
   * surrounding context when there is one, and otherwise stays open for unification —
   * the same rule an unsuffixed literal follows.
   */
  private checkBuiltinConstructor(name: string, args: Expr[], span: Span): Ty | null {
    const c = this.c;
    const ctx = c.currentExpected ? deepResolve(deepUnown(c.currentExpected)) : null;
    if (name === "Some" || name === "Ok") {
      if (args.length !== 1) {
        c.error("E0206", "call_arity", `\`${name}\` takes exactly 1 argument, found ${args.length}`, span);
        for (const a of args) this.checkExpr(a, undefined);
        return null;
      }
      const inner = ctx?.k === "option" ? ctx.inner : ctx?.k === "result" ? ctx.ok : undefined;
      this.checkExpr(args[0]!, inner);
      return name === "Some"
        ? { k: "option", inner: inner ?? TY_ERR }
        : { k: "result", ok: inner ?? TY_ERR, err: TY_ERR };
    }
    if (name === "Err") {
      if (args.length !== 1) {
        c.error("E0206", "call_arity", `\`Err\` takes exactly 1 argument, found ${args.length}`, span);
        for (const a of args) this.checkExpr(a, undefined);
        return null;
      }
      const errType = ctx?.k === "result" ? ctx.err : undefined;
      this.checkExpr(args[0]!, errType);
      return { k: "result", ok: TY_ERR, err: errType ?? TY_ERR };
    }
    if (name === "None") {
      if (args.length !== 0) {
        c.error("E0206", "call_arity", `\`None\` takes no arguments, found ${args.length}`, span);
        for (const a of args) this.checkExpr(a, undefined);
        return null;
      }
      return ctx?.k === "option" ? ctx : { k: "option", inner: TY_ERR };
    }
    return null;
  }

  /**
   * The type of a method, by receiver.
   *
   * The builtin half of this is the *checker's* registry of what methods exist, kept by
   * hand and separate from the prelude's `<type>_<name>` table. The two drift: a method
   * the interpreter implements but this omits becomes a false rejection (`E0203`) on a
   * program that runs correctly. `tests/registry.test.ts` asserts the two agree, so the
   * next method added to the prelude fails a test rather than becoming a rejection.
   *
   * Public so that test can reach it. The only other caller is `checkMethod`.
   */
  methodType(base: Ty, name: string, span: Span): { params: Ty[]; ret: Ty } | null {
    // Each table below mirrors the prelude's `<tag>_<name>` builtins for that receiver,
    // exactly — no more and no less. An entry the prelude does not implement is a
    // phantom: the program typechecks and then fails at run time, which is the one
    // failure this project cannot afford, because it means the compiler's answer was
    // wrong. `tests/registry.test.ts` asserts the two agree in both directions.
    // A slice and a fixed-size array are separate receivers with separate builtin keys
    // (`slice_*` and `array_*`), so they get separate tables. Sharing one would type
    // `push` on an array, which has no `array_push` to dispatch to.
    if (base.k === "array") {
      switch (name) {
        case "len": return { params: [], ret: { k: "prim", name: "usize" } };
        case "get": return { params: [{ k: "prim", name: "usize" }], ret: { k: "option", inner: base.elem } };
        default: return null;
      }
    }
    if (base.k === "slice") {
      switch (name) {
        case "len": return { params: [], ret: { k: "prim", name: "usize" } };
        case "is_empty": return { params: [], ret: { k: "prim", name: "bool" } };
        case "get": return { params: [{ k: "prim", name: "usize" }], ret: { k: "option", inner: base.elem } };
        case "push": return { params: [base.elem], ret: TY_UNIT };
        default: return null;
      }
    }
    // A handle is `{k:"own", ownership:"handle", inner}`. The prelude dispatches these
    // through `handle_*` keys, and this table was missing the `own` receiver entirely,
    // so every call on a handle was rejected — 39 of the E0203s the corpus still
    // reported. `renderish` printed such a receiver as the bare word `type`, which is
    // what made the messages read as nonsense rather than as a missing table.
    if (base.k === "own" && base.ownership === "handle") {
      switch (name) {
        case "index": return { params: [], ret: { k: "prim", name: "usize" } };
        case "generation": return { params: [], ret: { k: "prim", name: "u32" } };
        case "is_null": return { params: [], ret: { k: "prim", name: "bool" } };
        case "is_live": return { params: [], ret: { k: "prim", name: "bool" } };
        default: return null;
      }
    }
    if (base.k === "named" && base.def === BUILTIN.Text_) {
      switch (name) {
        case "len": return { params: [], ret: { k: "prim", name: "usize" } };
        case "concat": return { params: [base], ret: base };
        case "contains": return { params: [base], ret: { k: "prim", name: "bool" } };
        case "starts_with": return { params: [base], ret: { k: "prim", name: "bool" } };
        case "ends_with": return { params: [base], ret: { k: "prim", name: "bool" } };
        case "eq": return { params: [base], ret: { k: "prim", name: "bool" } };
        // `upper` and `lower`, not `to_upper`/`to_lower`: the prelude spells them without
        // the prefix, and the checker is the registry that follows the implementation
        // rather than the other way round.
        case "upper": return { params: [], ret: base };
        case "lower": return { params: [], ret: base };
        // `chars` yields `char` values, the same thing `s[i]` produces, and `slice` takes
        // a start and an end in bytes, exactly as `text_slice` does.
        case "as_bytes": return { params: [], ret: { k: "named", def: BUILTIN.Bytes_, args: [] } };
        case "bytes": return { params: [], ret: { k: "slice", elem: { k: "prim", name: "u8" } } };
        case "chars": return { params: [], ret: { k: "slice", elem: { k: "prim", name: "char" } } };
        case "slice": return { params: [{ k: "prim", name: "usize" }, { k: "prim", name: "usize" }], ret: base };
        default: return null;
      }
    }
    if (base.k === "named" && base.def === BUILTIN.Bytes_) {
      switch (name) {
        case "len": return { params: [], ret: { k: "prim", name: "usize" } };
        case "get": return { params: [{ k: "prim", name: "usize" }], ret: { k: "option", inner: { k: "prim", name: "u8" } } };
        case "set": return { params: [{ k: "prim", name: "usize" }, { k: "prim", name: "u8" }], ret: TY_UNIT };
        case "slice": return { params: [{ k: "prim", name: "usize" }, { k: "prim", name: "usize" }], ret: base };
        case "concat": return { params: [base], ret: base };
        case "eq": return { params: [base], ret: { k: "prim", name: "bool" } };
        default: return null;
      }
    }
    if (base.k === "option") {
      switch (name) {
        case "is_some": return { params: [], ret: { k: "prim", name: "bool" } };
        case "is_none": return { params: [], ret: { k: "prim", name: "bool" } };
        case "unwrap": return { params: [], ret: base.inner };
        case "unwrap_or": return { params: [base.inner], ret: base.inner };
        case "take": return { params: [], ret: base };
        case "map": return { params: [{ k: "fnptr", params: [base.inner], ret: TY_UNIT, effects: [] }], ret: base };
        default: return null;
      }
    }
    if (base.k === "result") {
      switch (name) {
        case "is_ok": return { params: [], ret: { k: "prim", name: "bool" } };
        case "is_err": return { params: [], ret: { k: "prim", name: "bool" } };
        case "unwrap": return { params: [], ret: base.ok };
        case "unwrap_or": return { params: [base.ok], ret: base.ok };
        case "ok": return { params: [], ret: { k: "option", inner: base.ok } };
        case "err": return { params: [], ret: { k: "option", inner: base.err } };
        case "map_err": return { params: [{ k: "fnptr", params: [base.err], ret: TY_UNIT, effects: [] }], ret: base };
        default: return null;
      }
    }
    if (base.k === "named" && base.def === BUILTIN.Map) {
      switch (name) {
        // Total: a miss reads as the value type's zero. `get_opt` is the `Opt` form, so
        // the distinction stays expressible where it actually matters — which is why
        // the checker must know it exists.
        case "get": return { params: [base.args[0] ?? TY_ERR], ret: base.args[1] ?? TY_ERR };
        case "get_opt": return { params: [base.args[0] ?? TY_ERR], ret: { k: "option", inner: base.args[1] ?? TY_ERR } };
        case "has": return { params: [base.args[0] ?? TY_ERR], ret: { k: "prim", name: "bool" } };
        case "insert": return { params: [base.args[0] ?? TY_ERR, base.args[1] ?? TY_ERR], ret: TY_UNIT };
        case "remove": return { params: [base.args[0] ?? TY_ERR], ret: { k: "option", inner: base.args[1] ?? TY_ERR } };
        case "keys": return { params: [], ret: { k: "slice", elem: base.args[0] ?? TY_ERR } };
        case "new": return { params: [], ret: base };
        default: return null;
      }
    }
    if (base.k === "named" && base.def === BUILTIN.Set) {
      switch (name) {
        case "insert": return { params: [base.args[0] ?? TY_ERR], ret: { k: "prim", name: "bool" } };
        case "has": return { params: [base.args[0] ?? TY_ERR], ret: { k: "prim", name: "bool" } };
        case "contains": return { params: [base.args[0] ?? TY_ERR], ret: { k: "prim", name: "bool" } };
        case "remove": return { params: [base.args[0] ?? TY_ERR], ret: { k: "prim", name: "bool" } };
        case "values": return { params: [], ret: { k: "slice", elem: base.args[0] ?? TY_ERR } };
        case "len": return { params: [], ret: { k: "prim", name: "usize" } };
        case "new": return { params: [], ret: base };
        default: return null;
      }
    }
    // User-defined `impl` blocks: a method on a named type.
    for (const impl of this.c.program.impls.values()) {
      for (const m of impl.methods) {
        if (m.name !== name) continue;
        const info = this.c.program.fnInfo.get(m.id);
        if (!info) continue;
        if (!typeMatchesNominal(this.c, base, impl.typeName)) continue;
        return { params: info.paramTys, ret: info.retTy };
      }
    }
    void span;
    return null;
  }

  private checkStructLiteral(expr: Extract<Expr, { kind: "struct" }>): Ty {
    const c = this.c;
    // `Json.Num { n: 1 }` qualifies a *variant*: the qualifier is the union type and the
    // last segment names the variant being constructed. `Point { x: 1 }` names the type
    // directly. Both produce the qualifier's type as the expression's type.
    const dot = expr.path.lastIndexOf(".");
    const typeName = dot > 0 ? expr.path.slice(0, dot) : expr.path;
    const variantName = dot > 0 ? expr.path.slice(dot + 1) : null;
    const def = c.program.resolveType(typeName, c.moduleFor(expr.span));
    if (def === null) {
      for (const f of expr.fields) this.checkExpr(f.value, undefined);
      c.error("E0203", "unknown_type", `cannot find type \`${typeName}\``, expr.span);
      return TY_ERR;
    }
    const info = c.program.typeInfo.get(def);
    // A struct literal names no type arguments, so they are inherited from the context.
    // `Decision { value: a, .. }` returned as `Decision<Approval>` is a `Decision` whose
    // `T` is `Approval`; leaving the args empty made every generic builtin record
    // unconstructible and then failed to unify with the declared return type.
    const ctx = c.currentExpected ? deepResolve(deepUnown(c.currentExpected)) : null;
    const expectedArgs = ctx?.k === "named" && ctx.def === def ? ctx.args : null;
    const arity = info?.arity ?? 0;
    const args: Ty[] = expectedArgs && expectedArgs.length === arity
      ? expectedArgs
      : Array.from({ length: arity }, () => TY_ERR);
    const ty: Ty = { k: "named", def, args };

    if (variantName !== null) {
      const declUnit = c.program.units.find((u) => u.types.some((t) => t.id === def));
      const decl = declUnit?.types.find((t) => t.id === def);
      const variant = decl?.def.form === "union"
        ? decl.def.variants.find((v) => v.name === variantName)
        : undefined;
      if (!decl || !variant) {
        for (const f of expr.fields) this.checkExpr(f.value, undefined);
        c.error("E0208", "unknown_variant", `\`${typeName}\` has no variant \`${variantName}\``, expr.span);
        return TY_ERR;
      }
      const generics = new Map(decl.def.generics.map((g, i) => [g.name, args[i] ?? TY_ERR] as const));
      this.checkFieldsAgainst(expr, variant.fields.map((f) => ({
        name: f.name,
        ty: resolveTypeExpr(c, f.ty, generics, declUnit!.module, f.span),
      })), `${typeName}.${variantName}`);
      this.facts.constructions.set(factKey(expr.span), { typeName, span: expr.span });
      return ty;
    }

    // Constructing a nominal trust-lattice type is a policy question, not a layout one.
    this.facts.constructions.set(factKey(expr.span), { typeName: info?.name ?? expr.path, span: expr.span });

    if (def === BUILTIN.Cap) {
      c.error(
        "E0602", "cap_not_constructible",
        "a capability cannot be built from a value; only a trusted host grant provides one",
        expr.span,
        { repairs: [] },
      );
    }

    // Validate against the declared field set.
    const declUnit = c.program.units.find((u) => u.types.some((t) => t.id === def));
    const decl = declUnit?.types.find((t) => t.id === def);
    if (decl && decl.def.form === "record") {
      const declared = new Map(decl.def.fields.map((f) => [f.name, f] as const));
      for (const f of expr.fields) {
        const d = declared.get(f.name);
        if (!d) {
          c.error("E0207", "unknown_field", `\`${expr.path}\` has no field \`${f.name}\``, f.span);
          this.checkExpr(f.value, undefined);
          continue;
        }
        const want = resolveTypeExpr(c, d.ty, this.genericsForDecl(decl.def.generics), c.moduleFor(f.span), f.span);
        const got = this.checkExpr(f.value, want);
        const m = unify(want, got, c.subst);
        if (m) c.error("E0205", "field_type", `field \`${f.name}\`: ${m.reason}`, f.value.span);
      }
      const missing = decl.def.fields.filter((f) => !expr.fields.some((g) => g.name === f.name));
      for (const f of missing) {
        c.error("E0206", "missing_field", `\`${expr.path}\` is missing field \`${f.name}\``, expr.span);
      }
      const unknown = expr.fields.filter((f) => !declared.has(f.name));
      for (const f of unknown) {
        c.error("E0207", "unknown_field", `\`${expr.path}\` has no field \`${f.name}\``, f.span);
      }
      return ty;
    }

    // A nominal trust-lattice wrapper (`Verified`, `Untrusted`, `Cap`) has no field set
    // to check: naming one *is* the violation, and the trust rule reports it. Only a
    // data-carrying builtin record like `Decision` is field-validated here.
    if (isNominal(def)) {
      for (const f of expr.fields) this.checkExpr(f.value, undefined);
      return ty;
    }
    const builtinFields = c.expand(def, args);
    if (builtinFields) {
      for (const f of expr.fields) {
        const d = builtinFields.find((x) => x.name === f.name);
        if (!d) {
          c.error("E0207", "unknown_field", `\`${expr.path}\` has no field \`${f.name}\``, f.span);
          this.checkExpr(f.value, undefined);
          continue;
        }
        const got = this.checkExpr(f.value, d.ty);
        const m = unify(d.ty, got, c.subst);
        if (m) c.error("E0205", "field_type", `field \`${f.name}\`: ${m.reason}`, f.value.span);
      }
      return ty;
    }

    for (const f of expr.fields) this.checkExpr(f.value, undefined);
    return ty;
  }

  /**
   * Check a struct literal's initialisers against a field list: unknown fields, missing
   * fields, and type mismatches, each reported at the most specific span available.
   */
  private checkFieldsAgainst(
    expr: Extract<Expr, { kind: "struct" }>,
    declared: ReadonlyArray<{ name: string; ty: Ty }>,
    where: string,
  ): void {
    const c = this.c;
    const byName = new Map(declared.map((d) => [d.name, d] as const));
    for (const f of expr.fields) {
      const d = byName.get(f.name);
      if (!d) {
        c.error("E0207", "unknown_field", `\`${where}\` has no field \`${f.name}\``, f.span);
        this.checkExpr(f.value, undefined);
        continue;
      }
      const got = this.checkExpr(f.value, d.ty);
      const m = unify(d.ty, got, c.subst);
      if (m) c.error("E0205", "field_type", `field \`${f.name}\`: ${m.reason}`, f.value.span);
    }
    for (const d of declared) {
      if (!expr.fields.some((f) => f.name === d.name)) {
        c.error("E0206", "missing_field", `\`${where}\` is missing field \`${d.name}\``, expr.span);
      }
    }
  }

  private checkMatch(expr: Extract<Expr, { kind: "match" }>): Ty {
    const c = this.c;
    const scrutinee = deepResolve(deepUnown(this.checkExpr(expr.scrutinee, undefined)));
    let resultTy: Ty | null = null;
    let sawWildcard = false;

    for (const arm of expr.arms) {
      c.scope.push();
      this.bindPattern(arm.pat, scrutinee, false, arm.pat.span);
      const armTy = this.checkExpr(arm.body, resultTy ?? undefined);
      c.scope.pop();
      if (arm.pat.kind === "wildcard") sawWildcard = true;
      if (resultTy === null) resultTy = armTy;
      else {
        const m = unify(resultTy, armTy, c.subst);
        if (m) c.error("E0204", "match_arm_mismatch", `match arms disagree: ${m.reason}`, arm.span);
      }
    }

    if (expr.arms.length === 0) {
      c.error("E0210", "empty_match", "`match` must have at least one arm", expr.span);
      return TY_ERR;
    }
    if (!sawWildcard) {
      // Not an error: a match on a finite union is exhaustive when it covers every
      // variant. Report it only when the scrutinee could hold values not listed.
      const variants = variantNamesOf(c, scrutinee);
      if (variants && variants.size > 0) {
        const covered = new Set<string>();
        for (const arm of expr.arms) collectVariants(arm.pat, covered, variants);
        const missing = [...variants].filter((v) => !covered.has(v));
        if (missing.length > 0) {
          c.warn(
            "E0211", "non_exhaustive_match",
            `match does not cover variant${missing.length === 1 ? "" : "s"} ${missing.map((m) => `\`${m}\``).join(", ")}`,
            expr.span,
          );
        }
      }
    }
    return resultTy ?? TY_UNIT;
  }

  // -- helpers -------------------------------------------------------------

  private fieldType(base: Ty, name: string, span: Span): Ty | null {
    const c = this.c;
    if (base.k === "record") {
      const f = base.fields.find((x) => x.name === name);
      if (f) return f.ty;
      c.error("E0207", "unknown_field", `record has no field \`${name}\``, span);
      return null;
    }
    if (base.k === "tuple") {
      const idx = Number(name);
      if (Number.isInteger(idx) && idx >= 0 && idx < base.elems.length) return base.elems[idx]!;
      c.error("E0207", "unknown_field", `tuple has no element \`${name}\``, span);
      return null;
    }
    if (base.k === "named") {
      const info = c.program.typeInfo.get(base.def);
      if (info?.form === "record" || info?.form === "union") {
        const fields = c.expand(base.def, base.args);
        if (fields) {
          const f = fields.find((x) => x.name === name);
          if (f) return f.ty;
          c.error("E0207", "unknown_field", `\`${info.name}\` has no field \`${name}\``, span);
          return null;
        }
        // A union used as a value without a variant selected: fields are variant-scoped.
        if (info.form === "union") {
          c.error(
            "E0209", "union_field_access",
            `\`${info.name}\` is a union; select a variant with \`match\` before reading \`${name}\``,
            span,
          );
          return null;
        }
      }
      const builtin = c.expand(base.def, base.args);
      if (builtin) {
        const f = builtin.find((x) => x.name === name);
        if (f) return f.ty;
      }
    }
    c.error("E0207", "unknown_field", `\`${renderish(base)}\` has no field \`${name}\``, span);
    return null;
  }

  private checkEnumVariantValue(path: string, span: Span): Ty | null {
    // `Route.fast` — the receiver is a `choice` type. Resolution needs the type, which a
    // bare path does not carry, so a bare `Ident.variant` in value position is only
    // resolvable when exactly one `choice` type in the program declares that variant.
    const c = this.c;
    const parts = splitLast(path);
    if (!parts) return null;
    const variant = parts[1];
    for (const t of c.program.allTypes()) {
      if (t.form !== "choice") continue;
      if (t.fieldNames.includes(variant)) {
        return { k: "named", def: t.id, args: [] };
      }
    }
    void span;
    return null;
  }

  private pathValueType(name: string, span: Span): Ty {
    const c = this.c;
    const constId = c.program.resolveConst(name, c.moduleFor(span));
    if (constId !== null) {
      const decl = c.program.consts.get(constId);
      if (decl) {
        return decl.ty
          ? resolveTypeExpr(c, decl.ty, new Map(), c.moduleFor(span), span)
          : { k: "prim", name: "i64" };
      }
    }
    const t = c.program.resolveType(name, c.moduleFor(span));
    if (t !== null) {
      c.error(
        "E0205", "type_as_value",
        `\`${name}\` is a type, not a value`,
        span,
      );
      return TY_ERR;
    }
    c.error("E0203", "unknown_name", `cannot find \`${name}\` in this scope`, span, {
      data: { name, module: c.moduleFor(span) },
      repairs: [],
    });
    return TY_ERR;
  }

  currentGenerics(): Map<string, Ty> {
    return this.generics;
  }
  private generics: Map<string, Ty> = new Map();
  private genericsForDecl(params: readonly { name: string }[]): Map<string, Ty> {
    if (this.generics.size > 0) return this.generics;
    return new Map(params.map((p) => [p.name, TY_ERR] as const));
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const BUILTIN_BY_NAME_CAP = "Cap";

function blockTyIsUnit(t: Ty): boolean {
  return t.k === "record" && t.fields.length === 0;
}

function patternName(p: Pattern): string {
  return p.kind === "bind" ? p.name : "<pattern>";
}

function splitLast(path: string): [string, string] | null {
  const i = path.lastIndexOf(".");
  if (i <= 0 || i === path.length - 1) return null;
  return [path.slice(0, i), path.slice(i + 1)];
}

function renderish(t: Ty): string {
  if (t.k === "prim") return t.name;
  if (t.k === "err") return "<error>";
  if (t.k === "named") return t.def < 0 ? `builtin#${t.def}` : `type#${t.def}`;
  return t.k;
}

function variantNamesOf(c: Checker, t: Ty): Set<string> | null {
  const r = deepResolve(deepUnown(t));
  if (r.k === "option") return new Set(["Some", "None"]);
  if (r.k === "result") return new Set(["Ok", "Err"]);
  if (r.k !== "named") return null;
  const info = c.program.typeInfo.get(r.def);
  if (!info || info.form !== "union") return null;
  return new Set(info.fieldNames);
}

function collectVariants(p: Pattern, out: Set<string>, variants: ReadonlySet<string> | null = null): void {
  switch (p.kind) {
    case "unit": out.add(p.path); return;
    case "tuple": out.add(p.path); return;
    case "record": out.add(p.path); return;
    // A bare name that resolved to a variant (see `bindPattern`) covers that variant.
    case "bind": if (variants?.has(p.name)) out.add(p.name); return;
    case "or": p.alts.forEach((a) => collectVariants(a, out, variants)); return;
    case "at": collectVariants(p.sub, out, variants); return;
    case "wildcard": return;
    default: return;
  }
}

/**
 * Element types for a tuple-shaped pattern.
 *
 * Handles three shapes: a real tuple, the `Some`/`None` of an `Option`, and a variant of
 * a user union. `?T` and `Opt[T]` both lower to the builtin `option`, so `Some(x)` and
 * `None` must resolve here or every optional in the corpus fails to destructure.
 */
function tupleOrVariantElems(c: Checker, path: string, valueTy: Ty, span: Span): Ty[] | null {
  valueTy = deepResolve(deepUnown(valueTy));
  if (valueTy.k === "tuple") return valueTy.elems;
  if (valueTy.k === "option") {
    if (path !== "Some") {
      c.error("E0208", "unknown_variant", `\`${path}\` is not a variant of an option`, span);
      return null;
    }
    return [valueTy.inner];
  }
  if (valueTy.k === "result") {
    if (path !== "Ok" && path !== "Err") {
      c.error("E0208", "unknown_variant", `\`${path}\` is not a variant of a Result`, span);
      return null;
    }
    return path === "Ok" ? [valueTy.ok] : [valueTy.err];
  }
  if (valueTy.k !== "named") {
    c.error("E0205", "not_a_tuple", "tuple pattern needs a tuple, option, or variant value", span);
    return null;
  }
  const declUnit = c.program.units.find((u) => u.types.some((t) => t.id === valueTy.def));
  const decl = declUnit?.types.find((t) => t.id === valueTy.def);
  if (decl && decl.def.form === "union") {
    const v = decl.def.variants.find((x) => x.name === path);
    if (!v) {
      c.error("E0208", "unknown_variant", `\`${path}\` is not a variant of \`${decl.def.name}\``, span);
      return null;
    }
    const generics = new Map(decl.def.generics.map((g, i) => [g.name, valueTy.args[i] ?? TY_ERR] as const));
    return v.fields.map((f) => resolveTypeExpr(c, f.ty, generics, declUnit!.module, f.span));
  }
  const fields = c.expand(valueTy.def, valueTy.args);
  return fields ? fields.map((f) => f.ty) : null;
}

function recordOrVariantFields(c: Checker, path: string, valueTy: Ty, span: Span): Map<string, Ty> | null {
  valueTy = deepResolve(deepUnown(valueTy));
  if (valueTy.k !== "named") {
    c.error("E0205", "not_a_record", "record pattern needs a record or variant value", span);
    return null;
  }
  const out = new Map<string, Ty>();
  const declUnit = c.program.units.find((u) => u.types.some((t) => t.id === valueTy.def));
  const decl = declUnit?.types.find((t) => t.id === valueTy.def);
  if (decl && decl.def.form === "union") {
    const v = decl.def.variants.find((x) => x.name === path);
    if (!v) {
      c.error("E0208", "unknown_variant", `\`${path}\` is not a variant of \`${decl.def.name}\``, span);
      return null;
    }
    const generics = new Map(decl.def.generics.map((g, i) => [g.name, valueTy.args[i] ?? TY_ERR] as const));
    for (const f of v.fields) out.set(f.name, resolveTypeExpr(c, f.ty, generics, declUnit!.module, f.span));
    return out;
  }
  const fields = c.expand(valueTy.def, valueTy.args);
  if (!fields) return null;
  for (const f of fields) out.set(f.name, f.ty);
  return out;
}

function iterableElem(c: Checker, raw: Ty, span: Span): Ty {
  const t = deepResolve(deepUnown(raw));
  if (t.k === "slice" || t.k === "array") return t.elem;
  if (t.k === "named" && (t.def === BUILTIN.Text_ || t.def === BUILTIN.Bytes_)) {
    return t.def === BUILTIN.Text_ ? { k: "prim", name: "char" } : { k: "prim", name: "u8" };
  }
  if (t.k === "named" && t.def === BUILTIN.Map) return { k: "tuple", elems: t.args };
  if (t.k === "named" && t.def === BUILTIN.Stream) return t.args[0] ?? TY_ERR;
  if (t.k === "tuple") return t;
  c.error("E0205", "not_iterable", `\`${renderish(t)}\` cannot be iterated`, span);
  return TY_ERR;
}

function typeMatchesNominal(c: Checker, base: Ty, typeName: string): boolean {
  const def = c.program.resolveType(typeName, c.moduleFor({ start: 0, end: 0, file: -1 }));
  if (def === null) return false;
  if (base.k !== "named") return false;
  return base.def === def;
}
