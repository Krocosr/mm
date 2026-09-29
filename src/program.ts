/**
 * MM — the Program: one loaded package, plus the annotation tables every pass fills.
 *
 * A pass never re-derives resolution. It reads what earlier passes recorded here. That
 * is what makes the pipeline order (resolve → types → effects → ownership → system →
 * graph) observable, and it is why the semantic graph can answer `mm.symbol` without
 * re-running the type checker.
 *
 * See docs/spec/kernel.md §3, §5, §6, §7.
 */

import type { Diagnostic, PrimitiveName, SourceFile, Span, TypeExpr, TypeParam } from "./ast.ts";
import { BUILTIN, type Ty, TY_UNIT } from "./types.ts";
import {
  type LoweredConst, type LoweredFn, type LoweredTest, type LoweredTrait, type LoweredTypeDecl,
  type LoweredUnit, type LoweredImpl, type LoweredUse, IdGen, lowerFile,
} from "./lower.ts";

export { BUILTIN };

// ---------------------------------------------------------------------------
// Builtin type universe
// ---------------------------------------------------------------------------

export interface BuiltinField {
  name: string;
  /** Type as a mini-notation the expander parses; see `expandBuiltin`. */
  ty: string;
  attrs?: readonly string[];
}

export interface BuiltinDef {
  id: number;
  name: string;
  arity: number;
  fields?: readonly BuiltinField[];
  /** Nominal wrappers have no constructor reachable from safe code (kernel.md §6.3). */
  nominal?: boolean;
  variantNames?: readonly string[];
}

/**
 * The builtin universe. `Decision`/`Untrusted`/`Verified`/`Cap` live here rather than in
 * a prelude module so that trust-lattice rules (kernel.md §4.5) are enforced by the type
 * checker itself, not by convention in library code that a program could shadow.
 */
export const BUILTIN_TYPES: readonly BuiltinDef[] = [
  {
    id: BUILTIN.Result, name: "Result", arity: 2, variantNames: ["Ok", "Err"],
    fields: [],
  },
  { id: BUILTIN.Opt, name: "Opt", arity: 1, variantNames: ["None", "Some"] },
  { id: BUILTIN.Map, name: "Map", arity: 2 },
  { id: BUILTIN.Set, name: "Set", arity: 1 },
  {
    id: BUILTIN.Decision, name: "Decision", arity: 1,
    fields: [
      { name: "value", ty: "T" },
      { name: "probability", ty: "f32" },
      { name: "distribution", ty: "Map<T,f32>?" },
      { name: "confidence", ty: "f32" },
      { name: "provider", ty: "ProviderId" },
      { name: "model", ty: "ModelId" },
      { name: "model_version", ty: "Text?" },
      { name: "input_hash", ty: "Text" },
      { name: "timestamp", ty: "u64" },
    ],
  },
  // Trust lattice: Untrusted is what a decision produces, Verified is what deterministic
  // checking produces. There is no implicit Untrusted<T> -> Verified<T> conversion.
  { id: BUILTIN.Untrusted, name: "Untrusted", arity: 1, nominal: true },
  { id: BUILTIN.Verified, name: "Verified", arity: 1, nominal: true },
  // A Cap is unconstructible from any value; only a host grant provides it.
  { id: BUILTIN.Cap, name: "Cap", arity: 1, nominal: true },
  { id: BUILTIN.Stream, name: "Stream", arity: 1 },
  { id: BUILTIN.Context, name: "Context", arity: 1 },
  { id: BUILTIN.Handle, name: "Handle", arity: 1 },
  { id: BUILTIN.Bytes_, name: "Bytes", arity: 0 },
  { id: BUILTIN.Text_, name: "Text", arity: 0 },
  { id: BUILTIN.Ticket, name: "Ticket", arity: 0 },
  { id: BUILTIN.IoErr, name: "IoErr", arity: 0, variantNames: ["NotFound", "Denied", "Other"] },
  { id: BUILTIN.NetErr, name: "NetErr", arity: 0, variantNames: ["Timeout", "Refused", "Other"] },
  { id: BUILTIN.ProviderId, name: "ProviderId", arity: 0 },
  { id: BUILTIN.ModelId, name: "ModelId", arity: 0 },
];

