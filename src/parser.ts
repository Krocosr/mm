/**
 * MM — recursive-descent parser.
 *
 * Errors are recovered, not thrown: on a bad expression the parser skips to the next
 * `;` / `}` / item boundary and keeps going, so one file yields all its diagnostics.
 * Throwing would cost an agent an extra compile round trip per error, which is exactly
 * the loop this language exists to shorten.
 *
 * See docs/spec/kernel.md §2.
 */

import {
  type AttrArg, type Attribute, type BinaryOp, type Block, type Expr, type FieldDecl,
  type FieldInit, type FnItem, type Item, type MatchArm, type Ownership, type Param,
  type Pattern, type PatternField, type PrimitiveName, type Span, type Stmt, type TestItem, type TraitItem,
  type ImplItem, type TypeExpr, type TypeItem, type TypeParam, type UseItem, type UseTree,
  type VariantDecl, type ConstItem, type SourceFile, type ParsedFile, type Diagnostic,
  PRIMITIVES, diag,
} from "./ast.ts";
import { type Token, lex } from "./lexer.ts";

/** Statement-position keywords that terminate an expression. */
const STMT_STOP: Record<string, true> = {
  let: true, return: true, break: true, continue: true, type: true, fn: true, trait: true,
  impl: true, const: true, test: true, use: true, pub: true, unsafe: true, extern: true,
};

/** Binary operator precedence, low binds loosest. */
const BINARY_PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "|": 4,
  "^": 5,
  "&": 6,
  "<<": 7, ">>": 7,
  "+": 8, "-": 8,
  "*": 9, "/": 9, "%": 9,
};

/**
 * Raised when a recovery loop fails to make progress, so parsing a malformed file can
 * never spin until the engine exhausts its heap. Caught by `parseFile`, which turns it
 * into a single diagnostic. Any well-formed file uses orders of magnitude fewer steps.
 */
class ParseBudgetExceeded extends Error {
  constructor(steps: number) {
    super(`parse budget exhausted after ${steps} steps`);
    this.name = "ParseBudgetExceeded";
  }
}

class Parser {
  private toks: Token[];
  private pos = 0;
  readonly diags: Diagnostic[] = [];
  /**
   * Suppress struct-literal parsing, used only where a `{` after an expression opens a
   * body rather than a record: `if c {`, `while c {`, `for x in xs {`, `match x {`.
   *
   * It is deliberately *not* set for call arguments, array or tuple literals, binary
   * operands, or index expressions. Nothing else can legally follow an expression with
   * `{` in those positions, and suppressing there made `f(Point { x: 1 })` — the single
   * most common way to build a value — unparseable.
   */
  private noStruct = 0;

  constructor(private readonly file: SourceFile, private readonly fileIndex: number) {
    const lexed = lex(file.text, fileIndex);
    this.toks = lexed.tokens;
    this.diags.push(...lexed.diagnostics);
  }

  // -- token helpers --------------------------------------------------------

  private peek(off = 0): Token {
    return this.toks[Math.min(this.pos + off, this.toks.length - 1)]!;
  }
  private get cur(): Token {
    return this.toks[this.pos]!;
  }
  private at(text: string, off = 0): boolean {
    const t = this.peek(off);
    return (t.kind === "punct" || t.kind === "keyword" || t.kind === "ident") && t.text === text;
  }
  private atKw(...names: string[]): boolean {
    return this.cur.kind === "keyword" && names.includes(this.cur.text);
  }
  /**
   * Hard cap on tokens consumed for one file.
   *
   * This is a backstop, not a limit any well-formed program reaches: a real file is
   * orders of magnitude below it. It exists so that a *recovery* bug — a loop that fails
   * to make progress on malformed input — degrades into one diagnostic instead of
   * spinning until the engine exhausts its heap. Compiler robustness on bad input is a
   * correctness property, not a nicety.
   */
  private static readonly STEP_BUDGET = 5_000_000;
  private steps = 0;

  private bump(): Token {
    if (++this.steps > Parser.STEP_BUDGET) {
      throw new ParseBudgetExceeded(this.toks.length);
    }
    const t = this.cur;
    if (this.pos < this.toks.length - 1) this.pos += 1;
    return t;
  }
  private eat(text: string): boolean {
    if (this.at(text)) { this.bump(); return true; }
    return false;
  }
  private eatKw(...names: string[]): boolean {
    if (this.atKw(...names)) { this.bump(); return true; }
    return false;
  }
  private expect(text: string, what: string): Token | null {
    if (this.at(text)) return this.bump();
    this.error("E0102", "expected_token", `expected \`${text}\`${what ? ` ${what}` : ""}, found \`${this.cur.text || "<eof>"}\``, this.cur.span);
    return null;
  }
  private expectKw(name: string, what: string): Token | null {
    if (this.atKw(name)) return this.bump();
    this.error("E0102", "expected_token", `expected \`${name}\` ${what}, found \`${this.cur.text || "<eof>"}\``, this.cur.span);
    return null;
  }
  private expectIdent(what: string): Token | null {
    if (this.cur.kind === "ident") return this.bump();
    this.error("E0102", "expected_ident", `expected ${what}, found \`${this.cur.text || "<eof>"}\``, this.cur.span);
    return null;
  }
  private error(code: string, kind: string, message: string, span: Span, data?: Record<string, unknown>): void {
    this.diags.push(diag(code, kind, message, span, data ? { data } : {}));
  }
  private start(): number {
    return this.cur.span.start;
  }
  private finish(start: number, end?: number): Span {
    return {
      start,
      end: end ?? (this.pos > 0 ? this.toks[this.pos - 1]!.span.end : start),
      file: this.fileIndex,
    };
  }

  /**
   * EOF check as a call rather than a `this.cur.kind` comparison: TypeScript narrows a
   * getter's property type inside the branch that tested it, which makes a later
   * `.kind !== "eof"` read a provably-false comparison. The call keeps the check real.
   */
  private atEof(): boolean {
    return this.cur.kind === "eof";
  }

  /** Skip to a recovery point. Used after an unrecoverable item error. */
  private recoverItem(): void {
    let depth = 0;
    while (this.cur.kind !== "eof") {
      if (this.at("{")) depth += 1;
      else if (this.at("}")) {
        depth -= 1;
        if (depth <= 0) { this.bump(); return; }
      } else if (depth === 0 && this.at("@")) return;
      else if (depth === 0 && (this.atKw("fn", "type", "trait", "impl", "const", "test", "use", "pub", "unsafe", "extern"))) return;
      this.bump();
    }
  }

  // -- top level -----------------------------------------------------------

