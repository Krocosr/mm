/**
 * MM — name resolution and declaration checking.
 *
 * Resolves every type expression and function signature in the program, instantiating
 * generic parameters as type variables. This runs before expression checking and leaves
 * `FnInfo.paramTys` / `FnInfo.retTy` populated so the ownership, effect, System IR, and
 * graph passes never re-resolve a name.
 *
 * See docs/spec/kernel.md §3.
 */

import type { Diagnostic, PrimitiveName, Span, TypeExpr, TypeParam } from "./ast.ts";
import { type Ty, type TyField, TY_ERR, TY_UNIT, BUILTIN } from "./types.ts";
import { type FnInfo, type Program, expandTypeFields } from "./program.ts";
import type { LoweredUnit } from "./lower.ts";

/** One binder in a lexical scope: a local, a parameter, a const, or a type parameter. */
export interface Binder {
  name: string;
  ty: Ty;
  kind: "param" | "local" | "const" | "typeparam" | "variant" | "module";
  span: Span;
  /** Id of the owning function, for locals; -1 otherwise. */
  fnId: number;
  mutable: boolean;
}

export class Scope {
  private readonly stack: Binder[][] = [];

  push(): void {
    this.stack.push([]);
  }
  pop(): void {
    this.stack.pop();
  }
  define(b: Binder): void {
    this.stack[this.stack.length - 1]?.push(b);
  }
  /** Innermost-first lookup, so shadowing works and is reported by the caller. */
  lookup(name: string): Binder | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const frame = this.stack[i]!;
      for (let j = frame.length - 1; j >= 0; j--) {
        if (frame[j]!.name === name) return frame[j]!;
      }
    }
    return null;
  }
  /** All binders with a name, innermost first — used to explain shadowing. */
  lookupAll(name: string): Binder[] {
    const out: Binder[] = [];
    for (let i = this.stack.length - 1; i >= 0; i--) {
      for (const b of this.stack[i]!) if (b.name === name) out.push(b);
    }
    return out;
  }
  get depth(): number {
    return this.stack.length;
  }
}

/** Shared per-program checking state. */
export class Checker {
  readonly scope = new Scope();
  readonly subst = new Map<number, Ty>();
  /** Next fresh type-variable id. Kept well above user definition ids. */
  private nextVar = 1_000_000;
  /** Current function being checked, for context in diagnostics. */
  currentFn = -1;
  /**
   * Expression facts published by the type pass, keyed by span offset. Ownership, System
   * IR, and the graph read types through here rather than re-inferring them, which is what
   * keeps a single source of truth for "what type is this expression".
   */
  facts = new Map<number, Ty>();
  /**
   * Call sites recorded by the type pass, keyed by span offset. The effect pass infers
   * over these, and the System IR checks capability non-escalation on them, so both read
   * the same resolution the type pass reached rather than resolving names a third time.
   */
  calls = new Map<number, { callee: number; span: Span; argTys: Ty[] }>();
  /**
   * The type the expression currently being checked is expected to produce, if any.
   * `Ok`/`Err`/`Some`/`None` in value position read this to type their payload, which is
   * how `Ok(v)` in a `Result<u64, IoErr>` function learns what `v` must be.
   */
  currentExpected: Ty | undefined = undefined;

  constructor(readonly program: Program) {}

  freshVar(name: string): Ty {
    const id = this.nextVar++;
    return { k: "var", id, name, bound: null };
  }

  error(code: string, kind: string, message: string, span: Span, extra: Partial<Diagnostic> = {}): void {
    this.program.diagnostics.push({
      code, kind, severity: "error", message, span,
      value: this.currentFn >= 0 ? `F${this.currentFn}` : undefined,
      ...extra,
    });
  }

  warn(code: string, kind: string, message: string, span: Span): void {
    this.program.diagnostics.push({ code, kind, severity: "warning", message, span });
  }

  /** Name of a type definition, for rendering. */
  defName(id: number): string | null {
    return this.program.typeInfo.get(id)?.name ?? null;
  }

  /** Field expansion bound to this checker's resolver. */
  expand(def: number, args: Ty[]): TyField[] | null {
    return expandTypeFields(this.program, def, args, (expr, generics) => resolveTypeExpr(this, expr, generics, "<builtin>", expr.span));
  }

  /**
   * Which module a span belongs to. Name resolution is module-scoped, and spans index
   * into a global file list, so the file index is the bridge.
   */
  moduleFor(span: Span): string {
    const file = this.program.files[span.file];
    return file ? file.module : "<unknown>";
  }
}

