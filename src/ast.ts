/**
 * MM — AST, spans, diagnostics.
 *
 * This file is the single source of truth for the surface syntax tree. Every pass
 * (lexer, parser, formatter, type checker, ownership checker, semantic graph, interpreter)
 * imports from here. Changing a node shape here changes every pass; that is intentional.
 *
/**
 * A half-open range `[start, end)` of UTF-16 code-unit offsets into a source file.
 *
 * Code units, not bytes: every consumer slices the source string with these numbers, and
 * `SourceFile.bytes` exists for the consumers that genuinely want encoded bytes.
 */

// ---------------------------------------------------------------------------
// Source positions
// ---------------------------------------------------------------------------

/** A half-open byte range [start, end) into a source file. */
export interface Span {
  /** 0-based byte offset of the first byte. */
  readonly start: number;
  /** 0-based byte offset one past the last byte. */
  readonly end: number;
  /** Index into `SourceFile.files`. */
  readonly file: number;
}

export function span(start: number, end: number, file = 0): Span {
  return { start, end, file };
}

/** Smallest span covering both inputs. */
export function joinSpans(a: Span, b: Span): Span {
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    file: a.file,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * A suggested repair. `confidence` is the checker's actual post-verification
 * confidence: a repair is only emitted after the candidate has been re-checked
 * (kernel.md §10). Unverifiable repairs are omitted.
 */
export type Repair =
  | { op: "reorder"; confidence: number; note?: string }
  | { op: "clone"; confidence: number; cost: "allocation"; note?: string }
  | { op: "change_owner"; to: "shared" | "arena" | "handle" | "copy"; confidence: number; note?: string }
  | { op: "add_effect"; effect: string; confidence: number; note?: string }
  | { op: "insert_unsafe"; caps: string[]; confidence: number; note?: string }
  | { op: "narrow_param"; to: string; confidence: number; note?: string };

/**
 * Machine form is canonical (kernel.md §10). Agents branch on `code` and `kind`,
 * never on `message` prose.
 */
export interface Diagnostic {
  readonly code: string;
  /** Stable kebab-case slug, e.g. "move_while_viewed". */
  readonly kind: string;
  readonly severity: "error" | "warning" | "note";
  /** Human sentence. Never contains @secret values (kernel.md §A-5). */
  readonly message: string;
  readonly span: Span;
  /** Semantic-graph value id the diagnostic is about, if any. */
  readonly value?: string;
  /** Additional spans the human form should show (e.g. the conflicting view). */
  readonly related?: ReadonlyArray<{ span: Span; label: string }>;
  readonly repairs?: ReadonlyArray<Repair>;
  /** Machine-readable extra payload, pass-specific. */
  readonly data?: Readonly<Record<string, unknown>>;
}

export function diag(
  code: string,
  kind: string,
  message: string,
  span: Span,
  extra: Partial<Omit<Diagnostic, "code" | "kind" | "message" | "span">> = {},
): Diagnostic {
  return { code, kind, severity: "error", message, span, ...extra };
}

/** Thrown by the parser; carries one or more diagnostics. */
export class MMDiagnostic extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics[0]?.message ?? "MM diagnostics");
    this.name = "MMDiagnostic";
  }
}