  parseFile(): ParsedFile {
    const items: Item[] = [];
    try {
      while (this.cur.kind !== "eof") {
        const before = this.pos;
        const item = this.parseItem();
        if (item) items.push(item);
        if (this.pos === before) this.bump(); // guarantee progress
      }
    } catch (err) {
      // A budget overrun means a recovery bug, not a user error. Report it as one
      // diagnostic and return the items recovered so far, so the editor stays usable.
      if (!(err instanceof ParseBudgetExceeded)) throw err;
      this.diags.push(
        diag(
          "E0199",
          "parse_budget_exhausted",
          `parsing stopped after ${this.steps} steps: the input triggered a parser loop that made no progress`,
          this.cur.span,
        ),
      );
    }
    return { file: this.file, items, diagnostics: this.diags };
  }

  private parseAttributes(): Attribute[] {
    const attrs: Attribute[] = [];
    while (this.at("@")) {
      const start = this.start();
      this.bump();
      const nameTok = this.cur.kind === "ident" ? this.bump() : null;
      if (!nameTok) {
        this.error("E0107", "expected_attr_name", "expected attribute name after `@`", this.cur.span);
        return attrs;
      }
      const args: Record<string, AttrArg> = {};
      if (this.at("(")) {
        this.bump();
        while (!this.at(")") && this.cur.kind !== "eof") {
          const keyTok = this.expectIdent("attribute argument");
          if (!keyTok) break;
          let value: AttrArg = { kind: "ident", name: "true", span: keyTok.span };
          if (this.eat("=")) value = this.parseAttrValue();
          args[keyTok.text] = value;
          if (!this.eat(",")) break;
        }
        this.expect(")", "closing attribute arguments");
      }
      attrs.push({ name: nameTok.text, args, span: this.finish(start) });
    }
    return attrs;
  }

  private parseAttrValue(): AttrArg {
    const t = this.cur;
    if (t.kind === "string") { this.bump(); return { kind: "string", value: String(t.value), span: t.span }; }
    if (t.kind === "int") { this.bump(); return { kind: "number", value: t.text, span: t.span }; }
    if (t.kind === "float") { this.bump(); return { kind: "number", value: t.text, span: t.span }; }
    if (t.kind === "ident" || t.kind === "keyword") {
      const segments: string[] = [];
      const start = t.span.start;
      segments.push(this.bump().text);
      while (this.at("::") || this.at(".")) { this.bump(); segments.push(this.bump().text); }
      const span = this.finish(start);
      if (segments.length === 1) return { kind: "ident", name: segments[0]!, span };
      return { kind: "path", segments, span };
    }
    this.error("E0108", "bad_attr_value", "expected attribute value", t.span);
    return { kind: "ident", name: "", span: t.span };
  }

  private parseItem(): Item | null {
    const start = this.start();
    const attrs = this.parseAttributes();

    if (this.atKw("use")) return this.parseUse(start);
    if (this.atKw("pub")) {
      this.bump();
      const inner = this.parseItemAfterVisibility(start, attrs);
      return inner;
    }
    if (this.atKw("unsafe") || this.atKw("extern")) {
      return this.parseFn(start, attrs, "priv");
    }
    if (this.atKw("fn")) return this.parseFn(start, attrs, "priv");
    if (this.atKw("type")) return this.parseTypeItem(start, attrs, "priv");
    if (this.atKw("trait")) return this.parseTrait(start, attrs, "priv");
    if (this.atKw("impl")) return this.parseImpl(start, attrs);
    if (this.atKw("const")) return this.parseConst(start, attrs, "priv");
    if (this.atKw("test")) return this.parseTest(start, attrs);

    this.error("E0109", "expected_item", `expected an item, found \`${this.cur.text || "<eof>"}\``, this.cur.span);
    this.recoverItem();
    return null;
  }

  private parseItemAfterVisibility(start: number, attrs: Attribute[]): Item | null {
    if (this.atKw("fn") || this.atKw("unsafe") || this.atKw("extern")) return this.parseFn(start, attrs, "pub");
    if (this.atKw("type")) return this.parseTypeItem(start, attrs, "pub");
    if (this.atKw("trait")) return this.parseTrait(start, attrs, "pub");
    if (this.atKw("const")) return this.parseConst(start, attrs, "pub");
    if (this.atKw("use")) return this.parseUse(start);
    this.error("E0110", "expected_item_after_pub", "`pub` must be followed by fn, type, trait, const, or use", this.cur.span);
    this.recoverItem();
    return null;
  }

  // -- use -----------------------------------------------------------------

  private parseUse(start: number): UseItem {
    this.bump(); // `use`
    const tree = this.parseUseTree();
    return { kind: "use", tree, span: this.finish(start) };
  }

  private parseUseTree(): UseTree {
    const start = this.start();
    const segments: string[] = [];
    while (true) {
      const t = this.cur;
      if (t.kind !== "ident" && t.kind !== "keyword") {
        this.error("E0111", "bad_use_path", "expected path segment in `use`", t.span);
        break;
      }
      segments.push(this.bump().text);
      // `std.fs.{read, write}` and `std.fs::{read, write}` are both accepted: a `.`
      // starts a group only when `{` follows it, otherwise it continues the path.
      if (this.at("::")) { this.bump(); continue; }
      if (this.at(".") && !this.at("{", 1)) { this.bump(); continue; }
      break;
    }
    if (this.at(".")) {
      this.bump();
      this.expect("{", "opening a `use` group");
      const items: UseTree[] = [];
      while (!this.at("}") && this.cur.kind !== "eof") {
        items.push(this.parseUseTree());
        if (!this.eat(",")) break;
      }
      this.expect("}", "closing a `use` group");
      return { kind: "list", prefix: segments, items, span: this.finish(start) };
    }
    let alias: string | null = null;
    if (this.atKw("as")) {
      this.bump();
      const a = this.expectIdent("alias name");
      alias = a?.text ?? null;
    }
    return { kind: "name", segments, alias, span: this.finish(start) };
  }

  // -- fn ------------------------------------------------------------------