export const BUILTIN_BY_NAME: Record<string, BuiltinDef> = Object.fromEntries(
  BUILTIN_TYPES.map((d) => [d.name, d]),
);

export function isNominal(id: number): boolean {
  return BUILTIN_TYPES.find((d) => d.id === id)?.nominal === true;
}

// ---------------------------------------------------------------------------
// Per-definition annotations
// ---------------------------------------------------------------------------

export interface TypeInfo {
  id: number;
  name: string;
  module: string;
  form: "record" | "union" | "choice" | "alias" | "builtin";
  /** Resolved field types for a type definition, generic vars already substituted. */
  generics: TypeParam[];
  /**
   * How many type arguments this type takes. Derived from `generics` for user types, but
   * stated explicitly for builtins, whose parameters are not written as `TypeParam`s.
   */
  arity: number;
  /** Field list as written (variants flattened for `union`). */
  fieldNames: readonly string[];
  attrs: readonly string[];
  visibility: "pub" | "priv";
  span: Span;
  nameSpan: Span;
  /** True for `@resource` types: they get a drop path. */
  isResource: boolean;
  /** True for `@wire`: has an encoder/decoder and a schema version. */
  isWire: boolean;
  /** The resolved type, filled in by the type pass. Used by the System IR's contracts. */
  ty?: Ty;
  isSecret: boolean;
  isPersist: boolean;
  /** Declared `@persist(ttl = ...)`, if any. */
  ttl?: string;
}

export interface FnInfo {
  id: number;
  name: string;
  module: string;
  fn: LoweredFn;
  /** Resolved parameter types, in order. */
  paramTys: Ty[];
  /** Resolved return type; `TY_UNIT` for a function that returns nothing. */
  retTy: Ty;
  /** Explicit effect row, or null when it was inferred. */
  declaredEffects: readonly string[] | null;
  /** Effective effect set after inference. Always populated. */
  effects: readonly string[];
  attrs: readonly string[];
  visibility: "pub" | "priv";
  unsafety: readonly string[] | null;
  isConst: boolean;
  span: Span;
  nameSpan: Span;
  /** True when this fn is a trait method or an impl of one. */
  isMethod: boolean;
  /** Trait this method implements, if any. */
  implementsTrait: string | null;
  /** Content hash, filled by the semantic graph pass. */
  contentHash?: string;
  /** Id of the `@resource`/`@intent` system plan entry, filled by the system pass. */
  systemPlanId?: number;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export interface SymbolRef {
  name: string;
  id: number;
  kind: "type" | "fn" | "const" | "test" | "trait";
}

export class Program {
  readonly units: LoweredUnit[] = [];
  readonly files: SourceFile[] = [];
  readonly ids = new IdGen();

  /** `module::name` → definition id, for every kind. */
  readonly symbols = new Map<string, SymbolRef>();
  /** Type definitions by id (includes builtins under their negative ids). */
  readonly typeInfo = new Map<number, TypeInfo>();
  /** Functions by id. */
  readonly fnInfo = new Map<number, FnInfo>();
  /** Constants by id. */
  readonly consts = new Map<number, LoweredConst>();
  /** Tests by id. */
  readonly tests = new Map<number, LoweredTest>();
  /** Traits by id. */
  readonly traits = new Map<number, LoweredTrait>();
  /** Impl blocks by id. */
  readonly impls = new Map<number, LoweredImpl>();
  /** Modules that appeared, in load order. */
  readonly modules: string[] = [];

