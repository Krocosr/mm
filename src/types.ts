/**
 * MM — semantic type representation and unification.
 *
 * `Ty` is the resolved type. `TypeExpr` (in ast.ts) is the surface syntax; the type
 * checker converts one into the other. Every later pass — ownership, effects, System IR,
 * the semantic graph, the interpreter — reads `Ty`, never `TypeExpr`.
 *
 * See docs/spec/kernel.md §3.
 */

import type { Ownership, PrimitiveName } from "./ast.ts";

export type Ty =
  | { k: "prim"; name: PrimitiveName }
  /** A resolved named type: user-defined or builtin, by definition id. */
  | { k: "named"; def: number; args: Ty[] }
  | { k: "record"; fields: TyField[] }
  | { k: "tuple"; elems: Ty[] }
  | { k: "slice"; elem: Ty }
  | { k: "array"; elem: Ty; len: number }
  | { k: "option"; inner: Ty }
  | { k: "result"; ok: Ty; err: Ty }
  | { k: "ptr"; mutable: boolean; inner: Ty }
  /**
   * An ownership discipline. `resourceOf` names the `@resource` definition this value
   * ultimately is, when there is one. Alias expansion (`type File = Handle<Fd>`) erases
   * the name, and without this the ownership pass would see only a copyable handle and
   * let a resource be copied — running its close path twice.
   */
  | { k: "own"; ownership: Ownership; inner: Ty; resourceOf?: number }
  | { k: "fnptr"; params: Ty[]; ret: Ty; effects: readonly string[] }
  /** A generic variable, resolved by unification. `bound` is set once substituted. */
  | { k: "var"; id: number; name: string; bound: Ty | null }
  /** Result of a failed check. Unifies with anything, prints as `<error>`. */
  | { k: "err" };

export interface TyField {
  name: string;
  ty: Ty;
  attrs: readonly string[];
}

type Of<K extends Ty["k"]> = Extract<Ty, { k: K }>;

/**
 * Re-pair two `Ty` values known to share a discriminant.
 *
 * TypeScript cannot correlate two independently-narrowed discriminants, so a `switch`
 * over `x.k` leaves `y` at its union type. This is the single place that bridges that:
 * the caller has already established `x.k === y.k`, so the assertion is sound and the
 * rest of the module can be written without casts.
 */