  private parseFn(start: number, attrs: Attribute[], visibility: "pub" | "priv"): FnItem {
    let externAbi: string | null = null;
    let unsafety: string[] | null = null;
    let isConst = false;

    if (this.atKw("extern")) {
      this.bump();
      externAbi = "C";
      if (this.cur.kind === "string") { externAbi = String(this.bump().value); }
    }
    if (this.atKw("unsafe")) {
      this.bump();
      const caps: string[] = [];
      if (this.at("[")) {
        this.bump();
        while (!this.at("]") && this.cur.kind !== "eof") {
          if (this.cur.kind === "ident" || this.cur.kind === "keyword") caps.push(this.bump().text);
          else this.bump();
          if (!this.eat(",")) break;
        }
        this.expect("]", "closing unsafe capability list");
      }
      unsafety = caps;
    }
    if (this.atKw("const")) { this.bump(); isConst = true; }

    this.expectKw("fn", "after `unsafe`/`extern`");
    const nameTok = this.expectIdent("function name");
    if (!nameTok) { this.recoverItem(); return this.emptyFn(start, attrs, visibility); }
    const nameSpan = nameTok.span;

    const generics = this.parseTypeParams();
    const params = this.parseParams();
    const ret = this.at("->") ? (this.bump(), this.parseType()) : undefined;
    const effects = this.parseEffectRow();
    const body = this.at("{") ? this.parseBlock() : { stmts: [], span: this.finish(this.start()) };

    return {
      kind: "fn", name: nameTok.text, generics, params, ret, effects, body, attrs,
      visibility, unsafety, externAbi, isConst, span: this.finish(start), nameSpan,
    };
  }

  private emptyFn(start: number, attrs: Attribute[], visibility: "pub" | "priv"): FnItem {
    return {
      kind: "fn", name: "<error>", generics: [], params: [], ret: undefined, effects: null,
      body: { stmts: [], span: this.finish(start) }, attrs, visibility, unsafety: null,
      externAbi: null, isConst: false, span: this.finish(start), nameSpan: this.finish(start),
    };
  }

  private parseTypeParams(): TypeParam[] {
    // Declarations use `fn f[T, U]()`; type *application* uses `Foo[T, U]`. Both spellings
    // are accepted for the application form; only `[...]` reaches here at item level.
    if (!this.at("<") && !this.at("[")) return [];
    const close = this.at("[") ? "]" : ">";
    this.bump();
    const out: TypeParam[] = [];
    while (!this.at(close) && this.cur.kind !== "eof") {
      const t = this.expectIdent("type parameter");
      if (!t) break;
      const bounds: string[] = [];
      if (this.eat(":")) {
        while (true) {
          if (this.cur.kind === "ident" || this.cur.kind === "keyword") bounds.push(this.bump().text);
          else break;
          if (!this.eat("+")) break;
        }
      }
      out.push({ name: t.text, bounds, span: t.span });
      if (!this.eat(",")) break;
    }
    if (close === "]") this.expect("]", "closing type parameters");
    else this.expectGt();
    return out;
  }

  /** `>` may be split (`>>`) after a generic arg list; consume it piecemeal. */
  private expectGt(): Token | null {
    if (this.at(">")) return this.bump();
    if (this.at(">>")) {
      const t = this.cur;
      // Split the `>>` token in place.
      this.toks[this.pos] = { ...t, text: ">", span: { ...t.span, start: t.span.start + 1 } };
      return t;
    }
    if (this.at(">=")) {
      const t = this.cur;
      this.toks[this.pos] = { ...t, text: "=", span: { ...t.span, start: t.span.start + 1 } };
      return t;
    }
    if (this.at(">=")) return this.bump();
    return this.expect(">", "closing type arguments");
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    if (!this.expect("(", "opening the parameter list")) return params;
    while (!this.at(")") && this.cur.kind !== "eof") {
      const attrs = this.parseAttributes();
      const t = this.cur;
      if (t.kind !== "ident" && t.kind !== "keyword") {
        this.error("E0112", "expected_param_name", "expected a parameter name (`name: T`)", t.span);
        this.bump();
        continue;
      }
      this.bump();
      this.expect(":", "after a parameter name");
      const ty = this.parseType();
      params.push({ name: t.text, ty, attrs, span: { start: t.span.start, end: ty.span.end, file: this.fileIndex } });
      if (!this.eat(",")) break;
    }
    this.expect(")", "closing the parameter list");
    return params;
  }

  /** `!{a, b}` → `["a","b"]`. `!{..}` → all effects. Absent → null. */
  private parseEffectRow(): string[] | null {
    if (!this.at("!")) return null;
    this.bump();
    if (!this.expect("{", "opening an effect set")) return [];
    const effects: string[] = [];
    while (!this.at("}") && this.cur.kind !== "eof") {
      if (this.at("..")) { this.bump(); effects.push(".."); }
      else if (this.cur.kind === "ident" || this.cur.kind === "keyword") {
        let name = this.bump().text;
        while (this.at(".")) { this.bump(); name += `.${this.bump().text}`; }
        effects.push(name);
      } else this.bump();
      if (!this.eat(",")) break;
    }
    this.expect("}", "closing an effect set");
    return effects;
  }

  // -- type ----------------------------------------------------------------
  /** `T?` postfix optional, applied uniformly to whatever the atom parsed as. */
  private parseType(): TypeExpr {
    let ty = this.parseTypeAtom();
    while (this.at("?")) {
      this.bump();
      ty = { kind: "option", inner: ty, span: { start: ty.span.start, end: this.toks[this.pos - 1]!.span.end, file: this.fileIndex } };
    }
    return ty;
  }