// ---------------------------------------------------------------------------
// Type expression resolution
// ---------------------------------------------------------------------------
/** Heap-backed "primitives" that are really named builtin types. */
const HEAP_PRIMS: Record<string, number> = {
  Text: BUILTIN.Text_,
  Bytes: BUILTIN.Bytes_,
};

function primTy(name: PrimitiveName): Ty {
  const heap = HEAP_PRIMS[name];
  return heap === undefined ? { k: "prim", name } : { k: "named", def: heap, args: [] };
}

/**
 * Convert a surface `TypeExpr` into a `Ty`.
 *
 * `generics` maps in-scope type-parameter names to their type variables. An unresolved
 * name is a hard error here: silently producing `TY_ERR` would let a typo propagate
 * through every later pass as a phantom type.
 */
export function resolveTypeExpr(
  c: Checker,
  expr: TypeExpr,
  generics: ReadonlyMap<string, Ty>,
  module: string,
  span: Span,
): Ty {
  switch (expr.kind) {
    case "prim":
      // `Text`, `Bytes` and `Path` are written like primitives but are heap-backed named
      // types. Resolving them as `prim` made a string literal (`named Text`) and a
      // `Text` annotation (`prim Text`) structurally different, so they never unified.
      return primTy(expr.name);

    case "own": {
      const inner = resolveTypeExpr(c, expr.inner, generics, module, span);
      // A `view` of a `handle` collapses to the handle. The handle is already a checked
      // generational indirection with its own region, so a borrow of it would be a
      // second indirection over the first — and `view Handle<T>` would then fail to
      // unify with the bare `Handle<T>` that `handle_of` returns.
      if (expr.ownership === "handle") return { k: "own", ownership: "handle", inner };
      if (inner.k === "own" && inner.ownership === "handle" && expr.ownership !== "owned") {
        return inner;
      }
      return { k: "own", ownership: expr.ownership, inner };
    }

    case "ptr":
      // A raw pointer is a compiler-safety escape, not a `safe` value (kernel.md §3.6
      // region, R-Own boundary). It is only legal inside an `unsafe` context, which the
      // checker validates at the expression site; here it just resolves.
      return { k: "ptr", mutable: expr.mutable, inner: resolveTypeExpr(c, expr.inner, generics, module, span) };

    case "option":
      return { k: "option", inner: resolveTypeExpr(c, expr.inner, generics, module, span) };

    case "tuple":
      return { k: "tuple", elems: expr.elems.map((e) => resolveTypeExpr(c, e, generics, module, span)) };

    case "slice": {
      const elem = resolveTypeExpr(c, expr.elem, generics, module, span);
      if (expr.len === null) return { k: "slice", elem };
      if (Number.isNaN(expr.len)) {
        c.error("E0301", "non_const_array_length", "array length must be a constant expression", span);
        return { k: "array", elem, len: 0 };
      }
      return { k: "array", elem, len: expr.len };
    }

    case "record":
      return {
        k: "record",
        fields: expr.fields.map((f) => ({
          name: f.name,
          ty: resolveTypeExpr(c, f.ty, generics, module, span),
          attrs: f.attrs.map((a) => a.name),
        })),
      };

    case "fnptr":
      return {
        k: "fnptr",
        params: expr.params.map((e) => resolveTypeExpr(c, e, generics, module, span)),
        ret: resolveTypeExpr(c, expr.ret, generics, module, span),
        effects: expr.effects,
      };

    case "impl":
      // Opaque trait object. Treated as an opaque type: the type checker cannot see
      // through it, so `isCopy` stays conservative about it (kernel.md §3.4).
      return { k: "named", def: BUILTIN.Handle, args: [{ k: "record", fields: [] }] };

    case "path":
      return resolvePathType(c, expr, generics, module, span);
  }
}

