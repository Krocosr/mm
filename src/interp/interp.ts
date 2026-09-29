/**
 * MM — the tree-walking interpreter.
 *
 * Three things make this more than a plain evaluator, and all three are normative:
 *
 * 1. **Fuel.** Every `eval` spends one step. Exhaustion aborts with a diagnostic;
 *    it never hangs (kernel.md §8).
 * 2. **Drop elaboration** (kernel.md §6.5). A scope closes its initialized
 *    `@resource` locals exactly once in reverse declaration order, on every exit
 *    path — normal, `return`, and `?`-propagation alike.
 * 3. **Places.** Locals, slice elements, and record fields are all `Cell`s, so
 *    `view`, `view mut`, augmented assignment, and `for x in xs` over a
 *    `view mut` slice share one resolution path instead of three ad-hoc ones.
 *
 * Every failure is a `Diagnostic`. Nothing throws out of `runFn`/`runTest`.
 */

import {
  diag, type Block, type Diagnostic, type Expr, type LoweredFn, type LoweredParam,
  type MatchArm, type Pattern, type Span, type Stmt, type TypeExpr,
} from "../ast.ts";
import type { FnInfo, Program } from "../program.ts";
import { callBuiltin, closeResource, isBuiltin } from "./prelude.ts";
import type {
  ArenaState, BuiltinContext, Cell, CloseRecord, HandleStore, SharedState, Value,
} from "./value.ts";
import {
  boolV, floatV, hashValue, intV, isResourceValue, makeCell, textV, tupleV, UNIT,
  valueEq, variantV, recordV, sliceV,
} from "./value.ts";

/** Narrow a `Block | Expr` union to a bare block, without an unchecked cast. */
export function isBlock(v: Block | Expr): v is Block {
  return "stmts" in v;
}

/** Narrow to a block *expression* — the shape a `const fn` body lowers to. */
export function isBlockExpr(v: Block | Expr): v is Expr & { kind: "block" } {
  return "kind" in v && v.kind === "block";
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * A provider call made on behalf of the `decide` builtin. The replay engine
 * supplies it, so the interpreter core never depends on a vendor SDK.
 */
export type DecisionRequestFn = (input: Value, span: Span) => Value;

export interface RunOptions {
  /** Step budget. Default 1e6. */
  fuel?: number;
  /** Module used to resolve bare names; defaults to the entry item's module. */
  module?: string;
  /**
   * Provider for agent decisions. Absent means no provider is reachable.
   *
   * Either a bare request function, or a `Decider` whose own diagnostics are merged into
   * this run's result. The second form is what makes a replay miss visible: a failed
   * replay must not look like a successful run that happened to return `()`.
   */
  decider?: DecisionRequestFn | { request: DecisionRequestFn; diagnostics: readonly Diagnostic[] };
}

export interface RunResult {
  readonly ok: boolean;
  readonly value: Value;
  readonly diagnostics: Diagnostic[];
  /** Closes performed during the run, in close order. */
  readonly closes: readonly CloseRecord[];
  /** Shared values still holding a reference when the run ended. */
  readonly leaks: readonly number[];
  /** Fuel left when the run ended. */
  readonly fuel: number;
}

/** A transfer the ownership checker needs to see (R-Own-6 atomicity choice). */
export interface SpawnTransfer {
  readonly transfer: "move" | "shared";
  readonly atomic: boolean;
  readonly span: Span;
}

const NO_SPAN: Span = { start: 0, end: 0, file: -1 };
/**
 * Recursion ceiling.
 *
 * This is a stack guard against runaway recursion, not a policy limit: `go(2000)` is an
 * ordinary tail-recursive loop a systems programmer would write, and 512 rejected it.
 * Real recursion in a systems program is bounded by the heap, which `fuel` already
 * bounds; this number only exists so a divergent program fails with a clear diagnostic
 * rather than a native stack overflow.
 */
const MAX_DEPTH = 8_192;

// ---------------------------------------------------------------------------
// Non-local exit
// ---------------------------------------------------------------------------

/** `return`, `break`, `continue`, and `?`-propagation all unwind through this. */
class Signal extends Error {
  constructor(readonly tag: "return" | "break" | "continue" | "propagate", readonly value: Value) {
    super(tag);
    this.name = "Signal";
  }
}

/**
 * Variants of the builtin wrappers, which no user declaration introduces.
 *
 * A static table: the names and their owning type never vary at run time.
 */
const BUILTIN_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["None", "Opt"],
  ["Some", "Opt"],
  ["Ok", "Result"],
  ["Err", "Result"],
  ["NotFound", "IoErr"],
  ["Denied", "IoErr"],
  ["Other", "IoErr"],
  ["Timeout", "NetErr"],
  ["Refused", "NetErr"],
];