  private parseTypeAtom(): TypeExpr {
    const start = this.start();

    // Ownership wrappers: view / view mut / shared / arena / handle
    //
    // The inner type is parsed as an *atom*, not a full type, so a postfix `?` lands
    // outside the wrapper: `shared Node?` is `shared (Node?)`, not `(shared Node)?`.
    // That is the reading a programmer means, and it is what makes `Some(x)` on a
    // `shared Node?` field yield a `shared Node` to destructure rather than a bare `Node`.
    if (this.atKw("view") && !this.at("{", 1)) {
      this.bump();
      const mutable = this.atKw("mut");
      if (mutable) this.bump();
      const inner = this.parseTypeAtom();
      return { kind: "own", ownership: mutable ? "viewmut" : "view", inner, span: this.finish(start) };
    }
    for (const [kw, own] of [["shared", "shared"], ["arena", "arena"], ["handle", "handle"]] as const) {
      if (this.atKw(kw) && !this.at("{", 1) && !this.at("(", 1)) {
        this.bump();
        const inner = this.parseTypeAtom();
        return { kind: "own", ownership: own as Ownership, inner, span: this.finish(start) };
      }
    }

    // Raw pointer
    if (this.at("*")) {
      this.bump();
      const mutable = this.eat("mut");
      if (!mutable) this.eat("const");
      const inner = this.parseType();
      return { kind: "ptr", mutable, inner, span: this.finish(start) };
    }

    // Optional
    if (this.at("?")) {
      this.bump();
      const inner = this.parseType();
      return { kind: "option", inner, span: this.finish(start) };
    }

    // Fn pointer: fn(A, B) -> C !{...}
    if (this.atKw("fn") && this.at("(", 1)) {
      this.bump();
      this.bump();
      const params: TypeExpr[] = [];
      while (!this.at(")") && this.cur.kind !== "eof") {
        params.push(this.parseType());
        if (!this.eat(",")) break;
      }
      this.expect(")", "closing fn-pointer params");
      let ret: TypeExpr = { kind: "path", segments: ["Void"], args: [], span: this.finish(start) };
      if (this.at("->")) { this.bump(); ret = this.parseType(); }
      const effects = this.parseEffectRow() ?? [];
      return { kind: "fnptr", params, ret, effects, span: this.finish(start) };
    }

    // dyn Trait
    if (this.atKw("dyn")) {
      this.bump();
      const traits: string[] = [];
      while (true) {
        if (this.cur.kind === "ident" || this.cur.kind === "keyword") traits.push(this.bump().text);
        else break;
        if (!this.eat("+")) break;
      }
      return { kind: "impl", traits, span: this.finish(start) };
    }

    // Record type
    if (this.at("{")) return this.parseRecordType();

    // Tuple type
    if (this.at("(")) {
      this.bump();
      const elems: TypeExpr[] = [];
      while (!this.at(")") && this.cur.kind !== "eof") {
        elems.push(this.parseType());
        if (!this.eat(",")) break;
      }
      this.expect(")", "closing a tuple type");
      if (elems.length === 1) return elems[0]!;
      return { kind: "tuple", elems, span: this.finish(start) };
    }

    // Slice / array
    if (this.at("[")) {
      this.bump();
      const elem = this.parseType();
      let len: number | null = null;
      let lenExpr: Expr | undefined;
      if (this.eat(";")) {
        const e = this.parseExpr();
        lenExpr = e;
        len = e.kind === "int" ? Number(e.value) : NaN;
      }
      this.expect("]", "closing a slice type");
      return { kind: "slice", elem, len, lenExpr, span: this.finish(start) };
    }

    // Named / primitive
    if (this.cur.kind === "ident" || (this.cur.kind === "keyword" && !STMT_STOP[this.cur.text]!)) {
      const segments: string[] = [this.bump().text];
      // `.` and `::` both continue a type path: `Decision<Q.Output>`, `Q.Output`, `a::B`.
      while (this.at("::") || this.at(".")) { this.bump(); segments.push(this.bump().text); }
      let args: TypeExpr[] = [];
      if (this.at("<") || this.at("[")) {
        const close = this.at("[") ? "]" : ">";
        this.bump();
        while (!this.at(close) && !this.at(">") && !this.at(">>") && !this.atEof()) {
          args.push(this.parseType());
          if (!this.eat(",")) break;
        }
        if (close === "]") this.expect("]", "closing type arguments");
        else this.expectGt();
      }
      if (PRIMITIVES[segments[segments.length - 1]!] && segments.length === 1) {
        return { kind: "prim", name: segments[0] as PrimitiveName, span: this.finish(start) };
      }
      return { kind: "path", segments, args, span: this.finish(start) };
    }

    this.error("E0113", "expected_type", `expected a type, found \`${this.cur.text || "<eof>"}\``, this.cur.span);
    return { kind: "path", segments: ["<error>"], args: [], span: this.finish(start) };
  }

  private parseRecordType(): TypeExpr {
    const start = this.start();
    this.bump(); // {
    const fields: FieldDecl[] = [];
    while (!this.at("}") && this.cur.kind !== "eof") {
      const attrs = this.parseAttributes();
      const nameTok = this.expectIdent("field name");
      if (!nameTok) break;
      this.expect(":", "after a field name");
      const ty = this.parseType();
      fields.push({ name: nameTok.text, ty, span: this.finish(nameTok.span.start), attrs });
      if (!this.eat(",")) break;
    }
    this.expect("}", "closing a record type");
    return { kind: "record", fields, span: this.finish(start) };
  }

  // -- type item -----------------------------------------------------------

  private parseTypeItem(start: number, attrs: Attribute[], visibility: "pub" | "priv"): TypeItem {
    this.bump(); // `type`
    const nameTok = this.expectIdent("type name");
    if (!nameTok) { this.recoverItem(); return { kind: "type", def: this.badTypeDef(start), attrs, visibility, span: this.finish(start) }; }
    const generics = this.parseTypeParams();
    this.expect("=", "before a type body");

    // `choice { a, b, c }`
    if (this.atKw("choice")) {
      this.bump();
      this.expect("{", "opening a choice list");
      const choices: string[] = [];
      while (!this.at("}") && this.cur.kind !== "eof") {
        const c = this.expectIdent("choice variant");
        if (!c) break;
        choices.push(c.text);
        if (!this.eat(",")) break;
      }
      this.expect("}", "closing a choice list");
      return {
        kind: "type",
        def: { kind: "choice", name: nameTok.text, generics, choices, span: this.finish(start), nameSpan: nameTok.span },
        attrs, visibility, span: this.finish(start),
      };
    }

    // Record: `{ field: T, ... }`
    if (this.at("{")) {
      const rt = this.parseRecordType();
      const fields = rt.kind === "record" ? rt.fields : [];
      return {
        kind: "type",
        def: { kind: "record", name: nameTok.text, generics, fields, span: this.finish(start), nameSpan: nameTok.span },
        attrs, visibility, span: this.finish(start),
      };
    }

    // Alias vs union: a union's first variant is an identifier immediately followed by
    // `{` or `|`. Anything else is a general type expression (`type File = Handle<fd>`,
    // `type ApiToken = Bytes`), which must be parsed by the type parser, not as a
    // variant list — otherwise generic arguments are silently left unconsumed.
    const startsUnion = (this.cur.kind === "ident" || this.cur.kind === "keyword")
      && (this.at("{", 1) || this.at("|", 1));
    if (!startsUnion) {
      const target = this.parseType();
      return {
        kind: "type",
        def: { kind: "alias", name: nameTok.text, generics, target, span: this.finish(start), nameSpan: nameTok.span },
        attrs, visibility, span: this.finish(start),
      };
    }

    // Union: `A { .. } | B { .. } | C`
    const variants: VariantDecl[] = [];
    while (true) {
      const vName = this.expectIdent("variant name");
      if (!vName) break;
      const fields: FieldDecl[] = [];
      if (this.at("{")) {
        const rt = this.parseRecordType();
        if (rt.kind === "record") fields.push(...rt.fields);
      }
      variants.push({ name: vName.text, fields, span: this.finish(vName.span.start) });
      if (!this.eat("|")) break;
    }
    if (variants.length === 0) {
      this.error("E0114", "empty_type", "type must be a record, a union, a choice, or an alias", this.cur.span);
      return { kind: "type", def: this.badTypeDef(start), attrs, visibility, span: this.finish(start) };
    }
    if (variants.length === 1 && variants[0]!.fields.length === 0) {
      // Single nullary variant is still a union; keep it explicit.
    }
    return {
      kind: "type",
      def: { kind: "union", name: nameTok.text, generics, variants, span: this.finish(start), nameSpan: nameTok.span },
      attrs, visibility, span: this.finish(start),
    };
  }