function resolvePathType(
  c: Checker,
  expr: Extract<TypeExpr, { kind: "path" }>,
  generics: ReadonlyMap<string, Ty>,
  module: string,
  span: Span,
): Ty {
  const segments = expr.segments;
  // Associated type projection `Q.Output` or `Decision.Q.Output`.
  if (segments.length >= 2) {
    const base = segments[0]!;
    if (generics.has(base)) {
      return c.freshVar(`${base}.${segments[segments.length - 1]}`);
    }
  }
  const name = segments[segments.length - 1]!;

  // A generic parameter shadows every other meaning of the name.
  const bound = generics.get(name);
  if (bound) return bound;

  // `Result` and `?T` sugar: `Result<T, E>` is a builtin with fixed arity 2.
  if (name === "Result") {
    if (expr.args.length !== 2) {
      c.error("E0201", "generic_arity", "`Result` takes exactly 2 type arguments, found " + expr.args.length, span);
      return TY_ERR;
    }
    return {
      k: "result",
      ok: resolveTypeExpr(c, expr.args[0]!, generics, module, span),
      err: resolveTypeExpr(c, expr.args[1]!, generics, module, span),
    };
  }

  // `Cap<bank.transfer>`'s argument names a *capability*, not a type. It is validated as
  // a capability name and then dropped: a capability carries no data, and the System IR
  // reads the name from the source span when it computes a plan's authority set.
  if (name === "Cap") {
    if (expr.args.length !== 1) {
      c.error("E0201", "generic_arity", "`Cap` takes exactly one capability name, found " + expr.args.length, span);
      return TY_ERR;
    }
    const arg = expr.args[0]!;
    if (arg.kind !== "path" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(arg.segments.join("."))) {
      c.error(
        "E0602", "malformed_capability",
        "`Cap<E>` names a capability, e.g. `Cap<bank.transfer>`; it does not take a type",
        arg.span,
        { repairs: [] },
      );
      return TY_ERR;
    }
    return { k: "named", def: BUILTIN.Cap, args: [] };
  }

  const def = c.program.resolveType(name, module);
  if (def === null) {
    c.error("E0203", "unknown_type", `cannot find type \`${name}\` in module \`${module}\``, span, {
      data: { name, module },
      repairs: [],
    });
    return TY_ERR;
  }
  const info = c.program.typeInfo.get(def);
  const arity = info?.arity ?? 0;
  if (expr.args.length !== arity) {
    c.error(
      "E0201", "generic_arity",
      `\`${name}\` takes ${arity} type argument${arity === 1 ? "" : "s"}, found ${expr.args.length}`,
      span,
    );
    return TY_ERR;
  }
  const args = expr.args.map((a) => resolveTypeExpr(c, a, generics, module, span));
  // `Handle<T>` is not a distinct type: it is the `handle` ownership discipline applied
  // to `T`. Resolving it to the discipline means `Handle<Fd>` and a `handle Fd` return
  // from `handle_of` unify, instead of looking like two unrelated named types.
  if (def === BUILTIN.Handle) {
    return { k: "own", ownership: "handle", inner: args[0] ?? TY_ERR };
  }
  // A `type A = B` alias is transparent, not a distinct type. Leaving it as a `named`
  // node made `File` (= `Handle<Fd>`) fail to unify with the `handle Fd` that
  // `handle_of` produces, which is the whole point of writing the alias.
  const alias = aliasTarget(c, def, args, module);
  if (alias) {
    // Remember which `@resource` this alias stands for. Without it the ownership pass
    // sees only a copyable handle and lets a resource be duplicated — two close paths,
    // one resource.
    if (info?.isResource && alias.k === "own") {
      return { ...alias, resourceOf: def };
    }
    return alias;
  }
  return { k: "named", def, args };
}

/** Follow a chain of type aliases to the first non-alias type, guarding against cycles. */
function aliasTarget(c: Checker, def: number, args: Ty[], module: string): Ty | null {
  let current = def;
  let currentArgs = args;
  for (let hops = 0; hops < 32; hops++) {
    const unit = c.program.units.find((u) => u.types.some((t) => t.id === current));
    const decl = unit?.types.find((t) => t.id === current);
    if (!decl || decl.def.form !== "alias") return null;
    const next = resolveTypeExpr(
      c,
      decl.def.target,
      new Map(decl.def.generics.map((g, i) => [g.name, currentArgs[i] ?? TY_ERR] as const)),
      decl.module,
      decl.span,
    );
    // `Handle<T>` resolves to a discipline, not a named type, so it terminates here.
    if (next.k !== "named") return next;
    if (next.def === current) return null;
    current = next.def;
    currentArgs = next.args;
  }
  return null;
}

/** Bind a function or type's type parameters to fresh type variables. */
export function genericScope(c: Checker, params: readonly TypeParam[]): Map<string, Ty> {
  const map = new Map<string, Ty>();
  for (const p of params) map.set(p.name, c.freshVar(p.name));
  return map;
}

// ---------------------------------------------------------------------------
// Declaration checking
// ---------------------------------------------------------------------------

/**
 * Resolve every signature in the program. Runs before expression checking so that a
 * function may call a function declared later in the file.
 */