function sameKind<K extends Ty["k"]>(k: K, x: Ty, y: Ty): [Of<K>, Of<K>] {
  return [x as Of<K>, y as Of<K>];
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const TY_ERR: Ty = { k: "err" };
export const TY_UNIT: Ty = { k: "record", fields: [] };

export function prim(name: PrimitiveName): Ty {
  return { k: "prim", name };
}
export function owned(inner: Ty): Ty {
  return { k: "own", ownership: "owned", inner };
}
export function view(inner: Ty): Ty {
  return { k: "own", ownership: "view", inner };
}
export function option(inner: Ty): Ty {
  return { k: "option", inner };
}
export function result(ok: Ty, err: Ty): Ty {
  return { k: "result", ok, err };
}

/**
 * Strip *borrow* wrappers to reach the underlying value type.
 *
 * Only `view`, `viewmut` and `handle` are stripped. `shared` and `arena` are stripped
 * too, because reading a field through them reads the pointee — but the distinction
 * matters: removing them here is safe only because callers that need the ownership
 * information (the ownership pass) read the original type, not this one. Stripping
 * everything unconditionally made `shared Node` and `Node` indistinguishable, so a
 * `shared` handle could be passed where an owned value was expected and vice versa.
 */
export function unown(t: Ty): Ty {
  let cur = t;
  while (cur.k === "own" && (cur.ownership === "view" || cur.ownership === "viewmut" || cur.ownership === "handle")) {
    cur = cur.inner;
  }
  return cur;
}

/**
 * Strip *every* ownership wrapper, including `shared` and `arena`.
 *
 * Use this only where the pointee is genuinely what matters — field projection through a
 * `shared` handle, for instance. Using `unown` where this is meant loses the distinction
 * between an owned and a shared value.
 */
export function deepUnown(t: Ty): Ty {
  let cur = t;
  while (cur.k === "own") cur = cur.inner;
  return cur;
}

// ---------------------------------------------------------------------------
// Builtin type-definition ids
// ---------------------------------------------------------------------------

/**
 * Builtin types occupy a fixed id block below every user definition id, so a `Ty` can
 * reference them without the program having been loaded. Ids are negative and stable
 * across runs; the semantic graph hashes them by name, never by id.
 */
export const BUILTIN = {
  Result: -1,
  Opt: -2,
  Map: -3,
  Set: -4,
  Decision: -5,
  Untrusted: -6,
  Verified: -7,
  Cap: -8,
  Stream: -9,
  Context: -10,
  Handle: -11,
  Bytes_: -12,
  Ticket: -13,
  IoErr: -14,
  NetErr: -15,
  Text_: -16,
  ProviderId: -17,
  ModelId: -18,
} as const;

export type BuiltinName = keyof typeof BUILTIN;

export const BUILTIN_BY_ID: Record<number, BuiltinName> = Object.fromEntries(
  Object.entries(BUILTIN).map(([name, id]) => [id, name as BuiltinName]),
);

export function isBuiltin(id: number): boolean {
  return id < 0;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Numeric tower used for literal defaulting and binary-op checking (kernel.md §3.1). */
export const NUMERIC_RANK: Record<string, number> = {
  u8: 0, i8: 0, u16: 1, i16: 1, u32: 2, i32: 2, u64: 3, i64: 3, usize: 3, isize: 3,
  f32: 4, f64: 5,
};

/**
 * Whether a type can participate in arithmetic.
 *
 * An unbound integer-literal variable counts: it exists precisely so that `0 + n` can
 * adopt `n`'s type, and rejecting it here would make every literal-seeded accumulator an
 * error. Once bound it resolves to a concrete integer and is judged on its merits.
 */
export function isNumeric(t: Ty): boolean {
  if (t.k === "var") return t.bound === null || isNumeric(t.bound);
  return t.k === "prim" && NUMERIC_RANK[t.name] !== undefined;
}
export function isFloat(t: Ty): boolean {
  if (t.k === "var") return t.bound === null || isFloat(t.bound);
  return t.k === "prim" && (t.name === "f32" || t.name === "f64");
}
export function isInteger(t: Ty): boolean {
  if (t.k === "var") return t.bound === null || isInteger(t.bound);
  return t.k === "prim" && NUMERIC_RANK[t.name] !== undefined && !isFloat(t);
}
/** `Bytes`/`Text`/`Path` hold heap storage and are therefore never Copy. */
export function isTriviallyCopyablePrim(name: PrimitiveName): boolean {
  return name !== "Text" && name !== "Bytes" && name !== "Path";
}

// ---------------------------------------------------------------------------
// Substitution / resolution
// ---------------------------------------------------------------------------

/** Follow a type variable's binding chain to its concrete type. */
export function shallowResolve(t: Ty): Ty {
  let cur = t;
  while (cur.k === "var" && cur.bound) cur = cur.bound;
  return cur;
}

/** Fully resolve nested type variables in a type. */
export function deepResolve(t: Ty, seen: Set<number> = new Set()): Ty {
  const r = shallowResolve(t);
  switch (r.k) {
    case "own":
      return { ...r, inner: deepResolve(r.inner, seen) };
    case "ptr":
      return { ...r, inner: deepResolve(r.inner, seen) };
    case "option":
      return { ...r, inner: deepResolve(r.inner, seen) };
    case "slice":
      return { ...r, elem: deepResolve(r.elem, seen) };
    case "array":
      return { ...r, elem: deepResolve(r.elem, seen) };
    case "result":
      return { ...r, ok: deepResolve(r.ok, seen), err: deepResolve(r.err, seen) };
    case "tuple":
      return { ...r, elems: r.elems.map((e) => deepResolve(e, seen)) };
    case "record":
      return { ...r, fields: r.fields.map((f) => ({ ...f, ty: deepResolve(f.ty, seen) })) };
    case "named":
      return { ...r, args: r.args.map((a) => deepResolve(a, seen)) };
    case "fnptr":
      return { ...r, params: r.params.map((p) => deepResolve(p, seen)), ret: deepResolve(r.ret, seen) };
    case "var": {
      if (!r.bound) return r;
      if (seen.has(r.id)) return TY_ERR;
      seen.add(r.id);
      return deepResolve(r.bound, seen);
    }
    default:
      return r;
  }
}

// ---------------------------------------------------------------------------
// Unification
// ---------------------------------------------------------------------------

export interface UnifyMismatch {
  expected: Ty;
  actual: Ty;
  reason: string;
}

/**
 * Unify `a` and `b`, binding type variables into `subst`.
 *
 * Returns a mismatch description instead of throwing: every failure site wants to attach
 * its own span and its own repair candidates (kernel.md §10).
 */
export function unify(a: Ty, b: Ty, subst: Map<number, Ty>): UnifyMismatch | null {
  const x = apply(a, subst);
  const y = apply(b, subst);
  if (x.k === "err" || y.k === "err") return null;
  if (x.k === "var") return bind(x, y, subst);
  if (y.k === "var") return bind(y, x, subst);
  // A fixed-size array and a slice are the same value at run time — both are
  // `k:"slice"` — so the type-level distinction cannot be enforced by anything, and
  // enforcing it anyway only produces false rejections on programs the interpreter
  // runs. Compare them as slices and let the element type decide. The `len` is
  // dropped: nothing downstream can observe it.
  if (x.k === "array" && y.k === "slice") return unify(x.elem, y.elem, subst);
  if (x.k === "slice" && y.k === "array") return unify(x.elem, y.elem, subst);
  if (x.k !== y.k) return { expected: x, actual: y, reason: `expected ${x.k}, found ${y.k}` };

  switch (x.k) {
    case "prim": {
      const [xp, yp] = sameKind("prim", x, y);
      return xp.name === yp.name
        ? null
        : { expected: xp, actual: yp, reason: `expected \`${xp.name}\`, found \`${yp.name}\`` };
    }
    case "own": {
      const [xo, yo] = sameKind("own", x, y);
      return unify(xo.inner, yo.inner, subst);
    }
    case "ptr": {
      const [xp, yp] = sameKind("ptr", x, y);
      if (xp.mutable !== yp.mutable) {
        return { expected: xp, actual: yp, reason: `expected \`*${xp.mutable ? "mut" : "const"} T\`` };
      }
      return unify(xp.inner, yp.inner, subst);
    }
    case "option": {
      const [xo, yo] = sameKind("option", x, y);
      return unify(xo.inner, yo.inner, subst);
    }
    case "slice": {
      const [xs, ys] = sameKind("slice", x, y);
      return unify(xs.elem, ys.elem, subst);
    }
    case "array": {
      const [xa, ya] = sameKind("array", x, y);
      if (xa.len !== ya.len) {
        return { expected: xa, actual: ya, reason: `array length ${xa.len} does not match ${ya.len}` };
      }
      return unify(xa.elem, ya.elem, subst);
    }
    case "result": {
      const [xr, yr] = sameKind("result", x, y);
      return unify(xr.ok, yr.ok, subst) ?? unify(xr.err, yr.err, subst);
    }
    case "tuple": {
      const [xt, yt] = sameKind("tuple", x, y);
      if (xt.elems.length !== yt.elems.length) {
        return { expected: xt, actual: yt, reason: `tuple arity ${xt.elems.length} does not match ${yt.elems.length}` };
      }
      for (let i = 0; i < xt.elems.length; i++) {
        const m = unify(xt.elems[i]!, yt.elems[i]!, subst);
        if (m) return m;
      }
      return null;
    }
    case "record": {
      const [xr, yr] = sameKind("record", x, y);
      if (xr.fields.length !== yr.fields.length) {
        return { expected: xr, actual: yr, reason: "record field count differs" };
      }
      for (const f of xr.fields) {
        const g = yr.fields.find((c) => c.name === f.name);
        if (!g) return { expected: xr, actual: yr, reason: `missing field \`${f.name}\`` };
        const m = unify(f.ty, g.ty, subst);
        if (m) return m;
      }
      return null;
    }
    case "named": {
      const [xn, yn] = sameKind("named", x, y);
      if (xn.def !== yn.def) {
        return { expected: xn, actual: yn, reason: "different type constructors" };
      }
      if (xn.args.length !== yn.args.length) {
        return { expected: xn, actual: yn, reason: `generic arity ${xn.args.length} vs ${yn.args.length}` };
      }
      for (let i = 0; i < xn.args.length; i++) {
        const m = unify(xn.args[i]!, yn.args[i]!, subst);
        if (m) return m;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Bind a type variable to a type.
 *
 * The binding is written onto the variable itself as well as into `subst`, because
 * `deepResolve` — which every later pass uses — follows `bound`, not the map. Recording
 * it only in `subst` made every unification invisible downstream, so inference appeared
 * to do nothing.
 */
function bind(v: Of<"var">, other: Ty, subst: Map<number, Ty>): UnifyMismatch | null {
  if (other.k === "var" && other.id === v.id) return null;
  // Occurs check: binding `T` to a type that contains `T` would make resolution loop.
  if (freeVars(other).includes(v.id)) {
    return { expected: v, actual: other, reason: "recursive type binding" };
  }
  v.bound = shallowResolve(other);
  subst.set(v.id, v.bound);
  return null;
}

/** Resolve type variables in `t` using `subst`, without mutating `t`. */
export function apply(t: Ty, subst: ReadonlyMap<number, Ty>): Ty {
  if (subst.size === 0) return t;
  return deepResolve(t);
}

// ---------------------------------------------------------------------------
// Copy-ness (kernel.md §3.4 R-Own-2)
// ---------------------------------------------------------------------------

/**
 * Whether a value of this type may be copied rather than moved.
 *
 * A type is Copy when every one of its fields is Copy and it holds no heap handle
 * (`Text`, `Bytes`, `Path`, slices, `shared`). A structural `T` type variable is treated
 * as *not* Copy: copying a generic value must be proven by a `Copy` bound, not assumed,
 * or instantiating a generic with a non-Copy type would silently become non-affine.
 */
export function isCopy(
  t: Ty,
  /** Resolves a named type id to its field list, or null when opaque. */
  expand: (def: number, args: Ty[]) => TyField[] | null,
  seen: Set<number> = new Set(),
): boolean {
  const r = shallowResolve(t);
  switch (r.k) {
    case "err":
      return true;
    case "var":
      return false;
    case "prim":
      return isTriviallyCopyablePrim(r.name);
    case "ptr":
      return true;
    case "own":
      // A borrow or a handle is a value, not an owner: it never moves out of its owner.
      if (r.ownership === "view" || r.ownership === "viewmut" || r.ownership === "handle") return true;
      if (r.ownership === "shared") return false;
      return isCopy(r.inner, expand, seen);
    case "tuple":
      return r.elems.every((e) => isCopy(e, expand, seen));
    case "array":
      return isCopy(r.elem, expand, seen);
    case "record":
      return r.fields.every((f) => isCopy(f.ty, expand, seen));
    case "slice":
      return false;
    case "option":
      return isCopy(r.inner, expand, seen);
    case "result":
      return isCopy(r.ok, expand, seen) && isCopy(r.err, expand, seen);
    case "fnptr":
      return true;
    case "named": {
      if (seen.has(r.def)) return false;
      seen.add(r.def);
      if (
        r.def === BUILTIN.Text_ || r.def === BUILTIN.Bytes_ ||
        r.def === BUILTIN.Stream || r.def === BUILTIN.Context
      ) return false;
      // A handle is (index, generation) — two integers.
      if (r.def === BUILTIN.Handle) return true;
      const fields = expand(r.def, r.args);
      if (fields === null) return false;
      return fields.every((f) => isCopy(f.ty, expand, seen));
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Free variables
// ---------------------------------------------------------------------------

/** Type variables appearing in `t` that are not yet bound. */
export function freeVars(t: Ty, out: number[] = [], seen: Set<number> = new Set()): number[] {
  const r = shallowResolve(t);
  switch (r.k) {
    case "var":
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r.id); }
      return out;
    case "own":
    case "ptr":
    case "option":
      return freeVars(r.inner, out, seen);
    case "slice":
    case "array":
      return freeVars(r.elem, out, seen);
    case "result":
      freeVars(r.ok, out, seen);
      return freeVars(r.err, out, seen);
    case "tuple":
      r.elems.forEach((e) => freeVars(e, out, seen));
      return out;
    case "record":
      r.fields.forEach((f) => freeVars(f.ty, out, seen));
      return out;
    case "named":
      r.args.forEach((a) => freeVars(a, out, seen));
      return out;
    case "fnptr":
      r.params.forEach((p) => freeVars(p, out, seen));
      return freeVars(r.ret, out, seen);
    default:
      return out;
  }
}

// ---------------------------------------------------------------------------
// Rendering (agent-facing; never a parse target — the graph is the parse target)
// ---------------------------------------------------------------------------

const MIN_WIDTH: Record<string, number> = { u8: 1, i8: 1, bool: 1, char: 4, u16: 2, i16: 2 };

/** Canonical, stable textual form of a resolved type. Used in semantic packets. */
export function renderTy(t: Ty, defName: (id: number) => string | null): string {
  const r = shallowResolve(t);
  switch (r.k) {
    case "err":
      return "<error>";
    case "prim":
      return r.name;
    case "var":
      return r.bound ? renderTy(r.bound, defName) : r.name;
    case "record":
      return r.fields.length === 0 ? "{}" : `{${r.fields.map((f) => `${f.name}:${renderTy(f.ty, defName)}`).join(",")}}`;
    case "tuple":
      return `(${r.elems.map((e) => renderTy(e, defName)).join(",")})`;
    case "slice":
      return `[${renderTy(r.elem, defName)}]`;
    case "array":
      return `[${renderTy(r.elem, defName)};${r.len}]`;
    case "option":
      return `${renderTy(r.inner, defName)}?`;
    case "result":
      return `Result<${renderTy(r.ok, defName)},${renderTy(r.err, defName)}>`;
    case "ptr":
      return `*${r.mutable ? "mut" : "const"} ${renderTy(r.inner, defName)}`;
    case "own": {
      const inner = renderTy(r.inner, defName);
      if (r.ownership === "owned") return inner;
      // `Handle<T>` is the source spelling of the `handle` discipline; printing
      // `handle T` would not round-trip back to the same source.
      if (r.ownership === "handle") return `Handle<${inner}>`;
      return `${r.ownership} ${inner}`;
    }
    case "fnptr":
      return `fn(${r.params.map((p) => renderTy(p, defName)).join(",")})->${renderTy(r.ret, defName)}`;
    case "named": {
      const name = defName(r.def) ?? `T${r.def}`;
      return r.args.length ? `${name}<${r.args.map((a) => renderTy(a, defName)).join(",")}>` : name;
    }
    default:
      return "<error>";
  }
}