  private badTypeDef(start: number): TypeItem["def"] {
    return {
      kind: "alias", name: "<error>", generics: [],
      target: { kind: "path", segments: ["<error>"], args: [], span: this.finish(start) },
      span: this.finish(start), nameSpan: this.finish(start),
    };
  }

  // -- trait / impl --------------------------------------------------------

  private parseTrait(start: number, attrs: Attribute[], visibility: "pub" | "priv"): TraitItem {
    this.bump();
    const nameTok = this.expectIdent("trait name");
    if (!nameTok) { this.recoverItem(); return { kind: "trait", name: "<error>", generics: [], methods: [], attrs, visibility, span: this.finish(start), nameSpan: this.finish(start) }; }
    const generics = this.parseTypeParams();
    const methods: FnItem[] = [];
    if (this.expect("{", "opening a trait body")) {
      while (!this.at("}") && this.cur.kind !== "eof") {
        const before = this.pos;
        const mattrs = this.parseAttributes();
        const vis = this.eatKw("pub") ? "pub" : "priv";
        if (this.atKw("fn") || this.atKw("unsafe") || this.atKw("extern")) {
          const m = this.parseFn(this.start(), mattrs, vis);
          // A trait method has no body; the `{}` we just parsed is the trait's.
          methods.push({ ...m, body: { stmts: [], span: m.nameSpan } });
        } else this.bump();
        if (this.pos === before) this.bump();
      }
      this.expect("}", "closing a trait body");
    }
    return { kind: "trait", name: nameTok.text, generics, methods, attrs, visibility, span: this.finish(start), nameSpan: nameTok.span };
  }

  private parseImpl(start: number, attrs: Attribute[]): ImplItem {
    this.bump(); // impl
    const first = this.expectIdent("trait name");
    if (!first) { this.recoverItem(); return { kind: "impl", trait: "<error>", typeName: "<error>", generics: [], methods: [], attrs, span: this.finish(start) }; }
    const traitName = first.text;
    this.expectKw("for", "in an impl");
    const typeName = this.expectIdent("type name")?.text ?? "<error>";
    const generics = this.parseTypeParams();
    const methods: FnItem[] = [];
    if (this.expect("{", "opening an impl body")) {
      while (!this.at("}") && this.cur.kind !== "eof") {
        const before = this.pos;
        const mattrs = this.parseAttributes();
        if (this.atKw("fn") || this.atKw("unsafe")) {
          methods.push(this.parseFn(this.start(), mattrs, "pub"));
        } else this.bump();
        if (this.pos === before) this.bump();
      }
      this.expect("}", "closing an impl body");
    }
    return { kind: "impl", trait: traitName, typeName, generics, methods, attrs, span: this.finish(start) };
  }

  // -- const / test --------------------------------------------------------

  private parseConst(start: number, attrs: Attribute[], visibility: "pub" | "priv"): ConstItem {
    this.bump();
    const isConstFn = this.eatKw("fn");
    const nameTok = this.expectIdent("constant name");
    if (!nameTok) { this.recoverItem(); return { kind: "const", name: "<error>", value: { kind: "bool", value: false, span: this.finish(start) }, attrs, visibility, span: this.finish(start), nameSpan: this.finish(start) }; }
    let ty: TypeExpr | undefined;
    if (this.eat(":")) ty = this.parseType();
    if (isConstFn) {
      const params = this.parseParams();
      let ret: TypeExpr | undefined;
      if (this.at("->")) { this.bump(); ret = this.parseType(); }
      const body = this.parseBlock();
      return {
        kind: "const", name: nameTok.text, ty: ret, visibility, attrs,
        value: { kind: "block", block: body, span: this.finish(start) },
        span: this.finish(start), nameSpan: nameTok.span,
      };
    }
    this.expect("=", "before a constant value");
    const value = this.parseExpr();
    return { kind: "const", name: nameTok.text, ty, value, visibility, attrs, span: this.finish(start), nameSpan: nameTok.span };
  }

  private parseTest(start: number, attrs: Attribute[]): TestItem {
    this.bump();
    const nameTok = this.cur.kind === "string" ? this.bump() : this.expectIdent("test name");
    if (!nameTok) { this.recoverItem(); return { kind: "test", name: "<error>", body: { stmts: [], span: this.finish(start) }, attrs, span: this.finish(start), nameSpan: this.finish(start) }; }
    const body = this.parseBlock();
    return { kind: "test", name: String(nameTok.value ?? nameTok.text), body, attrs, span: this.finish(start), nameSpan: nameTok.span };
  }

  // -- blocks / statements -------------------------------------------------

  private parseBlock(): Block {
    const start = this.start();
    if (!this.expect("{", "opening a block")) return { stmts: [], span: this.finish(start) };
    const stmts: Stmt[] = [];
    let tail: Expr | undefined;
    while (!this.at("}") && this.cur.kind !== "eof") {
      if (this.at(";")) { this.bump(); continue; }
      const before = this.pos;
      const stmt = this.parseStmt();
      if (this.pos === before) this.bump(); // guarantee progress
      // A statement-terminated expression is the block's value — the terminator is the
      // `;`, so a final expression immediately before `}` is a tail too. The value
      // restriction is what keeps a trailing `for`/`while` from ending the block early
      // and silently discarding the statements after it (kernel.md §2.1).
      //
      // The tail is checked *before* pushing, so a tail expression is recorded once, in
      // `tail` and not also in `stmts`.
      if (stmt?.kind === "expr" && !this.at(";") && producesValue(stmt.expr)) {
        tail = stmt.expr;
        break;
      }
      if (stmt) stmts.push(stmt);
    }
    this.expect("}", "closing a block");
    return { stmts, tail, span: this.finish(start) };
  }

  private parseStmt(): Stmt | null {
    const start = this.start();

    if (this.at("@") || this.atKw("fn", "type", "trait", "impl", "test", "use")) {
      const item = this.parseItem();
      if (!item) return null;
      return { kind: "item", item, span: this.finish(start) };
    }
    if (this.atKw("pub")) {
      const item = this.parseItem();
      if (!item) return null;
      return { kind: "item", item, span: this.finish(start) };
    }

    if (this.atKw("let")) {
      this.bump();
      const mutable = this.eatKw("mut");
      const pat = this.parsePattern();
      let ty: TypeExpr | undefined;
      if (this.eat(":")) ty = this.parseType();
      let init: Expr | undefined;
      if (this.eat("=")) init = this.parseExpr();
      this.eat(";");
      return { kind: "let", pat, ty, init, mutable, span: this.finish(start) };
    }

    const expr = this.parseExpr();
    if (!expr) return null;
    if (expr.kind === "assign") return { kind: "assign", target: expr.target, value: expr.value, span: expr.span };
    return { kind: "expr", expr, span: expr.span };
  }

