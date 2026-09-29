/**
 * MM — the runtime value model.
 *
 * Values are a tagged union discriminated on `k`. Two deliberate choices:
 *
 * - **Integers are `bigint`.** `u64` does not fit in a JS number exactly, and MM's
 *   integer tower reaches 64 bits, so a `number`-backed integer would silently
 *   lose precision. Floats stay `number`.
 * - **Floats compare by bit pattern** (`floatEqBit`), which keeps compile-time
 *   evaluation total: `NaN == NaN` and `+0 != -0` instead of IEEE surprise
 *   (kernel.md §8 determinism).
 */

import type { Diagnostic, Span } from "../ast.ts";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type Value =
  | { k: "int"; v: bigint }
  | { k: "float"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "char"; v: string }
  | { k: "text"; v: string }
  | { k: "bytes"; v: Uint8Array }
  | { k: "unit" }
  | { k: "tuple"; elems: Value[] }
  | { k: "record"; name: string | null; fields: Record<string, Value> }
  /** A union variant / `Ok` / `Some` … the payload is a record for named fields. */
  | { k: "variant"; name: string; type: string | null; payload: Value }
  /** `len` is a live view of `elems.length`, never a captured copy. */
  | { k: "slice"; elems: Value[]; readonly len: number }
  | { k: "map"; entries: Map<string, { key: Value; val: Value }> }
  | { k: "set"; entries: Map<string, Value> }
  /** R-Own-6: explicit reference-counted ownership. */
  | { k: "shared"; id: number; value: Value; rc: number; atomic: boolean }
  /** R-Own-7: arena-allocated; invalid when its arena dies. */
  | { k: "arena"; arena: number; index: number; generation: number }
  /** R-Own-8: generational handle. The one run-time ownership check (`E0416`). */
  | { k: "handle"; store: number; index: number; generation: number }
  /** R-Own-9: `@resource(close = f)`. Closed exactly once. */
  | { k: "resource"; type: string; payload: Value; closed: boolean; closeFn: string | null }
  /** The builtin `Decision<T>` record. */
  | {
    k: "decision"; value: Value; confidence: number; provider: string; model: string;
    inputHash: string;
  }
  /** A borrow of a place. Views are not owned; they read and write through. */
  | { k: "view"; mutable: boolean; cell: Cell }
  /** A function value. */
  | { k: "fn"; id: number; name: string };

// ---------------------------------------------------------------------------
// Cells (places)
// ---------------------------------------------------------------------------

/**
 * A storage location. Locals, slice elements, and record fields are all cells, so
 * `view`, `view mut`, augmented assignment, and `for x in xs` all reduce to the
 * same get/set pair, and there is exactly one place-resolution path in the
 * interpreter rather than three ad-hoc ones.
 */
export interface Cell {
  readonly name: string;
  value: Value | undefined;
  /** True once a `let` with an initializer has run. Drop elaboration uses this. */
  initialized: boolean;
  /** True after a `move`; re-binding or reading it again is `E0412`. */
  moved: boolean;
  /** `@resource`-typed or resource-valued: gets a drop path. */
  resource: boolean;
  /** Span of the binding, for diagnostics. */
  span: Span;
  /**
   * Mirror this cell's value into the place it indexes, when there is one.
   *
   * A cell that stands for `xs[2]` is not the array slot: without this, writing through
   * a `view` would change the cell and leave the caller's slice untouched.
   */
  writeBack?: (value: Value) => void;
}

export function makeCell(name: string, value: Value, span: Span, resource = false): Cell {
  return { name, value, initialized: true, moved: false, resource, span };
}

/**
 * Read through a borrow.
 *
 * Unwraps *every* view, not just one: a `view mut [T]` parameter handed a `view mut [T]`
 * nests, and a one-level unwrap leaves a borrow that every builtin then rejects. A view
 * with no value is an uninitialised binding, which reads as unit rather than as itself.
 */
export function deref(v: Value): Value {
  let cur = v;
  while (cur.k === "view") {
    const inner = cur.cell.value;
    if (inner === undefined) return UNIT;
    cur = inner;
  }
  return cur;
}

export const UNIT: Value = { k: "unit" };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const intV = (v: bigint | number): Value => ({ k: "int", v: BigInt(v) });
export const floatV = (v: number): Value => ({ k: "float", v });
export const boolV = (v: boolean): Value => ({ k: "bool", v });
export const textV = (v: string): Value => ({ k: "text", v });
export const bytesV = (v: Uint8Array): Value => ({ k: "bytes", v });
export const tupleV = (elems: Value[]): Value => ({ k: "tuple", elems });
export const recordV = (name: string | null, fields: Record<string, Value>): Value =>
  ({ k: "record", name, fields });
export const variantV = (name: string, type: string | null, payload: Value): Value =>
  ({ k: "variant", name, type, payload });