  readonly diagnostics: Diagnostic[] = [];
  /** Set when a pass produced an unrecoverable inconsistency. */
  internalError: string | null = null;

  private readonly typesByModule = new Map<string, Map<string, number>>();
  private readonly fnsByModule = new Map<string, Map<string, number[]>>();

  constructor() {
    for (const def of BUILTIN_TYPES) {
      this.typeInfo.set(def.id, {
        id: def.id,
        name: def.name,
        module: "<builtin>",
        form: def.variantNames ? "union" : def.fields?.length ? "record" : "alias",
        generics: [],
        arity: def.arity,
        fieldNames: def.variantNames ?? (def.fields ?? []).map((f) => f.name),
        attrs: [],
        visibility: "pub",
        span: { start: 0, end: 0, file: -1 },
        nameSpan: { start: 0, end: 0, file: -1 },
        isResource: false,
        isWire: false,
        isSecret: false,
        isPersist: false,
      });
    }
  }

  // -- loading -------------------------------------------------------------

  addFile(source: SourceFile): LoweredUnit {
    const index = this.files.length;
    this.files.push(source);
    const unit = lowerFile(source, index, this.ids);
    this.units.push(unit);
    if (!this.modules.includes(unit.module)) this.modules.push(unit.module);
    this.diagnostics.push(...unit.diagnostics);
    this.indexUnit(unit);
    return unit;
  }

  private indexUnit(unit: LoweredUnit): void {
    const typeMap = this.typesByModule.get(unit.module) ?? new Map<string, number>();
    const fnMap = this.fnsByModule.get(unit.module) ?? new Map<string, number[]>();

    for (const t of unit.types) {
      const key = `${unit.module}::${t.def.name}`;
      if (this.symbols.has(key)) {
        this.diagnostics.push({
          code: "E0202", kind: "duplicate_definition", severity: "error",
          message: `\`${t.def.name}\` is already defined in module \`${unit.module}\``,
          span: t.nameSpan, value: key,
        });
      }
      this.symbols.set(key, { name: t.def.name, id: t.id, kind: "type" });
      typeMap.set(t.def.name, t.id);

      this.typeInfo.set(t.id, {
        id: t.id,
        name: t.def.name,
        module: unit.module,
        form: t.def.form,
        generics: t.def.generics,
        arity: t.def.generics.length,
        fieldNames: t.def.form === "union"
          ? t.def.variants.map((v) => v.name)
          : t.def.form === "record"
            ? t.def.fields.map((f) => f.name)
            : [],
        attrs: t.attrs.map((a) => a.name),
        visibility: t.visibility,
        span: t.span,
        nameSpan: t.nameSpan,
        isResource: t.attrs.some((a) => a.name === "resource"),
        isWire: t.attrs.some((a) => a.name === "wire"),
        isSecret: t.attrs.some((a) => a.name === "secret"),
        isPersist: t.attrs.some((a) => a.name === "persist"),
        ttl: t.attrs.find((a) => a.name === "persist")?.args["ttl"]?.kind === "duration"
          ? (t.attrs.find((a) => a.name === "persist")!.args["ttl"] as { value: string }).value
          : t.attrs.find((a) => a.name === "persist")?.args["ttl"]?.kind === "number"
            ? (t.attrs.find((a) => a.name === "persist")!.args["ttl"] as { value: string }).value
            : undefined,
      });
    }

    for (const f of unit.fns) {
      // A method is reached through its trait or impl, never as a module-level name, so
      // it is indexed for queries but kept out of the module namespace. Without this, a
      // trait method and its implementation would collide as a duplicate definition.
      const isMethod = unit.methodIds.has(f.id);
      const implementsTrait = unit.traits.find((t) => t.methods.some((m) => m.id === f.id))?.name
        ?? unit.impls.find((i) => i.methods.some((m) => m.id === f.id))?.trait
        ?? null;
      if (!isMethod) {
        const key = `${unit.module}::${f.name}`;
        const existing = fnMap.get(f.name);
        if (existing) {
          this.diagnostics.push({
            code: "E0202", kind: "duplicate_definition", severity: "error",
            message: `\`${f.name}\` is already defined in module \`${unit.module}\``,
            span: f.nameSpan, value: key,
          });
          existing.push(f.id);
        } else {
          fnMap.set(f.name, [f.id]);
        }
        this.symbols.set(key, { name: f.name, id: f.id, kind: "fn" });
      }
      this.fnInfo.set(f.id, {
        id: f.id,
        name: f.name,
        module: unit.module,
        fn: f,
        paramTys: f.params.map(() => TY_UNIT),
        retTy: TY_UNIT,
        declaredEffects: f.effects,
        effects: f.effects ?? [],
        attrs: f.attrs.map((a) => a.name),
        visibility: f.visibility,
        unsafety: f.unsafety,
        isConst: f.isConst,
        span: f.span,
        nameSpan: f.nameSpan,
        isMethod,
        implementsTrait,
      });
    }

    for (const t of unit.traits) {
      this.symbols.set(`${unit.module}::${t.name}`, { name: t.name, id: t.id, kind: "trait" });
      this.traits.set(t.id, t);
    }
    for (const i of unit.impls) this.impls.set(i.id, i);
    for (const c of unit.consts) {
      this.symbols.set(`${unit.module}::${c.name}`, { name: c.name, id: c.id, kind: "const" });
      this.consts.set(c.id, c);
    }
    for (const t of unit.tests) this.tests.set(t.id, t);

    this.typesByModule.set(unit.module, typeMap);
    this.fnsByModule.set(unit.module, fnMap);
  }