  // -- patterns ------------------------------------------------------------

  private parsePattern(): Pattern {
    const start = this.start();
    let first = this.parsePatternPrimary();
    if (this.at("|")) {
      const alts = [first];
      while (this.eat("|")) alts.push(this.parsePatternPrimary());
      return { kind: "or", alts, span: this.finish(start) };
    }
    if (this.at("@")) {
      this.bump();
      if (first.kind !== "bind") {
        this.error("E0115", "bad_at_pattern", "`@` must bind a plain name", this.cur.span);
        return first;
      }
      const sub = this.parsePatternPrimary();
      return { kind: "at", name: first.name, sub, span: this.finish(start) };
    }
    return first;
  }

  private parsePatternPrimary(): Pattern {
    const start = this.start();
    if (this.at("_")) { this.bump(); return { kind: "wildcard", span: this.finish(start) }; }
    if (this.at("-")) {
      this.bump();
      const lit = this.parsePatternPrimary();
      return { kind: "lit", value: { kind: "unary", op: "-", operand: { kind: "int", value: 0n, span: lit.span }, span: lit.span }, span: this.finish(start) };
    }

    // Literal patterns
    const t = this.cur;
    if (t.kind === "int" || t.kind === "float" || t.kind === "string" || t.kind === "char" || t.kind === "bytes") {
      const lit = this.parsePatternLit();
      return { kind: "lit", value: lit, span: this.finish(start) };
    }
    if (this.atKw("true") || this.atKw("false")) {
      const b = this.bump();
      return { kind: "lit", value: { kind: "bool", value: b.text === "true", span: b.span }, span: this.finish(start) };
    }

    // `(a, b)` — a tuple pattern, so `let (x, y) = pair` destructures. A single
    // parenthesised element is just a grouping, matching the expression grammar.
    if (this.at("(")) {
      this.bump();
      const elems: Pattern[] = [];
      while (!this.at(")") && this.cur.kind !== "eof") {
        elems.push(this.parsePattern());
        if (!this.eat(",")) break;
      }
      this.expect(")", "closing a tuple pattern");
      if (elems.length === 1) return elems[0]!;
      return { kind: "tuple", path: "", elems, span: this.finish(start) };
    }

    if (this.atKw("mut")) {
      this.bump();
      const name = this.expectIdent("binding name");
      return { kind: "bind", name: name?.text ?? "_", mutable: true, span: this.finish(start) };
    }

    // Path: `::`-qualified (`io::Error`) or `.`-qualified (`NetErr.Timeout`, which names a
    // variant of a union). The last segment is the variant; the qualifier is kept so the
    // checker can confirm the variant belongs to the type being matched.
    if (this.cur.kind === "ident") {
      const segments: string[] = [this.bump().text];
      while (this.at("::")) { this.bump(); segments.push(this.bump().text); }
      if (this.at(".") && this.peek(1).kind === "ident") {
        this.bump();
        segments.push(this.bump().text);
        while (this.at("::")) { this.bump(); segments.push(this.bump().text); }
      }
      const path = segments[segments.length - 1]!;

      if (this.at("(")) {
        this.bump();
        const elems: Pattern[] = [];
        while (!this.at(")") && !this.atEof()) {
          elems.push(this.parsePattern());
          if (!this.eat(",")) break;
        }
        this.expect(")", "closing a tuple pattern");
        return { kind: "tuple", path, elems, span: this.finish(start) };
      }
      if (this.at("{")) {
        this.bump();
        const fields: PatternField[] = [];
        let rest = false;
        while (!this.at("}") && !this.atEof()) {
          if (this.at("..")) { this.bump(); rest = true; break; }
          const f = this.expectIdent("field pattern name");
          if (!f) break;
          let pat: Pattern = { kind: "bind", name: f.text, mutable: false, span: f.span };
          if (this.eat(":")) pat = this.parsePattern();
          fields.push({ name: f.text, pat, span: f.span });
          if (!this.eat(",")) break;
        }
        this.expect("}", "closing a record pattern");
        return { kind: "record", path, fields, rest, span: this.finish(start) };
      }
      // A bare identifier is a binding, except for the one nullary builtin variant: `None`
      // is how an `Option` says "no value", and reading it as a binding would both bind a
      // name and make every `match` on an option look non-exhaustive.
      if (path === "None" && segments.length === 1) {
        return { kind: "unit", path, span: this.finish(start) };
      }
      return { kind: "bind", name: path, mutable: false, span: this.finish(start) };
    }

    this.error("E0116", "expected_pattern", `expected a pattern, found \`${t.text || "<eof>"}\``, t.span);
    return { kind: "wildcard", span: this.finish(start) };
  }

  private parsePatternLit(): Expr {
    const t = this.bump();
    const span = t.span;
    switch (t.kind) {
      case "int": return { kind: "int", value: (t.value as bigint) ?? 0n, span };
      case "float": return { kind: "float", value: (t.value as number) ?? 0, span };
      case "string": return { kind: "string", value: (t.value as string) ?? "", span };
      case "char": return { kind: "char", value: (t.value as string) ?? "", span };
      default: return { kind: "bytes", value: new Uint8Array(), span };
    }
  }

  // -- expressions ---------------------------------------------------------

  private parseExpr(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const lhs = this.parseBinary(1);
    // Augmented assignment desugars to `x = x op v`. The ownership pass recognizes the
    // `assign(binary(x, op, v))` shape and treats it as in-place, so a compound write to
    // a non-Copy place is not misreported as a move-after-use.
    if (this.at("=")) {
      this.bump();
      const value = this.parseAssign();
      return { kind: "assign", target: lhs, value, span: { start: lhs.span.start, end: value.span.end, file: this.fileIndex } };
    }
    const AUGMENTED: Record<string, BinaryOp> = {
      "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%", "&=": "&", "|=": "|", "^=": "^",
    };
    const compound = this.cur.kind === "punct" ? AUGMENTED[this.cur.text] : undefined;
    if (compound) {
      this.bump();
      const value = this.parseAssign();
      const bin: Expr = {
        kind: "binary", op: compound, lhs, rhs: value,
        span: { start: lhs.span.start, end: value.span.end, file: this.fileIndex },
      };
      return { kind: "assign", target: lhs, value: bin, span: bin.span };
    }
    return lhs;
  }