/**
 * A slice whose `len` always tracks `elems`.
 *
 * `len` used to be captured at construction, so any in-place mutator (`push`,
 * `pop`, `insert`, …) left it stale and the bounds check rejected indexes that
 * were plainly in range. A getter removes the second source of truth entirely,
 * so no mutator can forget to maintain it.
 */
export const sliceV = (elems: Value[]): Value => ({
  k: "slice",
  elems,
  get len(): number {
    return elems.length;
  },
});

// ---------------------------------------------------------------------------
// Runtime stores
// ---------------------------------------------------------------------------

export interface ArenaState {
  readonly id: number;
  /** False once `arena_destroy` ran; every `ArenaRef` into it dangles. */
  alive: boolean;
  /** Bumped on destroy, so a stale ref is distinguishable from a live one. */
  generation: number;
  elems: Value[];
}

export interface HandleSlot {
  generation: number;
  value: Value | undefined;
  alive: boolean;
}

export interface HandleStore {
  readonly id: number;
  slots: HandleSlot[];
  /** Indices freed at least once; reused first, so generations actually advance. */
  free: number[];
}

export interface SharedState {
  readonly id: number;
  rc: number;
  atomic: boolean;
  value: Value;
}

/** One recorded close, in close order. Tests assert on exactly-once closing. */
export interface CloseRecord {
  readonly type: string;
  readonly closeFn: string | null;
  readonly reason: "scope" | "return" | "propagate" | "explicit";
}

// ---------------------------------------------------------------------------
// Builtin context
// ---------------------------------------------------------------------------

/**
 * What a builtin may touch. Deliberately narrow: a builtin is pure code over the
 * value model, and everything capability-bearing is absent by construction
 * (kernel.md §4, §8 capability-free).
 */
export interface BuiltinContext {
  readonly arenas: Map<number, ArenaState>;
  readonly stores: Map<number, HandleStore>;
  readonly shareds: Map<number, SharedState>;
  /** Host containers a `shared` may escape into — the leak the leak check catches. */
  readonly escaped: { kind: string; value: Value }[];
  readonly closes: CloseRecord[];
  report(d: Diagnostic): void;
  /** Spend fuel; throws when the budget is gone. */
  tick(): boolean;
  /** Bump the reference count of a shared value. */
  retain(shared: Extract<Value, { k: "shared" }>): void;
  /** Drop one reference; frees the shared when the count reaches zero. */
  release(shared: Extract<Value, { k: "shared" }>): void;
  /** Park a shared in a host container, which outlives its scope. */
  escape(shared: Extract<Value, { k: "shared" }>): void;
  /** Allocate a fresh, live arena. */
  nextArena(): ArenaState;
  /** Allocate a fresh handle store. */
  nextStore(): HandleStore;
  /** Mint a fresh `shared` id. */
  nextSharedId(): number;
  /** Canonical content hash: `Decision.inputHash` and the replay log key. */
  hash(value: Value): string;
}

export type BuiltinFn = (ctx: BuiltinContext, args: Value[], span: Span) => Value;

// ---------------------------------------------------------------------------
// Equality and hashing
// ---------------------------------------------------------------------------

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

/** Float equality by bit pattern: total, with `NaN == NaN` and `+0 != -0`. */
export function floatEqBit(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) {
    if (!Number.isNaN(a) || !Number.isNaN(b)) return false;
    F64[0] = a;
    const x = U64[0]!;
    F64[0] = b;
    return x === U64[0]!;
  }
  if (a === 0 && b === 0) return 1 / a === 1 / b;
  return a === b;
}

/** Canonical, deterministic textual encoding of a value (replay keys, layout ids). */
export function encodeValue(v: Value): string {
  switch (v.k) {
    case "int": return `i${v.v.toString()}`;
    case "float": {
      F64[0] = v.v;
      return `f${U64[0]!.toString(16).padStart(16, "0")}`;
    }
    case "bool": return `b${v.v ? 1 : 0}`;
    case "char": return `c${(v.v.codePointAt(0) ?? 0).toString(16)}`;
    case "text": return `s${v.v.length}:${v.v}`;
    case "bytes":
      return `y${v.v.length}:${[...v.v].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    case "unit": return "u";
    case "tuple": return `t(${v.elems.map(encodeValue).join(",")})`;
    case "record": {
      const keys = Object.keys(v.fields).sort();
      return `r{${v.name ?? ""};${keys.map((k) => `${k}=${encodeValue(v.fields[k]!)}`).join(",")}}`;
    }
    case "variant": return `e${v.type ? `${v.type}.` : ""}${v.name}(${encodeValue(v.payload)})`;
    case "slice": return `l${v.len}[${v.elems.map(encodeValue).join(",")}]`;
    case "map": {
      const rows = [...v.entries.values()].map((e) => `${encodeValue(e.key)}=>${encodeValue(e.val)}`);
      rows.sort();
      return `m{${rows.join(",")}}`;
    }
    case "set": {
      const rows = [...v.entries.values()].map(encodeValue);
      rows.sort();
      return `k{${rows.join(",")}}`;
    }
    case "shared": return `h${v.id}#${v.rc}`;
    case "arena": return `A${v.arena}.${v.index}.${v.generation}`;
    case "handle": return `H${v.store}.${v.index}.${v.generation}`;
    case "resource": return `R${v.type}#${v.closed ? "closed" : "open"}`;
    case "decision":
      return `D{${encodeValue(v.value)}|${v.confidence}|${v.provider}|${v.model}|${v.inputHash}}`;
    case "view": return `w${v.mutable ? "mut " : ""}${v.cell.name}`;
    case "fn": return `F${v.id}:${v.name}`;
  }
}