  // -- resolution ----------------------------------------------------------

  /** Resolve a bare name in a module, then in the builtin universe, then by unique suffix. */
  resolveType(name: string, module: string): number | null {
    const local = this.typesByModule.get(module)?.get(name);
    if (local !== undefined) return local;
    const builtin = BUILTIN_BY_NAME[name];
    if (builtin) return builtin.id;
    // Unique-suffix resolution across loaded modules, so cross-module work needs no
    // `use` ceremony when the name is unambiguous.
    let found: number | null = null;
    for (const [mod, map] of this.typesByModule) {
      if (mod === module) continue;
      const id = map.get(name);
      if (id !== undefined) {
        if (found !== null) return null;
        found = id;
      }
    }
    return found;
  }

  resolveFn(name: string, module: string): number | null {
    const local = this.fnsByModule.get(module)?.get(name);
    if (local && local.length > 0) return local[0]!;
    let found: number | null = null;
    for (const [mod, map] of this.fnsByModule) {
      if (mod === module) continue;
      const ids = map.get(name);
      if (ids && ids.length > 0) {
        if (found !== null) return null;
        found = ids[0]!;
      }
    }
    return found;
  }

  resolveConst(name: string, module: string): number | null {
    for (const c of this.consts.values()) {
      if (c.name === name && c.module === module) return c.id;
    }
    for (const c of this.consts.values()) {
      if (c.name === name) return c.id;
    }
    return null;
  }

  /** All functions across all modules, in load order. */
  allFns(): FnInfo[] {
    return [...this.fnInfo.values()];
  }

  allTypes(): TypeInfo[] {
    return [...this.typeInfo.values()].filter((t) => t.module !== "<builtin>");
  }

  /** Errors only, in a stable order. */
  errors(): Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === "error");
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === "error");
  }
}

// ---------------------------------------------------------------------------
// Field expansion (drives isCopy and the semantic graph)
// ---------------------------------------------------------------------------

/**
 * Resolve a named type's field list with generic args substituted.
 *
 * Returns null when the checker has no expansion (opaque builtin, or a type still being
 * defined), which makes `isCopy` conservative rather than wrong.
 */