/** Thrown when fuel or call depth is gone; caught at the entry point. */
class Aborted extends Error {
  constructor() {
    super("run aborted");
    this.name = "Aborted";
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

interface Scope {
  readonly cells: Cell[];
  readonly names: Map<string, Cell>;
}

interface Frame {
  readonly module: string;
  readonly scopes: Scope[];
}

function newScope(): Scope {
  return { cells: [], names: new Map() };
}

// ---------------------------------------------------------------------------
// Place caches
// ---------------------------------------------------------------------------

/**
 * Element and field cells, cached per value so that `xs[i] = v` is visible through
 * every alias of `xs`. Weak, so a dead value's cells go with it.
 */
const ELEMENT_CELLS = new WeakMap<object, Cell[]>();
const FIELD_CELLS = new WeakMap<object, Map<string, Cell>>();

function elementCell(slice: Extract<Value, { k: "slice" }>, i: number): Cell {
  const key = slice as unknown as object;
  let cells = ELEMENT_CELLS.get(key);
  if (!cells) {
    cells = [];
    for (let j = 0; j < slice.len; j++) {
      const v = slice.elems[j] ?? UNIT;
      cells.push(makeCell(String(j), v, NO_SPAN, isResourceValue(v)));
    }
    ELEMENT_CELLS.set(key, cells);
  }
  const cell = cells[i]!;
  // The cell is the *authority* on this slot. Writing a cell must be visible in the
  // slice's own array, or `xs[i] = v` through a `view` mutates nothing and the caller
  // sees the original contents. Every read goes through the cell, so the write-back
  // belongs where the cell is made rather than at each assignment site.
  cell.writeBack = (v: Value): void => { slice.elems[i] = v; };
  return cell;
}

function fieldCell(rec: Extract<Value, { k: "record" }>, name: string, span: Span): Cell {
  const key = rec as unknown as object;
  let cache = FIELD_CELLS.get(key);
  if (!cache) {
    cache = new Map();
    FIELD_CELLS.set(key, cache);
  }
  const existing = cache.get(name);
  if (existing) return existing;
  const v = rec.fields[name] ?? UNIT;
  const cell = makeCell(name, v, span, isResourceValue(v));
  // Same write-back contract as an element cell: the field cell mirrors `rec.fields`.
  cell.writeBack = (next: Value): void => { rec.fields[name] = next; };
  cache.set(name, cell);
  return cell;
}

// ---------------------------------------------------------------------------

// Small value helpers
// ---------------------------------------------------------------------------

function truthy(v: Value): boolean {
  switch (v.k) {
    case "bool": return v.v;
    case "int": return v.v !== 0n;
    case "float": return v.v !== 0;
    default: return true;
  }
}

function compare(l: Value, r: Value): number | null {
  if (l.k === "int" && r.k === "int") return l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
  if ((l.k === "float" || l.k === "int") && (r.k === "float" || r.k === "int")) {
    const a = l.k === "float" ? l.v : Number(l.v);
    const b = r.k === "float" ? r.v : Number(r.v);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (l.k === "text" && r.k === "text") return l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
  if (l.k === "char" && r.k === "char") return l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
  return null;
}

function describeValue(v: Value): string {
  switch (v.k) {
    case "int": return `${v.v}`;
    case "float": return `${v.v}`;
    case "bool": return v.v ? "true" : "false";
    case "text": case "char": return JSON.stringify(v.v);
    case "variant": return v.name;
    case "record": return v.name ?? "record";
    default: return v.k;
  }
}

function patternName(p: Pattern): string {
  return p.kind === "bind" ? p.name : "_";
}

function typeName(ty: TypeExpr): string {
  switch (ty.kind) {
    case "path": return ty.segments[ty.segments.length - 1] ?? "";
    case "prim": return ty.name;
    default: return "";
  }
}

/** Does this declared type carry `@resource`? */
function declaredResource(program: Program, ty: TypeExpr | undefined, module: string): boolean {
  if (!ty || ty.kind !== "path") return false;
  const name = ty.segments[ty.segments.length - 1]!;
  const id = program.resolveType(name, module);
  return id !== null && program.typeInfo.get(id)?.isResource === true;
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

/**
 * One interpreter instance per run. The class is exported so the const evaluator
 * can reuse the evaluator with `constOnly` set, rather than maintaining a second
 * (and therefore drifting) evaluator.
 */
export class Interp {
  readonly diagnostics: Diagnostic[] = [];
  readonly closes: CloseRecord[] = [];
  readonly arenas = new Map<number, ArenaState>();
  readonly stores = new Map<number, HandleStore>();
  readonly shareds = new Map<number, SharedState>();
  readonly escaped: { kind: string; value: Value }[] = [];
  readonly spawnTransfers: SpawnTransfer[] = [];
  /** Set by the const evaluator: non-`const fn` calls are rejected. */
  constOnly = false;
  /** Variant name → the union types that declare it. */
  readonly variants = new Map<string, string[]>();

  private fuel: number;
  private sharedSeq = 0;
  private arenaSeq = 0;
  private storeSeq = 0;
  /**
   * The decider object, when one was supplied in that form. Read at *result* time, not
   * at construction: a replay miss happens during the run, so an early snapshot would
   * capture an empty list and hide the very failure the mode exists to surface.
   */
  readonly deciderObject?: { request: DecisionRequestFn; diagnostics: readonly Diagnostic[] };
  /** The single request path for agent decisions, whatever form the option took. */
  private readonly decider: DecisionRequestFn | undefined;
  /** Set once any error-severity diagnostic is reported; decides `RunResult.ok`. */
  failed = false;
  private readonly frames: Frame[] = [];

  constructor(readonly program: Program, readonly opts: RunOptions = {}) {
    this.fuel = opts.fuel ?? 1_000_000;
    // A decider may be a bare function or a `Decider` carrying its own diagnostics. In the
    // second form those belong to this run: a replay miss that reached only the decider
    // would make a failed run look like a successful one.
    if (typeof opts.decider === "function") {
      this.decider = opts.decider;
    } else if (opts.decider) {
      this.decider = opts.decider.request;
      this.deciderObject = opts.decider;
    }
    for (const info of program.allTypes()) {
      if (info.form !== "union") continue;
      for (const name of info.fieldNames) {
        const owners = this.variants.get(name) ?? [];
        if (!owners.includes(info.name)) owners.push(info.name);
        this.variants.set(name, owners);
      }
    }
    // The builtin wrappers' variants are not in any user declaration, but they are values
    // like any other: `None`, `IoErr.NotFound`, and `NetErr.Timeout` all appear bare in
    // ordinary code. Seeding them here means `match` on an `IoErr` resolves.
    for (const [name, type] of BUILTIN_VARIANTS) {
      const owners = this.variants.get(name) ?? [];
      if (!owners.includes(type)) owners.push(type);
      this.variants.set(name, owners);
    }
  }

  // -- builtin context -------------------------------------------------------

  readonly ctx: BuiltinContext = {
    arenas: this.arenas,
    stores: this.stores,
    shareds: this.shareds,
    escaped: this.escaped,
    closes: this.closes,
    report: (d) => this.report(d),
    // The context's `tick` reports whether budget remains; `Interp.tick` throws on
    // exhaustion, so it only needs to say "still going".
    tick: () => { this.tick(); return true; },
    retain: (s) => this.retain(s),
    release: (s) => this.release(s),
    escape: (s) => this.escapeShared(s),
    nextArena: () => this.newArena(),
    nextStore: () => this.newStore(),
    nextSharedId: () => ++this.sharedSeq,
    hash: (v) => hashValue(v),
  };

  report(d: Diagnostic): void {
    // A runaway program must not be able to produce unbounded output: the caller asked
    // for a bounded answer. Past the cap, further diagnostics of the same kind are
    // collapsed into one summary line rather than silently dropped.
    if (this.diagnostics.length >= Interp.DIAGNOSTIC_CAP) {
      if (!this.diagnosticsSuppressed) {
        this.diagnosticsSuppressed = true;
        this.diagnostics.push(diag("E0900", "diagnostics_suppressed",
          `stopped after ${Interp.DIAGNOSTIC_CAP} diagnostics; further output from this run is suppressed`,
          d.span));
        this.failed = true;
      }
      return;
    }
    this.diagnostics.push(d);
    if (d.severity === "error") this.failed = true;
  }
  /** Hard cap on diagnostics per run, so a runaway cannot produce unbounded output. */
  private static readonly DIAGNOSTIC_CAP = 200;
  /** Set once the cap has been hit and the summary line emitted. */
  private diagnosticsSuppressed = false;

  /** Spend one step. Aborts the run when the budget is gone. */

  tick(): void {
    if (this.fuel <= 0) {
      this.report(diag("E0901", "fuel_exhausted",
        "evaluation exceeded its step budget and was aborted rather than allowed to hang",
        NO_SPAN));
      throw new Aborted();
    }
    this.fuel -= 1;
  }

  get fuelLeft(): number {
    return this.fuel;
  }

  private newArena(): ArenaState {
    const id = ++this.arenaSeq;
    const arena: ArenaState = { id, alive: true, generation: 0, elems: [] };
    this.arenas.set(id, arena);
    return arena;
  }

  private newStore(): HandleStore {
    const id = ++this.storeSeq;
    const store: HandleStore = { id, slots: [], free: [] };
    this.stores.set(id, store);
    return store;
  }

  // -- shared ownership (R-Own-6) -------------------------------------------

  /** Wrap a value in a fresh `shared` with one reference. Used by `view`-to-shared lifts. */
  share(value: Value, atomic: boolean): Extract<Value, { k: "shared" }> {
    const id = ++this.sharedSeq;
    const shared: Extract<Value, { k: "shared" }> = { k: "shared", id, value, rc: 1, atomic };
    this.shareds.set(id, { id, rc: 1, atomic, value });
    return shared;
  }

  /**
   * The store is authoritative for the count. Each `shared` value carries its own
   * copy of `rc` for diagnostics, but two handles to the same shared would drift
   * if that copy were the source of truth.
   */
  private retain(s: Extract<Value, { k: "shared" }>): void {
    const state = this.shareds.get(s.id);
    if (!state) return;
    state.rc += 1;
    s.rc = state.rc;
  }

  private release(s: Extract<Value, { k: "shared" }>): void {
    const state = this.shareds.get(s.id);
    if (!state) return;
    state.rc -= 1;
    s.rc = state.rc;
    if (state.rc <= 0) this.shareds.delete(s.id);
  }

  /** Host escape hatch: a `shared` parked in a container outlives its scope. */
  private escapeShared(s: Extract<Value, { k: "shared" }>): void {
    this.retain(s);
    this.escaped.push({ kind: "host", value: s });
  }

  // -- entry points ----------------------------------------------------------

  /** Run a declared function. Never throws; failures land in `diagnostics`. */
  runFn(fnId: number, args: Value[], module?: string): Value {
    const info = this.program.fnInfo.get(fnId);
    if (!info) {
      this.report(diag("E0118", "unknown_name", `no function with id ${fnId}`, NO_SPAN));
      return UNIT;
    }
    this.frames.push({ module: module ?? info.module, scopes: [] });
    try {
      return this.runBody(info.fn, args);
    } finally {
      this.frames.pop();
    }
  }

  /** Run a bare block (a `test` body or an inline `const { .. }`) in a synthetic frame. */
  runBareBlock(block: Block, module = ""): Value {
    this.frames.push({ module, scopes: [] });
    try {
      const scope = newScope();
      this.frames[this.frames.length - 1]!.scopes.push(scope);
      try {
        const out = this.runBlockStmts(block, scope);
        if (out instanceof Signal) return out.tag === "continue" ? UNIT : out.value;
        return out;
      } finally {
        this.popScope(scope, "scope");
      }
    } finally {
      this.frames.pop();
    }
  }

  /** The body of a `LoweredFn`, with parameters already in scope. */
  private runBody(fn: LoweredFn, args: Value[]): Value {
    const frame = this.frames[this.frames.length - 1]!;
    const scope = newScope();
    frame.scopes.push(scope);
    // Which exit path we are on decides the drop `reason`, so an early `return`
    // and a `?`-propagation are distinguishable from a normal scope exit.
    let reason: "scope" | "return" | "propagate" = "scope";
    try {
      fn.params.forEach((p, i) => {
        const v = args[i] ?? UNIT;
        const cell = makeCell(p.name, v, p.span, isResourceValue(v));
        scope.cells.push(cell);
        scope.names.set(p.name, cell);
      });
      const out = this.runBlockStmts(fn.body, scope);
      if (out instanceof Signal && (out.tag === "return" || out.tag === "propagate")) {
        reason = out.tag;
        return out.value;
      }
      if (out instanceof Signal) return out.value;
      return out;
    } catch (e) {
      if (e instanceof Signal && (e.tag === "propagate" || e.tag === "return")) {
        if (e.tag === "propagate") reason = "propagate";
        return e.value;
      }
      throw e;
    } finally {
      // Drop elaboration runs on every exit path, including early return and `?`.
      this.popScope(scope, reason);
    }
  }

  /**
   * Evaluate a `const fn` body with `args` bound to `paramNames`.
   *
   * The parameter *names* cannot come from the const item: parsing
   * `const fn f(a: u32)` drops the parameter list, so the names are recovered
   * from the item's source span rather than guessed.
   */
  callConstFn(
    name: string, body: Block, paramNames: readonly string[], args: Value[], module: string,
  ): Value {
    if (args.length !== paramNames.length) {
      this.report(diag("E0201", "generic_arity",
        `\`${name}\` takes ${paramNames.length} argument(s), got ${args.length}`,
        body.span, { data: { expected: paramNames.length, got: args.length } }));
      return UNIT;
    }
    this.frames.push({ module, scopes: [] });
    const scope = this.pushScope();
    try {
      paramNames.forEach((param, i) => {
        const v = args[i] ?? UNIT;
        const cell = makeCell(param, v, body.span, isResourceValue(v));
        scope.cells.push(cell);
        scope.names.set(param, cell);
      });
      const out = this.runBlockStmts(body, scope);
      return out instanceof Signal ? out.value : out;
    } catch (e) {
      if (e instanceof Signal && (e.tag === "return" || e.tag === "propagate")) return e.value;
      throw e;
    } finally {
      this.popScope(scope, "scope");
      this.frames.pop();
    }
  }

  // -- scopes and drop elaboration (kernel.md §6.5) --------------------------

  private pushScope(): Scope {
    const scope = newScope();
    this.frames[this.frames.length - 1]!.scopes.push(scope);
    return scope;
  }

  /**
   * Leave a scope: close every initialized `@resource` local exactly once, in
   * reverse declaration order. Never initialized, never moved, never closed.
   */
  private popScope(scope: Scope, reason: "scope" | "return" | "propagate"): void {
    for (let i = scope.cells.length - 1; i >= 0; i--) {
      this.dropCell(scope.cells[i]!, reason);
    }
    const frame = this.frames[this.frames.length - 1];
    if (frame) {
      const at = frame.scopes.lastIndexOf(scope);
      if (at >= 0) frame.scopes.splice(at, 1);
    }
  }

  private dropCell(cell: Cell, reason: "scope" | "return" | "propagate"): void {
    const v = cell.value;
    if (v === undefined || !cell.initialized || cell.moved) return;
    if (v.k === "view") return;
    if (v.k === "resource") {
      closeResource(this.ctx, v, reason, cell.span);
      return;
    }
    if (v.k === "shared") {
      this.release(v);
      return;
    }
    // A resource-typed record: only the fields that were actually built get
    // dropped, so a constructor that fails halfway drops nothing that is not there.
    if (v.k === "record") {
      for (const name of Object.keys(v.fields).reverse()) {
        const f = v.fields[name]!;
        if (f.k === "resource") closeResource(this.ctx, f, reason, cell.span);
        else if (f.k === "shared") this.release(f);
      }
    }
  }

  // -- statements ------------------------------------------------------------

  /** Returns a `Signal` for the caller to propagate, or null to continue. */
  private execStmt(stmt: Stmt, scope: Scope): Signal | null {
    this.tick();
    switch (stmt.kind) {
      case "let": {
        if (!stmt.init) {
          const cell: Cell = {
            name: patternName(stmt.pat), value: undefined, initialized: false,
            moved: false, resource: false, span: stmt.span,
          };
          scope.cells.push(cell);
          if (stmt.pat.kind === "bind") scope.names.set(cell.name, cell);
          return null;
        }
        const value = this.eval(stmt.init);
        if (stmt.pat.kind === "bind") {
          const resource = isResourceValue(value)
            || declaredResource(this.program, stmt.ty, this.module());
          const cell = makeCell(stmt.pat.name, value, stmt.span, resource);
          scope.cells.push(cell);
          scope.names.set(cell.name, cell);
          return null;
        }
        this.bindPattern(stmt.pat, value, scope, stmt.span);
        return null;
      }
      case "assign":
        this.assignTo(stmt.target, this.eval(stmt.value), stmt.span);
        return null;
      case "expr":
        this.eval(stmt.expr);
        return null;
      case "item":
        // Nested items were indexed by lowering; nothing to do at run time.
        return null;
    }
  }

  // -- expressions -----------------------------------------------------------

  eval(expr: Expr): Value {
    this.tick();
    switch (expr.kind) {
      case "int": return intV(expr.value);
      case "float": return floatV(expr.value);
      case "bool": return boolV(expr.value);
      case "string": return textV(expr.value);
      case "bytes": return { k: "bytes", v: expr.value };
      case "char": return { k: "char", v: expr.value };
      case "effectset": return UNIT;
      case "tuple": return tupleV(expr.elems.map((e) => this.eval(e)));
      case "array": return sliceV(expr.elems.map((e) => this.eval(e)));
      case "block": return this.blockValue(expr.block);
      case "struct": return this.evalStruct(expr);
      case "if": {
        if (truthy(this.eval(expr.cond))) return this.blockValue(expr.then);
        if (expr.else_ === undefined) return UNIT;
        if (isBlock(expr.else_)) return this.blockValue(expr.else_);
        return this.eval(expr.else_);
      }
      case "match": return this.evalMatch(expr.scrutinee, expr.arms, expr.span);
      case "while": {
        while (truthy(this.eval(expr.cond))) {
          this.tick();
          const sig = this.execBlock(expr.body);
          if (!sig) continue;
          if (sig.tag === "break") return sig.value;
          if (sig.tag === "continue") continue;
          throw sig;
        }
        return UNIT;
      }
      case "loop": {
        for (;;) {
          this.tick();
          const sig = this.execBlock(expr.body);
          if (!sig) continue;
          if (sig.tag === "break") return sig.value;
          if (sig.tag === "continue") continue;
          throw sig;
        }
      }
      case "for": return this.evalFor(expr);
      case "return":
        throw new Signal("return", expr.value ? this.eval(expr.value) : UNIT);
      case "break":
        throw new Signal("break", expr.value ? this.eval(expr.value) : UNIT);
      case "continue": throw new Signal("continue", UNIT);
      case "path": return this.evalPath(expr.value, expr.span);
      case "field": return this.evalField(expr);
      case "index": return this.evalIndex(expr);
      case "call": return this.evalCall(expr);
      case "method": return this.evalMethod(expr);
      case "unary": return this.evalUnary(expr);
      case "binary": return this.evalBinary(expr);
      case "assign":
        this.assignTo(expr.target, this.eval(expr.value), expr.span);
        return UNIT;
      case "try": return this.evalTry(expr);
      case "cast": return this.eval(expr.operand);
      case "is": return this.evalIs(expr);
      case "unsafe": {
        const sig = this.execBlock(expr.body);
        if (sig) throw sig;
        return UNIT;
      }
      case "move": return this.eval(expr.operand);
      case "view": {
        const cell = this.tryPlace(expr.operand);
        if (cell) return { k: "view", mutable: expr.mutable, cell };
        if (expr.mutable) {
          this.report(diag("E0414", "mutable_alias",
            "`view mut` needs a place to borrow, not a temporary", expr.span));
          return UNIT;
        }
        return this.eval(expr.operand);
      }
      case "spawn": return this.evalSpawn(expr);
      case "tohandle": return this.evalToHandle(expr);
      case "consteval": {
        const sig = this.execBlock(expr.body);
        if (sig) throw sig;
        return UNIT;
      }
    }
  }

  /**
   * A block body whose scope the caller already pushed, so parameter cells stay
   * in scope for the whole body.
   */
  private runBlockStmts(block: Block, scope: Scope): Value | Signal {
    let last: Value = UNIT;
    try {
      for (const s of block.stmts) {
        if (s.kind === "expr") {
          last = this.eval(s.expr);
          continue;
        }
        const sig = this.execStmt(s, scope);
        if (sig) return sig;
      }
      return block.tail ? this.eval(block.tail) : last;
    } catch (e) {
      if (e instanceof Signal) return e;
      throw e;
    }
  }

  /** Runs a block for effect. `return`/`?` escape as a `Signal`. */
  private execBlock(block: Block): Signal | null {
    const out = this.runBlock(block);
    return out instanceof Signal ? out : null;
  }

  /**
   * A block used as a *value*.
   *
   * Control flow must not be unwrapped here. A `return` inside `if c { return 7 }` is a
   * signal, not the value 7: taking `.value` would evaluate the branch and then carry on
   * past the end of the function, so every early return silently became a no-op. Only a
   * non-control signal is a block value.
   */
  private blockValue(block: Block): Value {
    const out = this.runBlock(block);
    if (out instanceof Signal) {
      if (out.tag !== "propagate") throw out;
      return out.value;
    }
    return out;
  }

  /**
   * One block runner. A trailing expression *statement* is the block's value when
   * there is no `tail` — the parser keeps both forms, and a block that ends in
   * `if x { .. }` is written the first way.
   */
  private runBlock(block: Block): Value | Signal {
    const scope = this.pushScope();
    try {
      let last: Value = UNIT;
      for (const s of block.stmts) {
        if (s.kind === "expr") {
          last = this.eval(s.expr);
          continue;
        }
        const sig = this.execStmt(s, scope);
        if (sig) return sig;
      }
      return block.tail ? this.eval(block.tail) : last;
    } catch (e) {
      if (e instanceof Signal) return e;
      throw e;
    } finally {
      this.popScope(scope, "scope");
    }
  }

  private evalStruct(expr: Expr & { kind: "struct" }): Value {
    const fields: Record<string, Value> = {};
    const built: string[] = [];
    try {
      for (const f of expr.fields) {
        fields[f.name] = this.eval(f.value);
        built.push(f.name);
      }
    } catch (e) {
      // §6.5: a constructor that fails partway drops only what it built.
      for (const name of built.reverse()) {
        const v = fields[name]!;
        if (v.k === "resource") closeResource(this.ctx, v, "propagate", expr.span);
        else if (v.k === "shared") this.release(v);
      }
      throw e;
    }
    const variant = this.variantOf(expr.path, fields);
    if (variant) return variant;
    return recordV(expr.path, fields);
  }

  /**
   * If `path` names a variant of a union declared in this program, build it.
   *
   * `Circle { r: 1.0 }` names the variant alone, so the owning union comes from
   * the variant table; `Shape.Circle { .. }` names it explicitly.
   */
  private variantOf(path: string, fields: Record<string, Value>): Value | null {
    const dot = path.lastIndexOf(".");
    const variantName = dot < 0 ? path : path.slice(dot + 1);
    const owners = this.variants.get(variantName);
    if (!owners || owners.length === 0) return null;
    const typeName = dot < 0 ? owners[0]! : path.slice(0, dot);
    if (!owners.includes(typeName)) return null;
    return variantV(variantName, typeName, recordV(typeName, fields));
  }

  // -- paths, fields, indices ------------------------------------------------

  private evalPath(name: string, span: Span): Value {
    const cell = this.lookup(name);
    if (cell) return this.readCell(cell, span);
    const constId = this.program.resolveConst(name, this.module());
    if (constId !== null) {
      const c = this.program.consts.get(constId);
      if (c && !isBlock(c.value)) return this.eval(c.value);
    }
    const fnId = this.program.resolveFn(name, this.module());
    if (fnId !== null) {
      const info = this.program.fnInfo.get(fnId);
      if (info) return { k: "fn", id: fnId, name: info.name };
    }
    // A bare nullary variant — `None`, `Idle`, `Tick` — is a value, not a name. Its owning
    // type comes from the variant table, which is unique once the name is known. Without
    // this every `match` on a unit variant is unreadable in source.
    const owners = this.variants.get(name);
    if (owners && owners.length > 0) {
      return variantV(name, owners[0]!, UNIT);
    }
    this.report(diag("E0118", "unknown_name",
      `no binding, constant, or function named \`${name}\``, span));
    return UNIT;
  }

  private evalField(expr: Expr & { kind: "field" }): Value {
    // A qualified variant value: `IoErr.Other`, `Route.fast`. The base names a *type*,
    // so it must not be evaluated as a value — there is no binding for `IoErr`. The
    // variant table already knows which type owns each variant name.
    if (expr.base.kind === "path") {
      const owners = this.variants.get(expr.name);
      if (owners && owners.length > 0) {
        const qualified = expr.base.value;
        // A qualified name must name the owning type; a bare one takes its only owner.
        if (owners.includes(qualified)) return variantV(expr.name, qualified, UNIT);
        const cell = this.lookup(qualified);
        if (!cell) return variantV(expr.name, owners[0]!, UNIT);
      }
    }
    const cell = this.tryPlace(expr);
    if (cell) return this.readCell(cell, expr.span);
    return this.fieldOf(this.eval(expr.base), expr.name, expr.span);
  }

  private fieldOf(base: Value, name: string, span: Span): Value {
    const b = base.k === "view" ? base.cell.value ?? UNIT : base;
    switch (b.k) {
      case "record":
        if (!(name in b.fields)) {
          this.report(diag("E0119", "unknown_field",
            `\`${b.name ?? "record"}\` has no field \`${name}\``, span));
          return UNIT;
        }
        return b.fields[name]!;
      case "variant":
        if (b.payload.k === "record" && name in b.payload.fields) return b.payload.fields[name]!;
        if (b.name === name) return UNIT;
        this.report(diag("E0119", "unknown_field",
          `variant \`${b.name}\` has no field \`${name}\``, span));
        return UNIT;
      case "decision":
        switch (name) {
          case "value": return b.value;
          case "confidence": return floatV(b.confidence);
          case "provider": return textV(b.provider);
          case "model": return textV(b.model);
          case "input_hash": return textV(b.inputHash);
          default:
            this.report(diag("E0119", "unknown_field", `Decision has no field \`${name}\``, span));
            return UNIT;
        }
      default:
        this.report(diag("E0119", "unknown_field", `\`${b.k}\` has no field \`${name}\``, span));
        return UNIT;
    }
  }

  private evalIndex(expr: Expr & { kind: "index" }): Value {
    const cell = this.tryPlace(expr);
    if (cell) return this.readCell(cell, expr.span);
    return this.indexOf(this.eval(expr.base), this.eval(expr.index), expr.span);
  }

  private indexOf(base: Value, idx: Value, span: Span): Value {
    // Views nest: a `view mut T` parameter handed another `view mut T` wraps twice.
    // Unwrap all the way down, or the value still looks like a borrow and cannot be read.
    const b = unwrapView(base);
    const i = idx.k === "int" ? Number(idx.v) : Number.NaN;
    const len = b.k === "slice" ? b.len
      : b.k === "text" ? b.v.length
        : b.k === "bytes" ? b.v.length
          : b.k === "tuple" ? b.elems.length
            : -1;
    if (len < 0) {
      this.report(diag("E0119", "not_indexable", `\`${b.k}\` cannot be indexed`, span));
      return UNIT;
    }
    if (!Number.isInteger(i) || i < 0 || i >= len) {
      this.report(diag("E0193", "index_out_of_range",
        `index ${idx.k === "int" ? i : "?"} is outside a \`${b.k}\` of length ${len}`, span));
      return UNIT;
    }
    if (b.k === "slice") return b.elems[i]!;
    if (b.k === "text") return { k: "char", v: b.v[i]! };
    if (b.k === "bytes") return intV(BigInt(b.v[i]!));
    if (b.k === "tuple") return b.elems[i]!;
    this.report(diag("E0119", "not_indexable", `\`${b.k}\` cannot be indexed`, span));
    return UNIT;
  }

  // -- operators -------------------------------------------------------------

  private evalUnary(expr: Expr & { kind: "unary" }): Value {
    const v = this.eval(expr.operand);
    switch (expr.op) {
      case "-":
        if (v.k === "int") return intV(-v.v);
        if (v.k === "float") return floatV(-v.v);
        break;
      case "!":
        if (v.k === "bool") return boolV(!v.v);
        if (v.k === "int") return intV(~v.v);
        break;
      case "*": case "&": case "&mut": return v;
    }
    this.report(diag("E0120", "bad_operand",
      `\`${expr.op}\` is not defined for \`${v.k}\``, expr.span));
    return UNIT;
  }

  private evalBinary(expr: Expr & { kind: "binary" }): Value {
    // Short-circuit: the right operand of `&&`/`||` may not run.
    if (expr.op === "&&" || expr.op === "||") {
      const l = truthy(this.eval(expr.lhs));
      if (expr.op === "&&" && !l) return boolV(false);
      if (expr.op === "||" && l) return boolV(true);
      return boolV(truthy(this.eval(expr.rhs)));
    }
    const l = this.eval(expr.lhs);
    const r = this.eval(expr.rhs);
    switch (expr.op) {
      case "==": return boolV(valueEq(l, r));
      case "!=": return boolV(!valueEq(l, r));
      case "<": case "<=": case ">": case ">=": {
        const c = compare(l, r);
        if (c === null) {
          this.report(diag("E0121", "bad_operands",
            `\`${l.k}\` and \`${r.k}\` cannot be ordered`, expr.span));
          return boolV(false);
        }
        if (expr.op === "<") return boolV(c < 0);
        if (expr.op === "<=") return boolV(c <= 0);
        if (expr.op === ">") return boolV(c > 0);
        return boolV(c >= 0);
      }
      case "+": case "-": case "*": case "/": case "%":
        return this.arith(expr.op, l, r, expr.span);
      case "&": if (l.k === "int" && r.k === "int") return intV(l.v & r.v); break;
      case "|": if (l.k === "int" && r.k === "int") return intV(l.v | r.v); break;
      case "^": if (l.k === "int" && r.k === "int") return intV(l.v ^ r.v); break;
      case "<<": if (l.k === "int" && r.k === "int") return intV(l.v << r.v); break;
      case ">>": if (l.k === "int" && r.k === "int") return intV(l.v >> r.v); break;
    }
    this.report(diag("E0121", "bad_operands",
      `\`${expr.op}\` is not defined for \`${l.k}\` and \`${r.k}\``, expr.span));
    return UNIT;
  }

  /**
   * The numeric tower: two integers stay `bigint` (so `u64` is exact), any float
   * operand promotes the whole expression to `number`.
   */
  private arith(op: "+" | "-" | "*" | "/" | "%", l: Value, r: Value, span: Span): Value {
    if (op === "+" && l.k === "text" && r.k === "text") return textV(l.v + r.v);
    if (l.k === "float" || r.k === "float") {
      const a = l.k === "float" ? l.v : l.k === "int" ? Number(l.v) : Number.NaN;
      const b = r.k === "float" ? r.v : r.k === "int" ? Number(r.v) : Number.NaN;
      if (Number.isNaN(a) || Number.isNaN(b)) {
        this.report(diag("E0121", "bad_operands",
          `\`${op}\` is not defined for \`${l.k}\` and \`${r.k}\``, span));
        return UNIT;
      }
      if (op === "+") return floatV(a + b);
      if (op === "-") return floatV(a - b);
      if (op === "*") return floatV(a * b);
      if (op === "/") return floatV(a / b);
      return floatV(a % b);
    }
    if (l.k !== "int" || r.k !== "int") {
      this.report(diag("E0121", "bad_operands",
        `\`${op}\` is not defined for \`${l.k}\` and \`${r.k}\``, span));
      return UNIT;
    }
    if (op === "+") return intV(l.v + r.v);
    if (op === "-") return intV(l.v - r.v);
    if (op === "*") return intV(l.v * r.v);
    if (r.v === 0n) {
      this.report(diag("E0122", "division_by_zero", `integer \`${op}\` by zero`, span));
      return intV(0n);
    }
    return intV(op === "/" ? l.v / r.v : l.v % r.v);
  }

  private evalTry(expr: Expr & { kind: "try" }): Value {
    const v = this.eval(expr.operand);
    if (v.k !== "variant") {
      this.report(diag("E0123", "try_on_non_result",
        `\`?\` needs a Result, got \`${v.k}\``, expr.span));
      return UNIT;
    }
    if (v.name === "Ok" || v.name === "Some") return v.payload;
    // `Err` unwinds to the function boundary; drop elaboration runs on the way.
    throw new Signal("propagate", v);
  }

  private evalIs(expr: Expr & { kind: "is" }): Value {
    const v = this.eval(expr.base);
    const want = typeName(expr.ty);
    if (v.k === "variant") return boolV(v.name === want);
    return boolV(v.k === "record" && v.name === want);
  }

  // -- calls -----------------------------------------------------------------

  /**
   * A call resolves in a fixed order: a user function, then a variant
   * constructor (`Ok(1)`), then a builtin. A user function of the same name as a
   * builtin wins, so a program can shadow `sum` without ceremony.
   */
  private evalCall(expr: Expr & { kind: "call" }): Value {
    if (expr.callee.kind === "path") {
      const name = expr.callee.value;
      // `Map::new()` is an associated constructor: try the `<Type>_<member>` builtin
      // before the bare name, so a qualified call reaches the same table a method does.
      const sep = name.lastIndexOf("::");
      if (sep > 0) {
        const owner = name.slice(0, sep).toLowerCase();
        const member = name.slice(sep + 2).toLowerCase();
        const direct = `${owner}_${member}`;
        const inverted = `${member}_${owner}`;
        const target = isBuiltin(direct) ? direct : isBuiltin(inverted) ? inverted : name;
        return callBuiltin(this.ctx, target, expr.args.map((a) => this.eval(a)), expr.span);
      }
      const fnId = this.program.resolveFn(name, this.module());
      if (fnId !== null) return this.callFn(fnId, this.argsFor(expr, fnId), expr.span);
      const owner = this.variantCtor(name);
      if (owner) {
        const args = expr.args.map((a) => this.eval(a));
        return variantV(name, owner, args.length === 1 ? args[0]! : tupleV(args));
      }
      // A higher-order parameter: `fn map_with(.., f: fn(u32) -> u32, ..)` calls `f(..)`
      // by bare name. The binding holds a function value, so it is called the same way
      // any other function value is. This must sit below user functions and variant
      // constructors so a program can still shadow a name.
      const cb = this.lookup(name);
      if (cb) {
        const callee = this.readCell(cb, expr.callee.span);
        if (callee.k === "fn") {
          return this.callValue(callee, expr.args.map((a) => this.eval(a)), expr.span);
        }
      }
      return callBuiltin(this.ctx, name, expr.args.map((a) => this.eval(a)), expr.span);
    }
    const callee = this.eval(expr.callee);
    return this.callValue(callee, expr.args.map((a) => this.eval(a)), expr.span);
  }

  /** Arguments for a call to a known function, honouring `view` parameters. */
  private argsFor(expr: Expr & { kind: "call" }, fnId: number): Value[] {
    const params = this.program.fnInfo.get(fnId)?.fn.params;
    return expr.args.map((a, i) => this.argFor(a, params?.[i]));
  }

  private evalMethod(expr: Expr & { kind: "method" }): Value {
    const base = this.eval(expr.base);
    const args = expr.args.map((a) => this.eval(a));
    // A user method of that name wins over a same-named builtin.
    const userFn = this.findMethod(expr.name);
    if (userFn !== null) return this.callFn(userFn, [base, ...args], expr.span);
    // Unwrap all the way: a `view mut Map` parameter handed a `view mut Map` nests, and a
    // single-level unwrap would dispatch `view_get`, which does not exist.
    const tag = unwrapView(base).k;
    const spelled = `${tag}_${expr.name}`;
    if (isBuiltin(spelled)) return callBuiltin(this.ctx, spelled, [base, ...args], expr.span);
    if (isBuiltin(expr.name)) return callBuiltin(this.ctx, expr.name, [base, ...args], expr.span);
    // The provider hook is not a builtin: it is the replay engine's job.
    if (expr.name === "decide" && this.decider) {
      return this.decider(base, expr.span);
    }
    this.report(diag("E0199", "unknown_builtin",
      `\`${tag}\` has no method \`${expr.name}\``, expr.span));
    return UNIT;
  }

  /**
   * Evaluate one argument. A parameter declared `view T` / `view mut T` receives a
   * view over the *caller's place*, which is what makes `for x in xs` write back
   * into the caller's slice rather than into a copy.
   */
  private argFor(expr: Expr, param: LoweredParam | undefined): Value {
    const ownership = param?.ownership;
    if (ownership !== "view" && ownership !== "viewmut") return this.eval(expr);
    const cell = this.tryPlace(expr);
    if (cell) return { k: "view", mutable: ownership === "viewmut", cell };
    if (ownership === "viewmut") {
      this.report(diag("E0414", "mutable_alias",
        `\`${expr.kind}\` is a temporary and cannot be borrowed as \`view mut\``, expr.span));
      return this.eval(expr);
    }
    // An immutable view of an rvalue is fine: it just reads the temporary.
    const temp = makeCell("<view>", this.eval(expr), expr.span);
    return { k: "view", mutable: false, cell: temp };
  }

  private callValue(callee: Value, args: Value[], span: Span): Value {
    if (callee.k === "fn") return this.callFn(callee.id, args, span);
    if (callee.k === "text" && this.decider) return this.decider(callee, span);
    this.report(diag("E0199", "not_callable", `\`${callee.k}\` is not callable`, span));
    return UNIT;
  }

  private callFn(fnId: number, args: Value[], span: Span): Value {
    const info = this.program.fnInfo.get(fnId);
    if (!info) {
      this.report(diag("E0118", "unknown_name", `no function with id ${fnId}`, span));
      return UNIT;
    }
    if (this.constOnly && !info.isConst) {
      // Capability-free means *call*-free too: only `const fn` may run at compile time.
      this.report(diag("E0502", "effect_in_const_eval",
        `\`${info.name}\` is not a \`const fn\`; compile-time evaluation cannot call it`,
        span, { data: { fn: info.name, effects: [...info.effects] } }));
      return UNIT;
    }
    if (info.effects.length > 0) {
      // This build grants no capability, so an effectful call names what is missing
      // rather than quietly returning a value.
      this.report(diag("E0503", "missing_capability",
        `\`${info.name}\` needs \`${info.effects.join(", ")}\`, which this build does not grant`,
        span, { data: { effects: [...info.effects] } }));
      return UNIT;
    }
    if (this.frames.length >= MAX_DEPTH) {
      this.report(diag("E0902", "call_depth_exceeded",
        `call depth ${MAX_DEPTH} exceeded`, span));
      throw new Aborted();
    }
    return this.runFn(fnId, args, info.module);
  }

  private evalSpawn(expr: Expr & { kind: "spawn" }): Value {
    // Structured concurrency: the body runs to completion here, and the transfer
    // discipline is recorded so the ownership checker can pick the RC strategy.
    this.spawnTransfers.push({
      transfer: expr.transfer,
      atomic: expr.transfer === "shared",
      span: expr.span,
    });
    const scope = this.pushScope();
    try {
      const out = this.runBlockStmts(expr.body, scope);
      return out instanceof Signal ? out.value : out;
    } finally {
      this.popScope(scope, "scope");
    }
  }

  private evalToHandle(expr: Expr & { kind: "tohandle" }): Value {
    const v = this.eval(expr.operand);
    if (v.k !== "arena") return v;
    // Arena → handle is the sanctioned escape (kernel.md §3.4 R-Own-7).
    const arena = this.arenas.get(v.arena);
    if (!arena || !arena.alive) {
      this.report(diag("E0415", "arena_escape",
        `arena ${v.arena} is destroyed; its contents cannot become a handle`, expr.span));
      return UNIT;
    }
    const store = this.newStore();
    store.slots.push({ generation: 1, value: arena.elems[v.index] ?? UNIT, alive: true });
    return { k: "handle", store: store.id, index: 0, generation: 1 };
  }

  // -- match -----------------------------------------------------------------

  private evalMatch(scrutinee: Expr, arms: readonly MatchArm[], span: Span): Value {
    const v = this.eval(scrutinee);
    for (const arm of arms) {
      const scope = this.pushScope();
      try {
        if (this.matchPattern(arm.pat, v, scope)) return this.eval(arm.body);
      } finally {
        this.popScope(scope, "scope");
      }
    }
    this.report(diag("E0124", "no_matching_arm",
      `no arm matches \`${describeValue(v)}\``, span));
    return UNIT;
  }

  /**
   * Bind a pattern against a value, adding any bindings to `scope`. Bindings land
   * in the scope the caller pops when the arm finishes, so a `for` loop over a
   * `view mut` slice can write its element binding back.
   */
  private matchPattern(pat: Pattern, v: Value, scope: Scope): boolean {
    this.tick();
    switch (pat.kind) {
      case "wildcard": return true;
      case "bind": return this.declare(pat.name, v, pat.span, scope);
      case "lit": return valueEq(this.eval(pat.value), v);
      case "or": {
        for (const alt of pat.alts) {
          const trial = newScope();
          if (!this.matchPattern(alt, v, trial)) continue;
          this.merge(trial, scope);
          return true;
        }
        return false;
      }
      case "at": {
        const trial = newScope();
        if (!this.matchPattern(pat.sub, v, trial)) return false;
        if (!this.declare(pat.name, v, pat.span, scope)) return false;
        this.merge(trial, scope);
        return true;
      }
      case "unit": {
        if (v.k === "variant") {
          return v.name === pat.path || (this.variants.get(v.name) ?? []).includes(pat.path);
        }
        return v.k === "record" && v.name === pat.path;
      }
      case "tuple": {
        if (v.k === "variant" && v.name !== pat.path) {
          if (!(this.variants.get(pat.path) ?? []).includes(v.name)) return false;
        }
        const elems = this.parts(v);
        if (!elems || elems.length !== pat.elems.length) return false;
        const trial = newScope();
        for (let i = 0; i < pat.elems.length; i++) {
          if (!this.matchPattern(pat.elems[i]!, elems[i]!, trial)) return false;
        }
        this.merge(trial, scope);
        return true;
      }
      case "record": {
        if (v.k === "variant" && v.name !== pat.path) return false;
        const fields = v.k === "variant" ? this.recordPayload(v.payload) : this.recordPayload(v);
        if (!fields) return false;
        const trial = newScope();
        for (const f of pat.fields) {
          if (!(f.name in fields)) {
            if (pat.rest) continue;
            return false;
          }
          if (!this.matchPattern(f.pat, fields[f.name]!, trial)) return false;
        }
        this.merge(trial, scope);
        return true;
      }
    }
  }

  /** Destructured parts of a value: a tuple's elements, or a variant's payload. */
  private parts(v: Value): Value[] | null {
    if (v.k === "tuple") return v.elems;
    if (v.k === "variant") {
      if (v.payload.k === "tuple") return v.payload.elems;
      return [v.payload];
    }
    if (v.k === "record") return Object.values(v.fields);
    return null;
  }

  private recordPayload(v: Value): Record<string, Value> | null {
    if (v.k === "record") return v.fields;
    if (v.k === "variant" && v.payload.k === "record") return v.payload.fields;
    return null;
  }

  private declare(name: string, v: Value, span: Span, scope: Scope): boolean {
    const cell = makeCell(name, v, span, isResourceValue(v));
    scope.cells.push(cell);
    scope.names.set(name, cell);
    return true;
  }

  /** Fold a sub-pattern's bindings into the caller's scope. */
  private merge(from: Scope, into: Scope): void {
    for (const [name, cell] of from.names) into.names.set(name, cell);
    into.cells.push(...from.cells);
  }

  // -- for loops -------------------------------------------------------------

  private evalFor(expr: Expr & { kind: "for" }): Value {
    const iter = this.eval(expr.iter);
    const b = unwrapView(iter);
    // Iteration reads a sequence, so anything with a sequence shape iterates: a slice of
    // values, or the elements of text/bytes. Materialising the latter is correct because
    // neither is written through the loop variable.
    const elements: Value[] =
      b.k === "slice" ? b.elems
        : b.k === "bytes" ? [...b.v].map((byte) => ({ k: "int", v: BigInt(byte) } satisfies Value))
          : b.k === "text" ? [...b.v].map((ch) => ({ k: "text", v: ch } satisfies Value))
            // A map iterates as key/value pairs; a set iterates as its keys. That is the
            // shape destructuring `for (k, v) in m` and `for x in s` both expect.
            : b.k === "map" ? [...b.entries.values()].map((e) => ({ k: "tuple", elems: [e.key, e.val] }))
              : b.k === "set" ? [...b.entries.values()]
                : [];
    const iterable =
      b.k === "slice" || b.k === "bytes" || b.k === "text" || b.k === "map" || b.k === "set";
    if (!iterable) {
      this.report(diag("E0125", "not_iterable", `\`${b.k}\` cannot be iterated`, expr.span));
      return UNIT;
    }
    const elementwise = iter.k === "view" && iter.mutable && b.k === "slice";
    for (let i = 0; i < elements.length; i++) {
      this.tick();
      const scope = this.pushScope();
      try {
        // Over a `view mut` slice the loop variable is a mutable element binding,
        // so `x /= s` writes back into the slice rather than a copy.
        const value = elementwise
          ? { k: "view" as const, mutable: true, cell: elementCell(b, i) }
          : elements[i]!;
        if (expr.pat.kind === "bind" && value.k === "view") {
          scope.cells.push(value.cell);
          scope.names.set(expr.pat.name, value.cell);
        } else if (expr.pat.kind === "bind") {
          this.declare(expr.pat.name, value, expr.span, scope);
        } else if (!this.matchPattern(expr.pat, value, scope)) {
          continue;
        }
        for (const s of expr.body.stmts) {
          const sig = this.execStmt(s, scope);
          if (!sig) continue;
          if (sig.tag === "continue") continue;
          if (sig.tag === "break") return sig.value;
          throw sig;
        }
        if (expr.body.tail) this.eval(expr.body.tail);
        if (elementwise && expr.pat.kind === "bind") {
          const cell = scope.names.get(expr.pat.name);
          if (cell) b.elems[i] = cell.value ?? UNIT;
        }
      } finally {
        this.popScope(scope, "scope");
      }
    }
    return UNIT;
  }

  // -- places ----------------------------------------------------------------

  /** Resolve an expression to the place it names, or null if it is an rvalue. */
  private tryPlace(expr: Expr): Cell | null {
    switch (expr.kind) {
      case "path": return this.lookup(expr.value);
      case "index": {
        const base = this.tryPlace(expr.base);
        if (!base) return null;
        const held = base.value ?? UNIT;
        const container = unwrapView(held);
        if (container.k !== "slice") return null;
        const idx = this.eval(expr.index);
        if (idx.k !== "int" || idx.v < 0n || idx.v >= BigInt(container.len)) {
          this.report(diag("E0193", "index_out_of_range",
            `index is outside a slice of length ${container.len}`, expr.span));
          return null;
        }
        return elementCell(container, Number(idx.v));
      }
      case "field": {
        const base = this.tryPlace(expr.base);
        if (!base) return null;
        const held = base.value ?? UNIT;
        const container = unwrapView(held);
        if (container.k !== "record") return null;
        if (!(expr.name in container.fields)) {
          this.report(diag("E0119", "unknown_field",
            `\`${container.name ?? "record"}\` has no field \`${expr.name}\``, expr.span));
          return null;
        }
        return fieldCell(container, expr.name, expr.span);
      }
      default: return null;
    }
  }

  private lookup(name: string): Cell | null {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return null;
    for (let i = frame.scopes.length - 1; i >= 0; i--) {
      const cell = frame.scopes[i]!.names.get(name);
      if (cell) return cell;
    }
    return null;
  }

  private readCell(cell: Cell, span: Span): Value {
    if (cell.moved) {
      this.report(diag("E0412", "use_after_move",
        `\`${cell.name}\` was moved and cannot be used`, span));
      return UNIT;
    }
    const v = cell.value;
    if (v === undefined) {
      this.report(diag("E0412", "use_before_init",
        `\`${cell.name}\` is used before it is initialized`, span));
      return UNIT;
    }
    if (v.k === "resource" && v.closed) {
      this.report(diag("E0418", "use_after_drop",
        `\`${cell.name}\` is a resource that was already closed`, span));
      return UNIT;
    }
    return v;
  }

  private assignTo(target: Expr, value: Value, span: Span): void {
    const cell = this.tryPlace(target);
    if (!cell) {
      this.report(diag("E0117", "not_assignable",
        "the left side of an assignment must name a place", span));
      return;
    }
    if (cell.moved) {
      this.report(diag("E0412", "move_while_viewed",
        `\`${cell.name}\` was moved; it cannot be assigned again`, span));
      return;
    }
    // Overwriting a resource slot closes the old value exactly once first.
    const old = cell.value;
    if (old && old.k === "resource" && old !== value) {
      closeResource(this.ctx, old, "scope", span);
    }
    if (old && old.k === "shared" && old !== value) this.release(old);
    if (isResourceValue(value)) cell.resource = true;
    cell.value = value;
    // A cell standing for a slice element or a record field must also update the place
    // it mirrors, or writing through a `view` leaves the caller's data untouched.
    cell.writeBack?.(value);
    cell.initialized = true;
    cell.moved = false;
  }

  // -- destructuring `let` ---------------------------------------------------

  private bindPattern(pat: Pattern, v: Value, scope: Scope, span: Span): void {
    switch (pat.kind) {
      case "bind":
        this.declare(pat.name, v, pat.span, scope);
        return;
      case "wildcard":
        return;
      case "record": {
        const fields = this.recordPayload(v);
        if (!fields) {
          this.report(diag("E0126", "bad_destructure",
            `cannot destructure \`${v.k}\` as a record`, span));
          return;
        }
        for (const f of pat.fields) {
          if (!(f.name in fields)) {
            if (pat.rest) continue;
            this.report(diag("E0126", "bad_destructure",
              `record has no field \`${f.name}\``, span));
            return;
          }
          this.bindPattern(f.pat, fields[f.name]!, scope, span);
        }
        return;
      }
      case "tuple": {
        const elems = this.parts(v);
        if (!elems || elems.length !== pat.elems.length) {
          this.report(diag("E0126", "bad_destructure",
            `cannot destructure \`${v.k}\` as ${pat.elems.length} parts`, span));
          return;
        }
        pat.elems.forEach((p, i) => this.bindPattern(p, elems[i]!, scope, span));
        return;
      }
      case "unit":
        if (v.k !== "variant" || v.name !== pat.path) {
          this.report(diag("E0126", "bad_destructure",
            `expected variant \`${pat.path}\`, got \`${describeValue(v)}\``, span));
        }
        return;
      default:
        this.report(diag("E0126", "bad_destructure",
          "this pattern cannot be used in a `let`", span));
    }
  }

  // -- resolution helpers ----------------------------------------------------

  private module(): string {
    return this.frames[this.frames.length - 1]?.module ?? "";
  }

  /** The single user function with this name, or null if absent or ambiguous. */
  private findMethod(name: string): number | null {
    let found: number | null = null;
    for (const unit of this.program.units) {
      for (const f of unit.fns) {
        if (f.name !== name) continue;
        if (found !== null && found !== f.id) return null;
        found = f.id;
      }
    }
    return found;
  }

  /** `Ok`/`Err`/`Some`/`None`, plus every variant of every declared union. */
  private variantCtor(name: string): string | null {
    if (name === "Ok" || name === "Err" || name === "Some" || name === "None") return "builtin";
    const owners = this.variants.get(name);
    return owners && owners.length > 0 ? owners[0]! : null;
  }

  // -- results ---------------------------------------------------------------

  /** Report leaked `shared` values and return the run's verdict. */
  finish(): { ok: boolean; leaks: number[] } {
    const leaks = [...this.shareds.values()].filter((s) => s.rc > 0).map((s) => s.id);
    for (const id of leaks) {
      const rc = this.shareds.get(id)!.rc;
      this.report(diag("E0419", "shared_leak",
        `shared value #${id} still holds ${rc} reference(s) at end of run`,
        NO_SPAN, { data: { shared: id, rc } }));
    }
    return { ok: !this.failed, leaks };
  }
}

// ---------------------------------------------------------------------------
// Module-level entry points
// ---------------------------------------------------------------------------

function collect(
  interp: Interp,
  run: () => Value,
): { value: Value; ok: boolean; leaks: number[] } {
  let value: Value = UNIT;
  try {
    value = run();
  } catch (e) {
    // `Signal` and `Aborted` are control flow, not failures: they were reported.
    if (e instanceof RangeError) {
      // The native stack ran out before the depth guard did. That is the interpreter's
      // problem to absorb, not the program's: a runaway recursion must come back as a
      // diagnostic, never as an unhandled exception that takes the process with it.
      interp.report(diag("E0902", "call_depth_exceeded",
        "recursion exhausted the native stack; the program is not making progress", NO_SPAN));
    } else if (!(e instanceof Aborted) && !(e instanceof Signal)) {
      throw e;
    }
  }
  const { ok, leaks } = interp.finish();
  return { value, ok, leaks };
}

/** Run one function. Never throws; every failure is a diagnostic. */
export function runFn(
  program: Program, fnId: number, args: Value[], opts: RunOptions = {},
): RunResult {
  const interp = new Interp(program, opts);
  const { value, ok, leaks } = collect(interp, () => interp.runFn(fnId, args, opts.module));
  return {
    ok, value, diagnostics: [...interp.diagnostics, ...(interp.deciderObject?.diagnostics ?? [])], closes: interp.closes,
    leaks, fuel: interp.fuelLeft,
  };
}

/** Run one `test` item. `assert` failures are diagnostics, not crashes. */
export function runTest(program: Program, testId: number, opts: RunOptions = {}): RunResult {
  const test = program.tests.get(testId);
  if (!test) {
    return {
      ok: false, value: UNIT, closes: [], leaks: [], fuel: opts.fuel ?? 0,
      diagnostics: [diag("E0118", "unknown_name", `no test with id ${testId}`, NO_SPAN)],
    };
  }
  const interp = new Interp(program, opts);
  const { value, ok, leaks } = collect(interp, () =>
    interp.runBareBlock(test.body, opts.module ?? test.module));
  return {
    ok, value, diagnostics: [...interp.diagnostics, ...(interp.deciderObject?.diagnostics ?? [])], closes: interp.closes,
    leaks, fuel: interp.fuelLeft,
  };
}

/**
 * Peel every `view` layer off a value.
 *
 * Views nest: passing a `view mut T` into a `view mut T` parameter wraps it again, and a
 * single-level unwrap leaves a borrow that reads as un-indexable. Unwrapping here keeps
 * the nesting invisible to every place that just wants the value.
 */
function unwrapView(v: Value): Value {
  let cur = v;
  while (cur.k === "view") {
    const inner = cur.cell.value;
    if (inner === undefined) return UNIT;
    cur = inner;
  }
  return cur;
}