/** FNV-1a over the canonical encoding: stable across runs and machines. */
export function hashValue(v: Value): string {
  const bytes = new TextEncoder().encode(encodeValue(v));
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * prime) & mask;
  return h.toString(16).padStart(16, "0");
}

/** Map and Set keys are the canonical encoding: total, deterministic, no `Map<Value,_>`. */
export function mapKey(v: Value): string {
  return encodeValue(v);
}

/**
 * Structural equality. `Ok(x) == Ok(x)`; records compare field-wise; the numeric
 * tower compares an integer against a float by value.
 */
export function valueEq(a: Value, b: Value): boolean {
  if ((a.k === "int" || a.k === "float") && (b.k === "int" || b.k === "float")) {
    const x = a.k === "float" ? a.v : Number(a.v);
    const y = b.k === "float" ? b.v : Number(b.v);
    return floatEqBit(x, y);
  }
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "int":
      return b.k === "int" && a.v === b.v;
    case "float":
      return b.k === "float" && floatEqBit(a.v, b.v);
    case "bool":
      return b.k === "bool" && a.v === b.v;
    case "char":
      return b.k === "char" && a.v === b.v;
    case "text":
      return b.k === "text" && a.v === b.v;
    case "bytes":
      return b.k === "bytes"
        && a.v.length === b.v.length && a.v.every((x, i) => x === b.v[i]);
    case "unit":
      return true;
    case "tuple":
      return b.k === "tuple" && a.elems.length === b.elems.length
        && a.elems.every((x, i) => valueEq(x, b.elems[i]!));
    case "record": {
      if (b.k !== "record") return false;
      const keys = Object.keys(a.fields);
      return keys.length === Object.keys(b.fields).length
        && keys.every((k) => k in b.fields && valueEq(a.fields[k]!, b.fields[k]!));
    }
    case "variant":
      return b.k === "variant" && a.name === b.name && valueEq(a.payload, b.payload);
    case "slice":
      return b.k === "slice" && a.len === b.len
        && a.elems.every((x, i) => valueEq(x, b.elems[i]!));
    case "decision":
      return b.k === "decision" && valueEq(a.value, b.value)
        && floatEqBit(a.confidence, b.confidence) && a.provider === b.provider
        && a.model === b.model && a.inputHash === b.inputHash;
    case "shared":
      return b.k === "shared" && a.id === b.id;
    case "arena":
      return b.k === "arena" && a.arena === b.arena && a.index === b.index
        && a.generation === b.generation;
    case "handle":
      return b.k === "handle" && a.store === b.store && a.index === b.index
        && a.generation === b.generation;
    case "resource":
      return b.k === "resource" && a.type === b.type && a.closed === b.closed;
    case "view":
      return b.k === "view" && a.cell === b.cell;
    case "fn":
      return b.k === "fn" && a.id === b.id;
    case "map": {
      if (b.k !== "map" || a.entries.size !== b.entries.size) return false;
      for (const [key, e] of a.entries) {
        const other = b.entries.get(key);
        if (!other || !valueEq(e.val, other.val)) return false;
      }
      return true;
    }
    case "set": {
      if (b.k !== "set" || a.entries.size !== b.entries.size) return false;
      for (const key of a.entries.keys()) if (!b.entries.has(key)) return false;
      return true;
    }
  }
}

/** Does this value carry a drop obligation? */
export function isResourceValue(v: Value): boolean {
  if (v.k === "resource") return true;
  if (v.k === "view") return v.cell.value !== undefined && isResourceValue(v.cell.value);
  if (v.k === "record") return Object.values(v.fields).some(isResourceValue);
  return false;
}

/** True for values that may be freely copied (R-Own-2). */
export function isCopyValue(v: Value): boolean {
  switch (v.k) {
    case "int": case "float": case "bool": case "char": case "unit": case "fn": case "handle":
      return true;
    case "record": return Object.values(v.fields).every(isCopyValue);
    case "tuple": return v.elems.every(isCopyValue);
    case "variant": return isCopyValue(v.payload);
    case "view": case "resource": case "shared": case "arena": case "slice":
    case "text": case "bytes": case "decision": case "map": case "set":
      return false;
  }
}