export function expandTypeFields(
  program: Program,
  def: number,
  args: readonly Ty[],
  resolve: (expr: TypeExpr, generics: ReadonlyMap<string, Ty>) => Ty,
  generics: ReadonlyMap<string, Ty> = new Map(),
): { name: string; ty: Ty; attrs: readonly string[] }[] | null {
  const builtin = BUILTIN_TYPES.find((d) => d.id === def);
  if (builtin) {
    return (builtin.fields ?? []).map((f) => ({
      name: f.name,
      ty: resolveMini(program, f.ty, args, resolve),
      attrs: f.attrs ?? [],
    }));
  }
  const unit = program.units.find((u) => u.types.some((t) => t.id === def));
  const decl = unit?.types.find((t) => t.id === def);
  if (!decl) return null;
  const map = new Map(generics);
  decl.def.generics.forEach((g, i) => map.set(g.name, args[i] ?? TY_UNIT));
  if (decl.def.form === "record") {
    return decl.def.fields.map((f) => ({
      name: f.name,
      ty: resolve(f.ty, map),
      attrs: f.attrs.map((a) => a.name),
    }));
  }
  if (decl.def.form === "union") {
    // A union is not transparent: its value is one of the variants, and copying it
    // requires every variant's fields to be Copy, which `resolve` cannot express as a
    // flat field list. The type checker handles unions directly; return null so
    // `isCopy` stays conservative.
    return null;
  }
  if (decl.def.form === "alias") {
    // Expand *through* the alias, guarding against a self-referential alias cycle
    // (`type A = A`), which would otherwise recurse forever.
    const target = resolve(decl.def.target, map);
    if (target.k === "named" && target.def !== def) {
      return expandTypeFields(program, target.def, target.args, resolve, map);
    }
    if (target.k === "named" && target.def === def) return null;
    return [{ name: "$alias", ty: target, attrs: [] }];
  }
  return null;
}

const MINI_PRIMS: Record<string, PrimitiveName> = {
  u8: "u8", u16: "u16", u32: "u32", u64: "u64", usize: "usize",
  i8: "i8", i16: "i16", i32: "i32", i64: "i64", isize: "isize",
  f32: "f32", f64: "f64", bool: "bool", char: "char", Text: "Text", Bytes: "Bytes",
  Path: "Path", Fd: "Fd", Void: "Void",
};

/** Parse the tiny type notation used by builtin field tables (`Map<T,f32>?`). */
function resolveMini(
  program: Program,
  mini: string,
  args: readonly Ty[],
  resolve: (expr: TypeExpr, generics: ReadonlyMap<string, Ty>) => Ty,
): Ty {
  let s = mini.trim();
  let optional = false;
  if (s.endsWith("?")) { optional = true; s = s.slice(0, -1); }
  const call = /^([A-Za-z_][A-Za-z0-9_]*)<(.*)>$/.exec(s);
  if (call) {
    const name = call[1]!;
    const parts = call[2]!.split(",").map((p) => resolveMini(program, p, args, resolve));
    const def = BUILTIN_BY_NAME[name] ? BUILTIN_BY_NAME[name]!.id : program.resolveType(name, "<builtin>");
    if (def === null) return TY_UNIT;
    const ty: Ty = { k: "named", def, args: parts };
    return optional ? { k: "option", inner: ty } : ty;
  }
  if (MINI_PRIMS[s]) return { k: "prim", name: MINI_PRIMS[s]! };
  if (s === "T") return args[0] ?? TY_UNIT;
  const def = BUILTIN_BY_NAME[s] ? BUILTIN_BY_NAME[s]!.id : program.resolveType(s, "<builtin>");
  if (def === null) return TY_UNIT;
  const ty: Ty = { k: "named", def, args: [] };
  return optional ? { k: "option", inner: ty } : ty;
}

export type { LoweredFn, LoweredTypeDecl, LoweredUnit, LoweredUse, SourceFile };