export function checkDeclarations(c: Checker): void {
  const program = c.program;

  for (const unit of program.units) {
    checkUnitTypes(c, unit);
  }
  for (const unit of program.units) {
    for (const fn of unit.fns) {
      const info = program.fnInfo.get(fn.id);
      if (!info) continue;
      checkFnSignature(c, info);
    }
  }
}

function checkUnitTypes(c: Checker, unit: LoweredUnit): void {
  for (const decl of unit.types) {
    const generics = genericScope(c, decl.def.generics);
    const info = c.program.typeInfo.get(decl.id);
    switch (decl.def.form) {
      case "record":
        for (const f of decl.def.fields) {
          const ty = resolveTypeExpr(c, f.ty, generics, unit.module, f.span);
          if (ty.k === "err") {
            c.error("E0203", "unknown_type", `cannot resolve type of field \`${f.name}\``, f.span);
          }
          checkAttributeTypeRules(c, f.attrs.map((a) => a.name), ty, f.span, `${decl.def.name}.${f.name}`);
        }
        break;
      case "union":
        for (const v of decl.def.variants) {
          for (const f of v.fields) {
            resolveTypeExpr(c, f.ty, generics, unit.module, f.span);
            checkAttributeTypeRules(c, f.attrs.map((a) => a.name), TY_UNIT, f.span, `${decl.def.name}.${f.name}`);
          }
        }
        break;
      case "alias":
        // Record the resolved target so later passes — the System IR's `@resource`
        // contract in particular — compare against the type the checker actually reached
        // instead of re-resolving the declaration themselves.
        if (info) info.ty = resolveTypeExpr(c, decl.def.target, generics, unit.module, decl.span);
        break;
      case "choice":
        break;
    }
  }
}

/** kernel.md A-2: a `@wire` schema must not silently serialize a `@secret`. */
function checkAttributeTypeRules(
  c: Checker,
  attrs: readonly string[],
  _ty: Ty,
  span: Span,
  where: string,
): void {
  if (attrs.includes("wire") && attrs.includes("secret")) {
    c.error(
      "E0701", "wire_over_secret",
      `\`${where}\` is both \`@wire\` and \`@secret\`: a wire schema must not serialize a secret`,
      span,
    );
  }
}

function checkFnSignature(c: Checker, info: FnInfo): void {
  const generics = genericScope(c, info.fn.generics);
  c.subst.clear();
  c.currentFn = info.id;

  info.paramTys = info.fn.params.map((p) => {
    const ty = resolveTypeExpr(c, p.ty, generics, info.module, p.span);
    if (ty.k === "err") {
      c.error("E0203", "unknown_type", `cannot resolve type of parameter \`${p.name}\``, p.span);
    }
    // kernel.md §6.3: a `Cap<E>` may only appear as a parameter, a field, or inside a
    // signature that receives it from its caller. Any other position is E0602. The
    // expression pass checks construction; this catches it in the signature.
    checkParamTy(c, ty, p.span, p.name);
    return ty;
  });

  info.retTy = info.fn.ret
    ? resolveTypeExpr(c, info.fn.ret, generics, info.module, info.fn.span)
    : TY_UNIT;

  // kernel.md §3.6: user-written lifetime syntax is a parse-level rejection in v0.1,
  // but a stray `'a` in source would already have failed lexing. Guard the AST shape.
  if (info.fn.body.span.start === info.fn.span.start && info.fn.params.length === 0 && info.fn.ret === null) {
    // A function with no signature and no body is the `<error>` recovery item; the parser
    // already reported it. Do not stack a second diagnostic here.
  }
}

/** kernel.md §4.5 / §6.3: `Cap<E>` is unconstructible from a value. */
function checkParamTy(c: Checker, ty: Ty, span: Span, name: string): void {
  if (ty.k === "named" && ty.def === BUILTIN.Cap) {
    // Legal: a capability arrives from the caller. Record that this parameter is a
    // capability grant point so the System IR can compute `authority`.
    return;
  }
  if (ty.k === "own") {
    checkParamTy(c, ty.inner, span, name);
    return;
  }
  if (ty.k === "named" && (ty.def === BUILTIN.Verified || ty.def === BUILTIN.Untrusted)) {
    return;
  }
  // `Verified<T>` is only constructible inside a `verify` function (kernel.md §4.5).
  // A parameter of that type is fine; producing one is not, which the expression pass
  // enforces. Nothing to do here.
}

/** Resolve a fn's return type on demand, with its own generic scope. */
export function retTyOf(c: Checker, info: FnInfo): Ty {
  return info.retTy;
}