  private parseBinary(minPrec: number): Expr {
    let lhs = this.parseCast();
    while (true) {
      const t = this.cur;
      if (t.kind !== "punct") break;
      const prec = BINARY_PREC[t.text];
      if (prec === undefined || prec < minPrec) break;
      this.bump();
      const rhs = this.parseBinary(prec + 1);
      lhs = {
        kind: "binary", op: t.text as BinaryOp, lhs, rhs,
        span: { start: lhs.span.start, end: rhs.span.end, file: this.fileIndex },
      };
    }
    return lhs;
  }

  private parseCast(): Expr {
    let e = this.parseUnary();
    while (this.atKw("as") || this.atKw("is")) {
      const isIs = this.atKw("is");
      this.bump();
      const ty = this.parseType();
      e = isIs
        ? { kind: "is", base: e, ty, span: { start: e.span.start, end: ty.span.end, file: this.fileIndex } }
        : { kind: "cast", operand: e, ty, span: { start: e.span.start, end: ty.span.end, file: this.fileIndex } };
    }
    return e;
  }

  private parseUnary(): Expr {
    const t = this.cur;
    if (t.kind === "punct" && (t.text === "-" || t.text === "!" || t.text === "*" || t.text === "&")) {
      this.bump();
      if (t.text === "&" && this.atKw("mut")) {
        this.bump();
        const operand = this.parseUnary();
        return { kind: "unary", op: "&mut", operand, span: this.finish(t.span.start) };
      }
      const operand = this.parseUnary();
      return { kind: "unary", op: t.text as "-" | "!" | "*" | "&", operand, span: this.finish(t.span.start) };
    }
    if (this.atKw("move")) {
      this.bump();
      const operand = this.parseUnary();
      return { kind: "move", operand, span: this.finish(t.span.start) };
    }
    if (this.atKw("view")) {
      this.bump();
      const mutable = this.eatKw("mut");
      const operand = this.parseUnary();
      return { kind: "view", mutable, operand, span: this.finish(t.span.start) };
    }
    if (this.atKw("const")) {
      this.bump();
      this.expect("{", "opening a const block");
      const body = this.parseBlock();
      return { kind: "consteval", body, span: this.finish(t.span.start) };
    }
    if (this.atKw("unsafe")) {
      this.bump();
      const caps: string[] = [];
      if (this.at("[")) {
        this.bump();
        while (!this.at("]") && this.cur.kind !== "eof") {
          if (this.cur.kind === "ident" || this.cur.kind === "keyword") caps.push(this.bump().text);
          else this.bump();
          if (!this.eat(",")) break;
        }
        this.expect("]", "closing unsafe capability list");
      }
      this.noStruct += 1;
      const body = this.parseBlock();
      this.noStruct -= 1;
      return { kind: "unsafe", caps, body, span: this.finish(t.span.start) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    while (true) {
      if (this.at(".")) {
        this.bump();
        const nameTok = this.cur;
        if (nameTok.kind !== "ident" && nameTok.kind !== "keyword") {
          this.error("E0117", "expected_field", "expected a field or method name after `.`", nameTok.span);
          break;
        }
        this.bump();
        if (this.at("(")) {
          const args = this.parseArgs();
          e = { kind: "method", base: e, name: nameTok.text, nameSpan: nameTok.span, args, span: this.finish(e.span.start) };
        } else {
          e = { kind: "field", base: e, name: nameTok.text, nameSpan: nameTok.span, span: this.finish(e.span.start) };
        }
        continue;
      }
      if (this.at("(")) {
        const args = this.parseArgs();
        e = { kind: "call", callee: e, args, span: { start: e.span.start, end: this.toks[this.pos - 1]!.span.end, file: this.fileIndex } };
        continue;
      }
      if (this.at("[")) {
        this.bump();
      const index = this.parseExpr();
        this.expect("]", "closing an index expression");
        e = { kind: "index", base: e, index, span: this.finish(e.span.start) };
        continue;
      }
      if (this.at("?")) {
        this.bump();
        e = { kind: "try", operand: e, span: this.finish(e.span.start) };
        continue;
      }
      // `::<T>` turbofish on a call
      if (this.at("::") && this.at("<", 1)) {
        this.bump();
        this.bump();
        const typeArgs: TypeExpr[] = [];
        while (!this.at(">") && !this.at(">>") && this.cur.kind !== "eof") {
          typeArgs.push(this.parseType());
          if (!this.eat(",")) break;
        }
        this.expectGt();
        if (!this.at("(")) break;
        const args = this.parseArgs();
        e = { kind: "call", callee: e, args, typeArgs, span: this.finish(e.span.start) };
        continue;
      }
      break;
    }
    return e;
  }

  private parseArgs(): Expr[] {
    const args: Expr[] = [];
    if (!this.expect("(", "opening an argument list")) return args;

    while (!this.at(")") && this.cur.kind !== "eof") {
      args.push(this.parseExpr());
      if (!this.eat(",")) break;
    }

    this.expect(")", "closing an argument list");
    return args;
  }

  private parsePrimary(): Expr {
    const start = this.start();
    const t = this.cur;

    if (t.kind === "int") { this.bump(); return { kind: "int", value: (t.value as bigint) ?? 0n, span: t.span }; }
    if (t.kind === "float") { this.bump(); return { kind: "float", value: (t.value as number) ?? 0, span: t.span }; }
    if (t.kind === "string") { this.bump(); return { kind: "string", value: (t.value as string) ?? "", span: t.span }; }
    if (t.kind === "bytes") { this.bump(); return { kind: "bytes", value: new TextEncoder().encode((t.value as string) ?? ""), span: t.span }; }
    if (t.kind === "char") { this.bump(); return { kind: "char", value: (t.value as string) ?? "", span: t.span }; }
    if (this.atKw("true") || this.atKw("false")) { this.bump(); return { kind: "bool", value: t.text === "true", span: t.span }; }

    if (this.atKw("if")) return this.parseIf();
    if (this.atKw("match")) return this.parseMatch();
    if (this.atKw("while")) {
      this.bump();
      // A `{` right after the header expression opens the body, not a struct literal.
      this.noStruct += 1;
      const cond = this.parseExpr();
      this.noStruct -= 1;
      const body = this.parseBlock();
      return { kind: "while", cond, body, span: this.finish(start) };
    }
    if (this.atKw("loop")) {
      this.bump();
      const body = this.parseBlock();
      return { kind: "loop", body, span: this.finish(start) };
    }
    if (this.atKw("for")) {
      this.bump();
      const pat = this.parsePattern();
      this.expectKw("in", "in a `for` loop");
      this.noStruct += 1;
      const iter = this.parseExpr();
      this.noStruct -= 1;
      const body = this.parseBlock();
      return { kind: "for", pat, iter, body, span: this.finish(start) };
    }
    if (this.atKw("return")) {
      this.bump();
      const value = this.at("}") || this.at(";") || this.cur.kind === "eof" ? undefined : this.parseExpr();
      this.eat(";");
      return { kind: "return", value, span: this.finish(start) };
    }
    if (this.atKw("break")) {
      this.bump();
      const value = this.at("}") || this.at(";") || this.cur.kind === "eof" ? undefined : this.parseExpr();
      this.eat(";");
      return { kind: "break", value, span: this.finish(start) };
    }
    if (this.atKw("continue")) { this.bump(); this.eat(";"); return { kind: "continue", span: this.finish(start) }; }
    if (this.atKw("spawn") || this.atKw("task")) {
      const isTask = this.atKw("task");
      this.bump();
      // `shared` is the default transfer, but saying it must be *consumed* — leaving the
      // token in place made `spawn shared { .. }` fail to parse at all.
      if (this.eatKw("move")) {
        const moved = this.parseBlock();
        return { kind: "spawn", body: moved, transfer: "move", span: this.finish(start) };
      }
      this.eatKw("shared");
      const body = this.parseBlock();
      return { kind: "spawn", body, transfer: "shared", span: this.finish(start) };
    }
    if (this.at("!")) {
      this.bump();
      const effects = this.parseEffectRow() ?? [];
      return { kind: "effectset", effects, span: this.finish(start) };
    }

    // A `{` in *expression* position opens a block value, not a body, so struct literals
    // inside it are ordinary: `let v = { let b = Buf { .. }; view b }` must parse.
    if (this.at("{")) {
      return { kind: "block", block: this.parseBlock(), span: this.finish(start) };
    }

    if (this.at("(")) {
      this.bump();

      const elems: Expr[] = [];
      while (!this.at(")") && this.cur.kind !== "eof") {
        elems.push(this.parseExpr());
        if (!this.eat(",")) break;
      }

      this.expect(")", "closing a tuple or parenthesized expression");
      if (elems.length === 1) return elems[0]!;
      return { kind: "tuple", elems, span: this.finish(start) };
    }

    if (this.at("[")) {
      this.bump();

      const elems: Expr[] = [];
      while (!this.at("]") && this.cur.kind !== "eof") {
        elems.push(this.parseExpr());
        if (!this.eat(",")) break;
      }

      this.expect("]", "closing an array literal");
      return { kind: "array", elems, span: this.finish(start) };
    }

    if (t.kind === "ident") {
      const segments: string[] = [this.bump().text];
      while (this.at("::")) { this.bump(); segments.push(this.bump().text); }
      // A dotted prefix qualifies a literal: `Json.Num { n: 1 }`. The prefix is absorbed
      // only when a struct literal genuinely follows — a `{`, then `ident`, then `:`.
      // Checking only for `{` is not enough: in `match n.next { Some(x) => .. }` the
      // brace is the arm body, and `n.next` would be swallowed as a qualified path.
      while (this.at(".") && this.at("{", 2) && this.peek(3).kind === "ident" && this.at(":", 4)) {
        this.bump();
        segments.push(this.bump().text);
        while (this.at("::")) { this.bump(); segments.push(this.bump().text); }
      }
      const name = segments.join(".");

      // Struct literal — only in expression position and on the same line.
      if (this.at("{") && this.noStruct === 0 && !this.cur.nlBefore) {
        this.bump();
        const fields: FieldInit[] = [];
        while (!this.at("}") && this.cur.kind !== "eof") {
          const f = this.expectIdent("field name");
          if (!f) break;
          this.expect(":", "after a field name");
          const value = this.parseExpr();
          fields.push({ name: f.text, value, span: f.span });
          if (!this.eat(",")) break;
        }
        this.expect("}", "closing a struct literal");
        return { kind: "struct", path: name, fields, span: this.finish(start) };
      }
      // A `::`-qualified name keeps its qualifier: `Map::new` is an associated
      // constructor, and dropping the prefix would make it unresolvable.
      return { kind: "path", value: segments.join("::"), span: this.finish(start) };
    }

    this.error("E0118", "expected_expr", `expected an expression, found \`${t.text || "<eof>"}\``, t.span);
    return { kind: "path", value: "<error>", span: this.finish(start) };
  }

  private parseIf(): Expr {
    const start = this.start();
    this.bump(); // if
    this.noStruct += 1;
    const cond = this.parseExpr();
    this.noStruct -= 1;
    this.noStruct += 1;
    const then = this.parseBlock();
    this.noStruct -= 1;
    let else_: Block | Expr | undefined;
    if (this.atKw("else")) {
      this.bump();
      if (this.atKw("if")) else_ = this.parseIf();
      else { this.noStruct += 1; else_ = this.parseBlock(); this.noStruct -= 1; }
    }
    return { kind: "if", cond, then, else_, span: this.finish(start) };
  }

  private parseMatch(): Expr {
    const start = this.start();
    this.bump();
    this.noStruct += 1;
    const scrutinee = this.parseExpr();
    this.noStruct -= 1;
    this.expect("{", "opening a match body");
    const arms: MatchArm[] = [];
    while (!this.at("}") && this.cur.kind !== "eof") {
      const before = this.pos;
      const armStart = this.start();
      const pat = this.parsePattern();
      this.expect("=>", "between a pattern and its body");
      const body = this.parseExpr();
      arms.push({ pat, body, span: this.finish(armStart) });
      // A missing comma between arms is tolerated — the loop just continues — but the
      // iteration MUST consume something. Without this guard a malformed arm that makes
      // no progress spins forever, appending to `arms` until the engine runs out of
      // memory. `parseBlock` has the same guard for the same reason.
      if (!this.eat(",") && this.at("}")) break;
      if (this.pos === before) this.bump();
    }
    this.expect("}", "closing a match body");
    return { kind: "match", scrutinee, arms, span: this.finish(start) };
  }
}

export function parseFile(file: SourceFile, fileIndex: number): ParsedFile {
  return new Parser(file, fileIndex).parseFile();
}

/**
 * Whether an expression in statement position can be a block's value.
 *
 * Loops and unit-valued control forms are statements, not tails: treating a trailing
 * `for` as the block's value would silently swallow every statement after it. `if`,
 * `match`, and `block` are excluded for a different reason — they are only values when
 * the enclosing function declares a return type, and treating them as tails
 * unconditionally would make `{ if c { 1 } else { 2 } }` a unit block in an `-> i64`
 * function.
 */
function producesValue(e: Expr): boolean {
  switch (e.kind) {
    case "for": case "while": case "loop": case "unsafe": case "consteval":
    case "spawn": case "return": case "break": case "continue": case "assign":
    case "if": case "match": case "block": case "effectset":
      return false;
    default:
      return true;
  }
}