/** Internal compiler failure. Always a bug (kernel.md §11). */
export class MMInternal extends Error {
  constructor(code: string, message: string) {
    super(`E0900 ${code}: ${message}`);
    this.name = "MMInternal";
  }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export type AttrArg =
  | { kind: "ident"; name: string; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "number"; value: string; span: Span }
  | { kind: "path"; segments: string[]; span: Span }
  | { kind: "duration"; value: string; span: Span };

export interface Attribute {
  /** Attribute name without `@`. */
  readonly name: string;
  /** `resource(close = fs.close)` → `[{kind:"ident", name:"close", ...}, ...]` keyed below. */
  readonly args: Record<string, AttrArg>;
  readonly span: Span;
}

// ---------------------------------------------------------------------------
// Types (surface syntax)
// ---------------------------------------------------------------------------

export type PrimitiveName =
  | "u8" | "u16" | "u32" | "u64" | "usize"
  | "i8" | "i16" | "i32" | "i64" | "isize"
  | "f32" | "f64"
  | "bool" | "char" | "Void"
  | "Text" | "Bytes" | "c8" | "Path" | "Fd";

/** Static primitive-name membership table. */
export const PRIMITIVES: Record<string, true> = {
  u8: true, u16: true, u32: true, u64: true, usize: true,
  i8: true, i16: true, i32: true, i64: true, isize: true,
  f32: true, f64: true,
  bool: true, char: true, Void: true,
  Text: true, Bytes: true, c8: true, Path: true, Fd: true,
};

/** Ownership discipline of a value (kernel.md §3.4). */
export type Ownership = "owned" | "view" | "viewmut" | "shared" | "arena" | "handle";

export type TypeExpr =
  /** `T` — a named type, possibly generic-applied. */
  | { kind: "path"; segments: string[]; args: TypeExpr[]; span: Span }
  /** `f32` and friends. */
  | { kind: "prim"; name: PrimitiveName; span: Span }
  /** `{ x: f32, y: f32 }` — inline record. */
  | { kind: "record"; fields: FieldDecl[]; span: Span }
  /** `(A, B)` — tuple. */
  | { kind: "tuple"; elems: TypeExpr[]; span: Span }
  /** `[T]` — slice; `len` set for `[T; N]`. */
  | { kind: "slice"; elem: TypeExpr; len: number | null; lenExpr?: Expr; span: Span }
  /** `?T` — optional. */
  | { kind: "option"; inner: TypeExpr; span: Span }
  /** `*const T` / `*mut T` — raw pointer. */
  | { kind: "ptr"; mutable: boolean; inner: TypeExpr; span: Span }
  /** `view T` / `view mut T` / `shared T` / `arena T` / `handle T` */
  | { kind: "own"; ownership: Ownership; inner: TypeExpr; span: Span }
  /** `fn(A, B) -> C` — function type. */
  | { kind: "fnptr"; params: TypeExpr[]; ret: TypeExpr; effects: string[]; span: Span }
  /** `impl Trait` — opaque. */
  | { kind: "impl"; traits: string[]; span: Span };

export interface FieldDecl {
  readonly name: string;
  readonly ty: TypeExpr;
  readonly span: Span;
  readonly attrs: Attribute[];
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type UnaryOp = "-" | "!" | "*" | "&" | "&mut";

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&&" | "||"
  | "|" | "&" | "^" | "<<" | ">>";

export type Expr =
  | { kind: "int"; value: bigint; ty?: TypeExpr; span: Span }
  | { kind: "float"; value: number; ty?: TypeExpr; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bytes"; value: Uint8Array; span: Span }
  | { kind: "char"; value: string; span: Span }
  | { kind: "path"; value: string; span: Span }
  | { kind: "field"; base: Expr; name: string; nameSpan: Span; span: Span }
  | { kind: "index"; base: Expr; index: Expr; span: Span }
  | { kind: "call"; callee: Expr; args: Expr[]; typeArgs?: TypeExpr[]; span: Span }
  | { kind: "method"; base: Expr; name: string; nameSpan: Span; args: Expr[]; typeArgs?: TypeExpr[]; span: Span }
  | { kind: "unary"; op: UnaryOp; operand: Expr; span: Span }
  | { kind: "binary"; op: BinaryOp; lhs: Expr; rhs: Expr; span: Span }
  | { kind: "assign"; target: Expr; value: Expr; span: Span }
  | { kind: "try"; operand: Expr; span: Span }
  | { kind: "cast"; operand: Expr; ty: TypeExpr; span: Span }
  | { kind: "struct"; path: string; typeArgs?: TypeExpr[]; fields: FieldInit[]; span: Span }
  | { kind: "array"; elems: Expr[]; span: Span }
  | { kind: "tuple"; elems: Expr[]; span: Span }
  | { kind: "block"; block: Block; span: Span }
  | { kind: "if"; cond: Expr; then: Block; else_?: Block | Expr; span: Span }
  | { kind: "match"; scrutinee: Expr; arms: MatchArm[]; span: Span }
  | { kind: "while"; cond: Expr; body: Block; span: Span }
  | { kind: "loop"; body: Block; span: Span }
  | { kind: "for"; pat: Pattern; iter: Expr; body: Block; span: Span }
  | { kind: "return"; value?: Expr; span: Span }
  | { kind: "break"; value?: Expr; span: Span }
  | { kind: "continue"; span: Span }
  /** `!{...}` literal effect set, or a bare effect name, used by `@intent` etc. */
  | { kind: "effectset"; effects: string[]; span: Span }
  /** `x is Type` / `x as Type` are sugar; `is` is its own form. */
  | { kind: "is"; base: Expr; ty: TypeExpr; span: Span }
  /** `unsafe { ... }` / `unsafe[ffi] { ... }` */
  | { kind: "unsafe"; caps: string[]; body: Block; span: Span }
  /** `move x` — explicit move request. */
  | { kind: "move"; operand: Expr; span: Span }
  /** `view e` / `view mut e` — explicit view creation. */
  | { kind: "view"; mutable: boolean; operand: Expr; span: Span }
  /** `spawn { ... }` / `task { ... }` — structured concurrency. */
  | { kind: "spawn"; body: Block; transfer: "move" | "shared"; span: Span }
  /** `handle_to e` — arena→handle conversion. */
  | { kind: "tohandle"; operand: Expr; span: Span }
  /** `const { ... }` — inline const evaluation. */
  | { kind: "consteval"; body: Block; span: Span };

export interface FieldInit {
  readonly name: string;
  readonly value: Expr;
  readonly span: Span;
}

export interface MatchArm {
  readonly pat: Pattern;
  readonly body: Expr;
  readonly span: Span;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export type Pattern =
  /** `_` */
  | { kind: "wildcard"; span: Span }
  /** literal: int/float/bool/string/char, optionally negative */
  | { kind: "lit"; value: Expr; span: Span }
  /** `x` — binding */
  | { kind: "bind"; name: string; mutable: boolean; ty?: TypeExpr; span: Span }
  /** `Variant` — nullary variant */
  | { kind: "unit"; path: string; span: Span }
  /** `Variant(a, b)` */
  | { kind: "tuple"; path: string; elems: Pattern[]; span: Span }
  /** `Variant { field, .. }` */
  | { kind: "record"; path: string; fields: PatternField[]; rest: boolean; span: Span }
  /** `x @ pat` — binding at-pattern */
  | { kind: "at"; name: string; sub: Pattern; span: Span }
  /** `a | b` — or-pattern */
  | { kind: "or"; alts: Pattern[]; span: Span }
  /** `Some(x)` style with a leading path + no parens: `Some x` is not valid; require parens */

export interface PatternField {
  readonly name: string;
  readonly pat: Pattern;
  readonly span: Span;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Stmt =
  | { kind: "let"; pat: Pattern; ty?: TypeExpr; init?: Expr; mutable: boolean; span: Span }
  | { kind: "expr"; expr: Expr; span: Span }
  | { kind: "item"; item: Item; span: Span }
  | { kind: "assign"; target: Expr; value: Expr; span: Span };

export interface Block {
  readonly stmts: Stmt[];
  /** Trailing expression, if any. Its value is the block's value. */
  readonly tail?: Expr;
  readonly span: Span;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface Param {
  readonly name: string;
  readonly ty: TypeExpr;
  readonly attrs: Attribute[];
  readonly span: Span;
}

export interface FnItem {
  readonly kind: "fn";
  readonly name: string;
  readonly generics: TypeParam[];
  readonly params: Param[];
  readonly ret?: TypeExpr;
  /** `!{...}` row. `null` means absent (inferred inside module, required on `pub`). */
  readonly effects: string[] | null;
  readonly body: Block;
  readonly attrs: Attribute[];
  readonly visibility: "pub" | "priv";
  readonly unsafety: string[] | null;
  readonly externAbi: string | null;
  readonly isConst: boolean;
  readonly span: Span;
  readonly nameSpan: Span;
}

export interface TypeParam {
  readonly name: string;
  readonly bounds: string[];
  readonly span: Span;
}

export type TypeDef =
  /** `type Name = { ... }` */
  | {
      kind: "record";
      name: string;
      generics: TypeParam[];
      fields: FieldDecl[];
      span: Span;
      nameSpan: Span;
    }
  /** `type Name = A { .. } | B { .. }` */
  | {
      kind: "union";
      name: string;
      generics: TypeParam[];
      variants: VariantDecl[];
      span: Span;
      nameSpan: Span;
    }
  /** `type Name = choice { a, b }` */
  | {
      kind: "choice";
      name: string;
      generics: TypeParam[];
      choices: string[];
      span: Span;
      nameSpan: Span;
    }
  /** `type Name = OtherType` — alias */
  | {
      kind: "alias";
      name: string;
      generics: TypeParam[];
      target: TypeExpr;
      span: Span;
      nameSpan: Span;
    };

export interface VariantDecl {
  readonly name: string;
  readonly fields: FieldDecl[];
  readonly span: Span;
}

export interface TypeItem {
  readonly kind: "type";
  readonly def: TypeDef;
  readonly attrs: Attribute[];
  readonly visibility: "pub" | "priv";
  readonly span: Span;
}

export interface UseItem {
  readonly kind: "use";
  /** `std.fs.{read, write}` → segments with a trailing list group. */
  readonly tree: UseTree;
  readonly span: Span;
}

export type UseTree =
  | { kind: "name"; segments: string[]; alias: string | null; span: Span }
  | { kind: "list"; prefix: string[]; items: UseTree[]; span: Span };

export interface TraitItem {
  readonly kind: "trait";
  readonly name: string;
  readonly generics: TypeParam[];
  readonly methods: FnItem[];
  readonly attrs: Attribute[];
  readonly visibility: "pub" | "priv";
  readonly span: Span;
  readonly nameSpan: Span;
}

export interface ImplItem {
  readonly kind: "impl";
  readonly trait: string;
  readonly typeName: string;
  readonly generics: TypeParam[];
  readonly methods: FnItem[];
  readonly attrs: Attribute[];
  readonly span: Span;
}

export interface ConstItem {
  readonly kind: "const";
  readonly name: string;
  readonly ty?: TypeExpr;
  readonly value: Expr;
  readonly attrs: Attribute[];
  readonly visibility: "pub" | "priv";
  readonly span: Span;
  readonly nameSpan: Span;
}

export interface TestItem {
  readonly kind: "test";
  readonly name: string;
  readonly body: Block;
  readonly attrs: Attribute[];
  readonly span: Span;
  readonly nameSpan: Span;
}

export type Item =
  | FnItem
  | TypeItem
  | UseItem
  | TraitItem
  | ImplItem
  | ConstItem
  | TestItem;

// ---------------------------------------------------------------------------
// Source file
// ---------------------------------------------------------------------------

export interface SourceFile {
  /** Path relative to the package root, `::`-separated. This is the module identity. */
  readonly module: string;
  readonly text: string;
  readonly bytes: Uint8Array;
}

export interface ParsedFile {
  readonly file: SourceFile;
  readonly items: Item[];
  readonly diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Program-level AST → HIR lowering
// ---------------------------------------------------------------------------

/** A type alias to a record, used after lowering. */
export interface LoweredField extends FieldDecl {
  /** Resolved to a graph node id by the resolver. */
  typeRef: number;
}

export type LoweredTypeDef =
  | Omit<Extract<TypeDef, { kind: "record" }>, "fields"> & { fields: LoweredField[] }
  | Omit<Extract<TypeDef, { kind: "union" }>, "variants"> & {
      variants: Array<Omit<VariantDecl, "fields"> & { fields: LoweredField[] }>;
    }
  | Omit<Extract<TypeDef, { kind: "choice" }>, "choices"> & { choices: string[] }
  | Omit<Extract<TypeDef, { kind: "alias" }>, "target"> & { target: TypeExpr };

export interface LoweredFn {
  readonly kind: "fn";
  readonly id: number;
  readonly name: string;
  readonly module: string;
  readonly generics: TypeParam[];
  readonly params: Array<LoweredParam>;
  readonly ret: TypeExpr | null;
  readonly effects: string[] | null;
  readonly body: Block;
  readonly attrs: Attribute[];
  readonly visibility: "pub" | "priv";
  readonly unsafety: string[] | null;
  readonly externAbi: string | null;
  readonly isConst: boolean;
  readonly span: Span;
  readonly nameSpan: Span;
  /** Inferred effect set, filled by the effect checker. */
  inferredEffects?: string[];
  /** Signature hash, used as the graph's semantic identity for this fn. */
  signatureHash?: string;
}

export interface LoweredParam {
  readonly name: string;
  readonly ty: TypeExpr;
  readonly attrs: Attribute[];
  readonly span: Span;
  id: number;
  /** Ownership discipline extracted from the declared type. */
  ownership: Ownership;
}

export type LoweredItem =
  | LoweredFn
  | { kind: "type"; id: number; def: LoweredTypeDef; attrs: Attribute[]; visibility: "pub" | "priv"; span: Span }
  | UseItem
  | { kind: "trait"; id: number; item: TraitItem; methods: number[]; span: Span }
  | { kind: "impl"; id: number; trait: string; typeName: string; generics: TypeParam[]; methods: number[]; span: Span }
  | { kind: "const"; id: number; item: ConstItem; span: Span }
  | { kind: "test"; id: number; item: TestItem; span: Span };

export interface LoweredFile {
  readonly file: SourceFile;
  readonly items: LoweredItem[];
  /** Every `fn` in this file, in declaration order, for the effect and ownership passes. */
  readonly fns: LoweredFn[];
  readonly diagnostics: Diagnostic[];
}
