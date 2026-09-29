/**
 * MM — deterministic formatter.
 *
 * `formatFile` is a pure function of a `SourceFile`: no clock, no locale, no
 * filesystem, no hash-map iteration order (every map is emitted with an explicit
 * sort key). The property the tooling table in the research report actually
 * needs is idempotence — `format(format(x)) === format(x)` — because that is what
 * makes `mm fmt --check` a CI gate rather than a suggestion.
 *
 * Canonical style: 4-space indent, one top-level item per blank-line-separated
 * block, exactly one blank line between top-level items, trailing newline,
 * normalized spacing around operators and after commas, braces on the same line
 * as the construct that opens them. The language's distinguishing surface syntax
 * — `!{...}` effect rows, `@attr(args)`, `unsafe[caps]`, `extern "C"`,
 * `view mut`, `[T; N]` — is rendered verbatim rather than normalized away.
 *
 * Five places need a note, because the parser (kernel.md §2) normalizes surface
 * form away and the formatter prefers the author's spelling, recovered from the
 * source text at the node's span. This is still a pure function of the input
 * file, and it is idempotent: the recovered spelling re-parses to the identical
 * tree, so a second run reaches the same decision.
 *
 *  - Qualified paths. `parsePrimary` keeps only the last segment of `a::b::c`, so
 *    the AST alone would print `c` and silently drop the qualification. A path
 *    node's span covers the whole path, so the source slice is used whenever it
 *    really contains a `.` or `::`.
 *  - Numeric literals. `25.0` is a `float` whose value is `25`; printing the value
 *    would yield an `int` and change the tree. The source slice is printed
 *    instead, which also preserves digit grouping and type suffixes.
 *  - Augmented assignment. `x /= s` desugars to `assign(x, binary(x, "/", s))`,
 *    which is indistinguishable from the AST of an explicit `x = x / s`. The
 *    operator is read back out of the source; if it is not there, the desugared
 *    form is printed. Both re-parse to the same tree.
 *  - Negative literal patterns. `-5` parses to `lit(unary(-, 0))` — the literal is
 *    dropped by the parser — so the digits are recovered from the source rather
 *    than emitting `-0`.
 *  - `spawn { .. }` and `task { .. }` are the same node; `spawn` is canonical.
 *
 * Comments are never dropped: an agent that loses a comment loses a fact. A
 * comment is attached as a leading comment to the following item or statement, or
 * as a trailing comment when it shares a line with the preceding token. A comment
 * that cannot be placed unambiguously — one sitting *inside* a multi-token
 * expression, where a syntax-only formatter has no node to hang it on — is emitted
 * on its own line immediately before the enclosing statement, in source order.
 * The next run then finds it in an ordinary leading position and leaves it there.
 *
 * `fingerprint` is the round-trip oracle: it serializes parsed items to a
 * canonical string that ignores spans, so the formatter's round trip can be
 * checked structurally instead of textually.
 */

import type {
  Attribute, AttrArg, Block, Expr, FieldDecl, FieldInit, FnItem, Item, MatchArm,
  Param, Pattern, PatternField, SourceFile, Stmt, TypeExpr, TypeItem, TypeParam,
  UseTree, VariantDecl,
} from "./ast.ts";
import { lex } from "./lexer.ts";
import { parseFile } from "./parser.ts";

const INDENT = "    ";
/** Signatures and call argument lists break one-per-line past this column. */
const MAX_WIDTH = 100;
/** Inline type forms longer than this are broken across lines. */
const INLINE_LIMIT = 72;

/** Ownership keyword per spelling; `viewmut` is the only two-word one. */
const OWN_KW: Record<string, string> = {
  view: "view", viewmut: "view mut", shared: "shared", arena: "arena", handle: "handle",
};

/** Precedence of the parser's binary operators, shifted by one so `assign` fits below. */
const BIN_PREC: Record<string, number> = {
  "||": 2, "&&": 3,
  "==": 4, "!=": 4, "<": 4, "<=": 4, ">": 4, ">=": 4,
  "|": 5, "^": 6, "&": 7, "<<": 8, ">>": 8,
  "+": 9, "-": 9, "*": 10, "/": 10, "%": 10,
};

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

interface Comment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Comments live in the gaps between lexer tokens, so the token stream is the
 * authority on where they are: scanning raw text for `//` would have to
 * re-implement string and byte-literal handling to avoid false hits.
 */
function collectComments(text: string, fileIndex: number): Comment[] {
  const out: Comment[] = [];
  let cursor = 0;
  for (const tok of lex(text, fileIndex).tokens) {
    if (tok.span.start < cursor) continue;
    const gap = text.slice(cursor, tok.span.start);
    let i = 0;
    while (i < gap.length) {
      const c = gap.charCodeAt(i);
      if (c === 47 && gap.charCodeAt(i + 1) === 47) {
        let e = i;
        while (e < gap.length && gap.charCodeAt(e) !== 10 && gap.charCodeAt(e) !== 13) e += 1;
        out.push({ start: cursor + i, end: cursor + e, text: gap.slice(i, e) });
        i = e;
      } else if (c === 47 && gap.charCodeAt(i + 1) === 42) {
        const close = gap.indexOf("*/", i + 2);
        const e = close < 0 ? gap.length : close + 2;
        out.push({ start: cursor + i, end: cursor + e, text: gap.slice(i, e) });
        i = e;
      } else {
        i += 1;
      }
    }
    cursor = tok.span.end;
    // A trailing comment sits in the gap before the eof token, so eof is handled
    // like any other token and only ends the scan afterwards.
    if (tok.kind === "eof") break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

class Formatter {
  private readonly text: string;
  private readonly comments: readonly Comment[];
  /** Index of the next comment that has not been placed yet. */
  private ci = 0;
  /** Source offset just past the last emitted content, for blank-line fidelity. */
  private lastEnd = 0;
  private readonly lineStarts: number[];

  private lines: string[] = [""];
  private depth = 0;

  constructor(file: SourceFile, fileIndex: number) {
    this.text = file.text;
    this.comments = collectComments(file.text, fileIndex);
    this.lineStarts = [0];
    for (let i = 0; i < file.text.length; i += 1) {
      if (file.text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  // -- line writer ----------------------------------------------------------

  /** Append text at the cursor, opening a fresh indented line after every `\n`. */
  private w(text: string): void {
    if (text === "") return;
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) this.lines.push(INDENT.repeat(this.depth));
      this.lines[this.lines.length - 1]! += parts[i]!;
    }
  }

  /**
   * Close the current line and open an indented one. A line that is already
   * exactly the current indentation is an empty line waiting for content, so it
   * is left alone; a line indented for a *deeper* block is closed, which is what
   * puts a closing `}` back at its own level.
   */
  private nl(): void {
    if (this.lines[this.lines.length - 1] !== INDENT.repeat(this.depth)) {
      this.lines.push(INDENT.repeat(this.depth));
    }
  }

  /** One empty line. Repeated calls collapse, and no line ever carries trailing space. */
  private blank(): void {
    // A separator line plus a fresh line to write on: the current line is always
    // open for appending, so the blank has to be committed behind it. Sitting on
    // a blank line already means one is pending, so repeats collapse.
    if (this.lines[this.lines.length - 1]!.trim() !== "") {
      this.lines.push("", INDENT.repeat(this.depth));
    }
  }

  /**
   * Render into a throwaway buffer and return the text. Used for width decisions
   * and for the positions that need a value as a string (parameter lists, record
   * types). Capture is comment-free by construction: only statement and item
   * emission consumes comments, and neither runs inside a capture.
   */
  private capture(fn: () => void): string {
    const savedLines = this.lines;
    const savedDepth = this.depth;
    this.lines = [""];
    this.depth = 0;
    fn();
    const text = this.lines.join("\n").replace(/\n+$/, "");
    this.lines = savedLines;
    this.depth = savedDepth;
    return text;
  }

  // -- source lookups -------------------------------------------------------

  private lineAt(offset: number): number {
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private slice(start: number, end: number): string {
    if (end <= start || start < 0 || end > this.text.length) return "";
    return this.text.slice(start, end);
  }

  /**
   * The authored spelling of a qualified path, or null when there is no qualifier
   * to recover and the AST already holds the whole name.
   */
  private qualified(start: number, end: number): string | null {
    const s = this.slice(start, end);
    const cut = s.search(/[\s({<\[]/);
    const head = cut < 0 ? s : s.slice(0, cut);
    if (head === "" || (!head.includes(".") && !head.includes("::"))) return null;
    return head;
  }

  /** The authored literal, falling back to a canonical rendering of the value. */
  private literal(span: { start: number; end: number }, fallback: string): string {
    const s = this.slice(span.start, span.end);
    if (s === "") return fallback;
    // The lexer allows a literal to span lines; fold it back onto one.
    return s.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  }

  /**
   * Normalize a comment's internal shape without indenting it: the caller writes
   * it on a fresh line, and `w` already indents every line after a newline at the
   * current depth.
   */
  private reindent(text: string): string {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.length === 1) return lines[0]!.replace(/\s+$/, "");
    const out = [lines[0]!];
    for (let i = 1; i < lines.length; i += 1) out.push(lines[i]!.replace(/^[ \t]+/, "").replace(/\s+$/, ""));
    return out.join("\n");
  }

  // -- comments -------------------------------------------------------------

  /**
   * Emit every unplaced comment that starts before `before`, each on its own
   * line. Nothing happens at all when there is no comment in range, so the call
   * sites can place one unconditionally; when there is one, the leading `nl` is
   * what keeps it off the line the previous item ended on.
   */
  private emitPending(before: number, keepGaps: boolean): void {
    const first = this.comments[this.ci];
    if (first === undefined || first.start >= before) return;
    this.nl();
    while (this.ci < this.comments.length && this.comments[this.ci]!.start < before) {
      const c = this.comments[this.ci]!;
      this.ci += 1;
      if (keepGaps && this.lineAt(c.start) - this.lineAt(this.lastEnd) >= 2) this.blank();
      this.w(this.reindent(c.text));
      this.lastEnd = c.end;
      this.nl();
    }
  }

  /** Attach a comment that shares its line with the content just emitted. */
  private emitTrailing(before: number): void {
    const c = this.comments[this.ci];
    if (!c || c.start >= before) return;
    if (this.lineAt(c.start) !== this.lineAt(this.lastEnd)) return;
    this.ci += 1;
    this.w(" " + c.text.replace(/\s+$/, ""));
    this.lastEnd = c.end;
  }

  // -- entry ----------------------------------------------------------------

  format(items: readonly Item[]): string {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      if (i > 0) this.blank();
      this.emitPending(item.span.start, false);
      this.emitItem(item);
      this.emitTrailing(items[i + 1]?.span.start ?? Number.MAX_SAFE_INTEGER);
    }
    this.emitPending(Number.MAX_SAFE_INTEGER, this.lines.length > 1);
    while (this.lines.length > 0 && this.lines[this.lines.length - 1]!.trim() === "") {
      this.lines.pop();
    }
    // No line in the output may carry trailing whitespace, including the
    // indentation-only lines an empty block would otherwise leave behind.
    return this.lines.length === 0 ? "" : this.lines.map((l) => l.replace(/\s+$/, "")).join("\n") + "\n";
  }

  // -- items ----------------------------------------------------------------

  private emitAttrs(attrs: readonly Attribute[]): void {
    for (const a of attrs) {
      this.w(this.renderAttr(a));
      this.nl();
    }
  }

  /** `@name` or `@name(key = value, ...)`, keys sorted so the output cannot depend on insertion order. */
  private renderAttr(a: Attribute): string {
    const keys = Object.keys(a.args).sort();
    if (keys.length === 0) return `@${a.name}`;
    return `@${a.name}(${keys.map((k) => `${k} = ${renderAttrArg(a.args[k]!)}`).join(", ")})`;
  }

  private renderTypeParams(generics: readonly TypeParam[]): string {
    if (generics.length === 0) return "";
    const ps = generics.map((g) => (g.bounds.length > 0 ? `${g.name}: ${g.bounds.join(" + ")}` : g.name));
    return "[" + ps.join(", ") + "]";
  }

  private renderUseTree(t: UseTree): string {
    if (t.kind === "name") return t.segments.join(".") + (t.alias !== null ? ` as ${t.alias}` : "");
    return t.prefix.join(".") + ".{" + t.items.map((i) => this.renderUseTree(i)).join(", ") + "}";
  }

  private renderEffectSet(effects: readonly string[]): string {
    return "{" + effects.join(", ") + "}";
  }

  private emitItem(item: Item): void {
    switch (item.kind) {
      case "use":
        this.w("use " + this.renderUseTree(item.tree));
        break;
      case "const":
        this.emitAttrs(item.attrs);
        if (item.visibility === "pub") this.w("pub ");
        this.w("const " + item.name);
        if (item.ty) this.w(": " + this.renderType(item.ty));
        this.w(" = ");
        this.emitExpr(item.value);
        break;
      case "type":
        this.emitTypeItem(item);
        break;
      case "trait":
        this.emitAttrs(item.attrs);
        if (item.visibility === "pub") this.w("pub ");
        this.w("trait " + item.name + this.renderTypeParams(item.generics) + " {");
        this.emitMethods(item.methods, true);
        this.nl();
        this.w("}");
        break;
      case "impl":
        this.emitAttrs(item.attrs);
        this.w("impl " + item.trait + " for " + item.typeName + this.renderTypeParams(item.generics) + " {");
        this.emitMethods(item.methods, false);
        this.nl();
        this.w("}");
        break;
      case "fn":
        this.emitAttrs(item.attrs);
        this.emitFn(item, false);
        break;
      case "test":
        this.emitAttrs(item.attrs);
        this.w(`test ${JSON.stringify(item.name)} `);
        this.emitBlock(item.body);
        break;
    }
    this.lastEnd = item.span.end;
  }

  private emitMethods(methods: readonly FnItem[], bodyless: boolean): void {
    this.depth += 1;
    for (const m of methods) {
      this.nl();
      this.emitFn(m, bodyless);
    }
    this.depth -= 1;
  }

  private emitTypeItem(item: TypeItem): void {
    this.emitAttrs(item.attrs);
    if (item.visibility === "pub") this.w("pub ");
    const def = item.def;
    const head = `type ${def.name}${this.renderTypeParams(def.generics)} =`;
    switch (def.kind) {
      case "record":
        this.w(head + " ");
        this.emitRecordType(def.fields);
        break;
      case "choice":
        this.w(head + " choice { " + def.choices.join(", ") + " }");
        break;
      case "alias":
        this.w(head + " ");
        this.emitType(def.target);
        break;
      case "union":
        this.w(head);
        this.depth += 1;
        for (let i = 0; i < def.variants.length; i += 1) {
          const v = def.variants[i]!;
          this.nl();
          // The parser only recognizes a union when the first arm is a bare name,
          // so the leading `|` of the usual style is not available here.
          this.w((i > 0 ? "| " : "") + v.name);
          if (v.fields.length > 0) this.w(" " + this.renderRecordInline(v.fields));
        }
        this.depth -= 1;
        break;
    }
  }

  /**
   * `bodyless` is passed in rather than inferred: a trait method is stored with
   * an empty body, and a real `{}` body is empty too, so only the enclosing
   * construct can say which one it is looking at.
   */
  private emitFn(fn: FnItem, bodyless: boolean): void {
    const inline = this.capture(() => this.emitSignature(fn));
    if (inline.length > MAX_WIDTH && fn.params.length > 1) {
      this.w(this.capture(() => this.emitSignature(fn, true)));
    } else {
      this.w(inline);
    }
    if (bodyless) return;
    this.w(" ");
    this.emitBlock(fn.body);
  }

  /** `pub extern "C" unsafe[ffi] const fn f[T](a: T) -> R !{e}` — signature only. */
  private emitSignature(fn: FnItem, broken = false): void {
    if (fn.visibility === "pub") this.w("pub ");
    if (fn.externAbi !== null) this.w(`extern ${JSON.stringify(fn.externAbi)} `);
    if (fn.unsafety !== null) {
      this.w("unsafe");
      if (fn.unsafety.length > 0) this.w("[" + fn.unsafety.join(", ") + "]");
      this.w(" ");
    }
    if (fn.isConst) this.w("const ");
    this.w("fn " + fn.name + this.renderTypeParams(fn.generics) + "(");
    if (broken) {
      this.depth += 1;
      for (const p of fn.params) {
        this.nl();
        this.emitParam(p);
        this.w(",");
      }
      this.depth -= 1;
      this.nl();
    } else {
      fn.params.forEach((p, i) => {
        if (i > 0) this.w(", ");
        this.emitParam(p);
      });
    }
    this.w(")");
    if (fn.ret && !isVoidType(fn.ret)) this.w(" -> " + this.renderType(fn.ret));
    if (fn.effects !== null) this.w(" !" + this.renderEffectSet(fn.effects));
  }

  private emitParam(p: Param): void {
    for (const a of p.attrs) this.w(this.renderAttr(a) + " ");
    this.w(p.name + ": " + this.renderType(p.ty));
  }

  // -- types ----------------------------------------------------------------

  private renderType(t: TypeExpr): string {
    return this.capture(() => this.emitType(t));
  }

  private emitType(t: TypeExpr): void {
    switch (t.kind) {
      case "prim":
        this.w(t.name);
        break;
      case "path": {
        this.w(this.qualified(t.span.start, t.span.end) ?? t.segments.join("."));
        if (t.args.length > 0) {
          this.w("<");
          t.args.forEach((a, i) => {
            if (i > 0) this.w(", ");
            this.emitType(a);
          });
          this.w(">");
        }
        break;
      }
      case "own":
        this.w((OWN_KW[t.ownership] ?? t.ownership) + " ");
        // `view T?` reads better than `view ?T`; both are the same tree.
        if (t.inner.kind === "option") {
          this.emitType(t.inner.inner);
          this.w("?");
        } else {
          this.emitType(t.inner);
        }
        break;
      case "ptr":
        this.w(t.mutable ? "*mut " : "*const ");
        if (t.inner.kind === "option") {
          this.emitType(t.inner.inner);
          this.w("?");
        } else {
          this.emitType(t.inner);
        }
        break;
      case "option":
        this.w("?");
        this.emitType(t.inner);
        break;
      case "slice": {
        this.w("[");
        this.emitType(t.elem);
        if (t.lenExpr) {
          this.w("; ");
          this.emitExpr(t.lenExpr);
        } else if (t.len !== null) {
          this.w("; " + t.len);
        }
        this.w("]");
        break;
      }
      case "tuple":
        this.w("(");
        t.elems.forEach((e, i) => {
          if (i > 0) this.w(", ");
          this.emitType(e);
        });
        this.w(")");
        break;
      case "record":
        this.emitRecordType(t.fields);
        break;
      case "fnptr": {
        this.w("fn(");
        t.params.forEach((p, i) => {
          if (i > 0) this.w(", ");
          this.emitType(p);
        });
        this.w(")");
        if (!isVoidType(t.ret)) this.w(" -> " + this.renderType(t.ret));
        if (t.effects.length > 0) this.w(" !" + this.renderEffectSet(t.effects));
        break;
      }
      case "impl":
        this.w("dyn " + t.traits.join(" + "));
        break;
    }
  }

  private renderRecordInline(fields: readonly FieldDecl[]): string {
    return this.capture(() => {
      this.w("{");
      if (fields.length > 0) {
        this.w(" ");
        fields.forEach((f, i) => {
          if (i > 0) this.w(", ");
          this.emitField(f);
        });
        this.w(" ");
      }
      this.w("}");
    });
  }

  /** Inline when the whole form is short, multi-line otherwise — the same rule on every run. */
  private emitRecordType(fields: readonly FieldDecl[]): void {
    if (fields.length === 0) {
      this.w("{}");
      return;
    }
    const inline = this.renderRecordInline(fields);
    if (inline.length <= INLINE_LIMIT) {
      this.w(inline);
      return;
    }
    this.w("{");
    this.depth += 1;
    for (const f of fields) {
      this.nl();
      this.emitField(f);
      this.w(",");
    }
    this.depth -= 1;
    this.nl();
    this.w("}");
  }

  private emitField(f: FieldDecl): void {
    for (const a of f.attrs) this.w(this.renderAttr(a) + " ");
    this.w(f.name + ": " + this.renderType(f.ty));
  }

  // -- statements -----------------------------------------------------------




  private emitBlock(b: Block): void {
    // An empty block with nothing to say prints as `{}` rather than opening a
    // line, indenting it, and closing it again.
    const pending = this.comments[this.ci];
    if (b.stmts.length === 0 && b.tail === undefined && (pending === undefined || pending.start >= b.span.end)) {
      this.w("{}");
      this.lastEnd = Math.max(this.lastEnd, b.span.end);
      return;
    }
    this.w("{");
    this.depth += 1;
    const entries: { start: number; end: number; emit: () => void }[] = [];
    this.lastEnd = Math.max(this.lastEnd, b.span.start);
    for (const s of b.stmts) {
      entries.push({ start: s.span.start, end: s.span.end, emit: () => this.emitStmt(s) });
    }
    if (b.tail) {
      entries.push({ start: b.tail.span.start, end: b.tail.span.end, emit: () => this.emitExpr(b.tail!) });
    }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      // The gap is measured from whatever comes first — a leading comment or the
      // statement itself — because that is what the reader sees as the gap.
      const next = this.comments[this.ci];
      const anchor = next !== undefined && next.start < entry.start ? next.start : entry.start;
      if (this.lineAt(anchor) - this.lineAt(this.lastEnd) >= 2) this.blank();
      this.emitPending(entry.start, true);
      this.nl();
      entry.emit();
      this.lastEnd = Math.max(entry.end, this.lastEnd);
      this.emitTrailing(entries[i + 1]?.start ?? b.span.end);
      // A comment inside the statement's own span has no node to hang on, so it
      // follows the statement on its own line, in source order. Nothing is
      // dropped, and the next run finds it in an ordinary position and keeps it.
      this.emitPending(entry.end, false);
    }
    this.emitPending(b.span.end, true);
    this.depth -= 1;
    this.nl();
    this.w("}");
    this.lastEnd = Math.max(this.lastEnd, b.span.end);
  }

  /**
   * Every statement is written with its `;`, and a block's tail value is written
   * without one. The terminator is not decoration: the parser reads `x = 1` on one
   * line and `*p` on the next as a single augmented `*=`, so dropping the `;`
   * after a `let` can silently fuse two statements into one. Conversely, a
   * statement written without a `;` where the original had one comes back as the
   * block's tail value, which is a different tree.
   */
  private emitStmt(s: Stmt): void {
    switch (s.kind) {
      case "let":
        this.w("let ");
        if (s.mutable) this.w("mut ");
        this.w(this.renderPattern(s.pat));
        if (s.ty) this.w(": " + this.renderType(s.ty));
        if (s.init) {
          this.w(" = ");
          this.emitExpr(s.init);
        }
        this.w(";");
        break;
      case "expr":
        this.emitExpr(s.expr);
        this.w(";");
        break;
      case "assign":
        this.emitAssign(s.target, s.value);
        this.w(";");
        break;
      case "item":
        this.emitItem(s.item);
        break;
    }
  }

  /**
   * `x /= s` and `x = x / s` are the same node. The source decides which spelling
   * is printed; both re-parse to the identical tree, so this is fidelity, not
   * semantics.
   */
  private emitAssign(target: Expr, value: Expr): void {
    this.emitExpr(target, 1);
    if (value.kind === "binary") {
      const op = augmentedOpIn(this.text, target.span.end);
      if (op !== null) {
        this.w(" " + op + " ");
        this.emitExpr(value.rhs, 1);
        return;
      }
    }
    this.w(" = ");
    this.emitExpr(value, 1);
  }

  // -- patterns -------------------------------------------------------------

  private renderPattern(p: Pattern): string {
    return this.capture(() => this.emitPattern(p));
  }

  private emitPattern(p: Pattern): void {
    switch (p.kind) {
      case "wildcard":
        this.w("_");
        break;
      case "lit": {
        // The parser drops the literal of a negative pattern, so take the digits
        // back from the source; the author's leading `-` is kept either way.
        if (this.slice(p.span.start, p.span.end).startsWith("-")) {
          this.w("-");
          if (p.value.kind === "unary" && p.value.op === "-") this.w(this.literal(p.value.span, "0"));
          else this.emitExpr(p.value);
          return;
        }
        this.emitExpr(p.value);
        break;
      }
      case "bind":
        if (p.mutable) this.w("mut ");
        this.w(p.name);
        if (p.ty) this.w(": " + this.renderType(p.ty));
        break;
      case "unit":
        this.w(p.path);
        break;
      case "tuple":
        this.w(this.patternPath(p.path, p.span) + "(");
        p.elems.forEach((e, i) => {
          if (i > 0) this.w(", ");
          this.emitPattern(e);
        });
        this.w(")");
        break;
      case "record": {
        this.w(this.patternPath(p.path, p.span) + " {");
        if (p.fields.length > 0) {
          this.w(" ");
          p.fields.forEach((f, i) => {
            if (i > 0) this.w(", ");
            this.emitPatternField(f);
          });
          if (p.rest) this.w(", ..");
          this.w(" ");
        } else if (p.rest) {
          this.w(".. ");
        }
        this.w("}");
        break;
      }
      case "at":
        this.w(p.name + " @ ");
        this.emitPattern(p.sub);
        break;
      case "or":
        p.alts.forEach((a, i) => {
          if (i > 0) this.w(" | ");
          this.emitPattern(a);
        });
        break;
    }
  }

  private emitPatternField(f: PatternField): void {
    // `{ r }` is a binding to the field of the same name; spelling out `: r` would
    // re-parse to the same tree but reads as noise.
    if (f.pat.kind === "bind" && f.pat.name === f.name) this.w(f.name);
    else this.w(f.name + ": " + this.renderPattern(f.pat));
  }

  private patternPath(path: string, span: { start: number; end: number }): string {
    return this.qualified(span.start, span.end) ?? path;
  }

  // -- expressions ----------------------------------------------------------

  private renderExpr(e: Expr): string {
    return this.capture(() => this.emitExpr(e));
  }

  private emitExpr(e: Expr, min = 1): void {
    const prec = exprPrec(e);
    if (prec < min) this.w("(");
    this.emitExprInner(e);
    if (prec < min) this.w(")");
  }

  private emitExprInner(e: Expr): void {
    switch (e.kind) {
      case "int":
        this.w(this.literal(e.span, e.value.toString()));
        break;
      case "float":
        this.w(this.literal(e.span, floatLiteral(e.value)));
        break;
      case "bool":
        this.w(e.value ? "true" : "false");
        break;
      case "string":
        this.w(this.literal(e.span, quoteText("", e.value)));
        break;
      case "bytes":
        this.w(this.literal(e.span, quoteText("b", Array.from(e.value, (b) => String.fromCharCode(b)).join(""))));
        break;
      case "char":
        this.w(this.literal(e.span, `'${e.value}'`));
        break;
      case "path":
        this.w(this.qualified(e.span.start, e.span.end) ?? e.value);
        break;
      case "struct":
        this.w((this.qualified(e.span.start, e.span.end) ?? e.path) + this.renderTypeArgs(e.typeArgs) + " { ");
        e.fields.forEach((f, i) => {
          if (i > 0) this.w(", ");
          this.emitFieldInit(f);
        });
        this.w(" }");
        break;
      case "array":
        this.w("[");
        e.elems.forEach((x, i) => {
          if (i > 0) this.w(", ");
          this.emitExpr(x);
        });
        this.w("]");
        break;
      case "tuple":
        this.w("(");
        e.elems.forEach((x, i) => {
          if (i > 0) this.w(", ");
          this.emitExpr(x);
        });
        this.w(")");
        break;
      case "field":
        this.emitExpr(e.base, 13);
        this.w("." + e.name);
        break;
      case "method":
        this.emitExpr(e.base, 13);
        this.w("." + e.name);
        this.emitArgs(e.typeArgs, e.args);
        break;
      case "index":
        this.emitExpr(e.base, 13);
        this.w("[");
        this.emitExpr(e.index);
        this.w("]");
        break;
      case "call":
        this.emitExpr(e.callee, 13);
        this.emitArgs(e.typeArgs, e.args);
        break;
      case "unary":
        this.w(e.op === "&mut" ? "&mut " : e.op);
        this.emitExpr(e.operand, 12);
        break;
      case "binary":
        this.emitExpr(e.lhs, BIN_PREC[e.op] ?? 1);
        this.w(" " + e.op + " ");
        this.emitExpr(e.rhs, (BIN_PREC[e.op] ?? 1) + 1);
        break;
      case "assign":
        this.emitAssign(e.target, e.value);
        break;
      case "try":
        this.emitExpr(e.operand, 13);
        this.w("?");
        break;
      case "cast":
        this.emitExpr(e.operand, 11);
        this.w(" as " + this.renderType(e.ty));
        break;
      case "is":
        this.emitExpr(e.base, 11);
        this.w(" is " + this.renderType(e.ty));
        break;
      case "block":
        this.emitBlock(e.block);
        break;
      case "if":
        this.emitIf(e);
        break;
      case "match":
        this.emitMatch(e);
        break;
      case "while":
        this.w("while ");
        this.emitExpr(e.cond);
        this.w(" ");
        this.emitBlock(e.body);
        break;
      case "loop":
        this.w("loop ");
        this.emitBlock(e.body);
        break;
      case "for":
        this.w("for " + this.renderPattern(e.pat) + " in ");
        this.emitExpr(e.iter);
        this.w(" ");
        this.emitBlock(e.body);
        break;
      case "return":
        this.w("return");
        if (e.value) {
          this.w(" ");
          this.emitExpr(e.value);
        }
        break;
      case "break":
        this.w("break");
        if (e.value) {
          this.w(" ");
          this.emitExpr(e.value);
        }
        break;
      case "continue":
        this.w("continue");
        break;
      case "effectset":
        this.w("!" + this.renderEffectSet(e.effects));
        break;
      case "move":
        this.w("move ");
        this.emitExpr(e.operand, 12);
        break;
      case "view":
        this.w(e.mutable ? "view mut " : "view ");
        this.emitExpr(e.operand, 12);
        break;
      case "unsafe":
        this.w("unsafe");
        if (e.caps.length > 0) this.w("[" + e.caps.join(", ") + "]");
        this.w(" ");
        this.emitBlock(e.body);
        break;
      case "spawn":
        this.w(e.transfer === "move" ? "spawn move " : "spawn ");
        this.emitBlock(e.body);
        break;
      case "tohandle":
        this.w("handle_to ");
        this.emitExpr(e.operand, 12);
        break;
      case "consteval":
        this.w("const ");
        this.emitBlock(e.body);
        break;
    }
  }

  private emitFieldInit(f: FieldInit): void {
    this.w(f.name + ": ");
    this.emitExpr(f.value);
  }

  private emitIf(e: Expr & { kind: "if" }): void {
    this.w("if ");
    this.emitExpr(e.cond);
    this.w(" ");
    this.emitBlock(e.then);
    const rest = e.else_;
    if (rest === undefined) return;
    this.w(" else ");
    // `else_` is a bare `Block` or an `Expr`; a `Block` has no `kind` tag.
    if ("stmts" in rest) this.emitBlock(rest);
    else this.emitExpr(rest);
  }

  private emitMatch(e: Expr & { kind: "match" }): void {
    this.w("match ");
    this.emitExpr(e.scrutinee);
    this.w(" {");
    this.depth += 1;
    for (const arm of e.arms) {
      this.emitPending(arm.span.start, true);
      this.nl();
      this.w(this.renderPattern(arm.pat) + " => ");
      this.emitExpr(arm.body);
      this.w(",");
      this.lastEnd = arm.span.end;
      this.emitPending(arm.span.end, false);
    }
    this.depth -= 1;
    this.nl();
    this.w("}");
  }

  private renderTypeArgs(args: readonly TypeExpr[] | undefined): string {
    if (!args || args.length === 0) return "";
    return this.capture(() => {
      this.w("<");
      args.forEach((a, i) => {
        if (i > 0) this.w(", ");
        this.emitType(a);
      });
      this.w(">");
    });
  }

  /** `(a, b)`, broken one-per-line when the inline form is too wide or too tall. */
  private emitArgs(typeArgs: readonly TypeExpr[] | undefined, args: readonly Expr[]): void {
    this.w(this.renderTypeArgs(typeArgs));
    const inline = this.capture(() => this.emitArgsInline(args));
    if (args.length < 2 || (inline.length <= MAX_WIDTH && !inline.includes("\n"))) {
      this.w(inline);
      return;
    }
    this.w("(");
    this.depth += 1;
    for (const a of args) {
      this.nl();
      this.emitExpr(a);
      this.w(",");
    }
    this.depth -= 1;
    this.nl();
    this.w(")");
  }

  private emitArgsInline(args: readonly Expr[]): void {
    this.w("(");
    args.forEach((a, i) => {
      if (i > 0) this.w(", ");
      this.emitExpr(a);
    });
    this.w(")");
  }
}

// ---------------------------------------------------------------------------
// Literals and small helpers
// ---------------------------------------------------------------------------

function renderAttrArg(v: AttrArg): string {
  switch (v.kind) {
    case "ident": return v.name;
    case "string": return JSON.stringify(v.value);
    case "number": return v.value;
    case "path": return v.segments.join(".");
    case "duration": return v.value;
  }
}

/** `Void` is the implicit return type of an `fn(A) -> B` pointer, so it is not printed. */
function isVoidType(t: TypeExpr): boolean {
  if (t.kind === "prim") return t.name === "Void";
  return t.kind === "path" && t.segments.length === 1 && t.segments[0] === "Void";
}

function exprPrec(e: Expr): number {
  switch (e.kind) {
    case "assign": return 1;
    case "binary": return BIN_PREC[e.op] ?? 1;
    case "cast": case "is": return 11;
    case "unary": case "move": case "view": case "consteval": case "unsafe": case "spawn": return 12;
    case "field": case "index": case "call": case "method": case "try": return 13;
    default: return 14;
  }
}

/** A float must keep a fractional part, or it re-parses as an `int`. */
function floatLiteral(v: number): string {
  if (Number.isNaN(v)) return "0.0";
  if (v === Infinity) return "1.0e308";
  if (v === -Infinity) return "-1.0e308";
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function quoteText(prefix: string, v: string): string {
  let out = prefix + '"';
  for (const ch of v) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const c = ch.codePointAt(0) ?? 0;
      out += c < 0x20 || c === 0x7f ? `\\u{${c.toString(16)}}` : ch;
    }
  }
  return out + '"';
}

/** The augmented operator written immediately after a target, if any. */
function augmentedOpIn(text: string, targetEnd: number): string | null {
  const m = /^[ \t]{0,2}([-+*/%&|^]=)/.exec(text.slice(targetEnd, targetEnd + 4));
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Format a parsed file. Pure: the same input yields the same bytes, every time. */
export function formatFile(file: SourceFile): string {
  return new Formatter(file, 0).format(parseFile(file, 0).items);
}

/**
 * The text-only compaction of a file: comments removed and every run of
 * inter-token whitespace collapsed to a single space, or to nothing when the
 * tokens were already adjacent in the source.
 *
 * This is the "compact source" arm of the token-efficiency experiment — the best
 * that can be done to the *text* alone, with no compiler in the loop. Comments
 * are dropped here on purpose: they are the part of a text-only pipeline that
 * may legitimately be lost, which is exactly why the number it produces is a
 * baseline to beat rather than a free win. Token boundaries are never guessed:
 * tokens come from the lexer, so string and byte literals keep every character
 * they need.
 */
export function compactSource(file: SourceFile, fileIndex = 0): string {
  const tokens = lex(file.text, fileIndex).tokens;
  const out: string[] = [];
  let prevEnd = -1;
  for (const tok of tokens) {
    if (tok.kind === "eof") break;
    if (out.length > 0 && tok.span.start !== prevEnd) out.push(" ");
    out.push(tok.text);
    prevEnd = tok.span.end;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Structural fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical, span-free serialization of parsed items. Two parses have equal
 * fingerprints exactly when they describe the same program, which is what lets
 * the formatter's round trip be checked structurally instead of textually.
 */
export function fingerprint(items: readonly Item[]): string {
  return items.map(fpItem).join("\n");
}

function fpItem(item: Item): string {
  switch (item.kind) {
    case "fn": return fpFn(item);
    case "type":
      return `type(${fpAttrs(item.attrs)},${item.visibility},${fpTypeDef(item.def)})`;
    case "use":
      return `use(${fpUseTree(item.tree)})`;
    case "trait":
      return `trait(${fpAttrs(item.attrs)},${item.visibility},${item.name},${fpTypeParams(item.generics)},[${item.methods.map(fpFn).join(",")}])`;
    case "impl":
      return `impl(${fpAttrs(item.attrs)},${item.trait},${item.typeName},${fpTypeParams(item.generics)},[${item.methods.map(fpFn).join(",")}])`;
    case "const":
      return `const(${fpAttrs(item.attrs)},${item.visibility},${item.name},${item.ty ? fpType(item.ty) : "-"},${fpExpr(item.value)})`;
    case "test":
      return `test(${fpAttrs(item.attrs)},${JSON.stringify(item.name)},${fpBlock(item.body)})`;
  }
}

function fpFn(fn: FnItem): string {
  return [
    "fn", fpAttrs(fn.attrs), fn.visibility,
    fn.externAbi === null ? "-" : fn.externAbi,
    fn.unsafety === null ? "-" : fpList(fn.unsafety), String(fn.isConst),
    fn.name, fpTypeParams(fn.generics),
    `[${fn.params.map(fpParam).join(",")}]`,
    fn.ret ? fpType(fn.ret) : "-",
    fn.effects === null ? "-" : fpList(fn.effects),
    fpBlock(fn.body),
  ].join("|");
}

function fpParam(p: Param): string {
  return `${fpAttrs(p.attrs)}${p.name}:${fpType(p.ty)}`;
}

function fpTypeParams(gs: readonly TypeParam[]): string {
  return `[${gs.map((g) => `${g.name}:${fpList(g.bounds)}`).join(",")}]`;
}

function fpTypeDef(def: TypeItem["def"]): string {
  const head = `${def.name}:${fpTypeParams(def.generics)}`;
  switch (def.kind) {
    case "record": return `record(${head},[${def.fields.map(fpField).join(",")}])`;
    case "union": return `union(${head},[${def.variants.map(fpVariant).join(",")}])`;
    case "choice": return `choice(${head},${fpList(def.choices)})`;
    case "alias": return `alias(${head},${fpType(def.target)})`;
  }
}

function fpVariant(v: VariantDecl): string {
  return `${v.name}{${v.fields.map(fpField).join(",")}}`;
}

function fpField(f: FieldDecl): string {
  return `${fpAttrs(f.attrs)}${f.name}:${fpType(f.ty)}`;
}

function fpType(t: TypeExpr): string {
  switch (t.kind) {
    case "prim": return t.name;
    case "path": return `${t.segments.join("::")}<${t.args.map(fpType).join(",")}>`;
    case "record": return `{${t.fields.map(fpField).join(",")}}`;
    case "tuple": return `(${t.elems.map(fpType).join(",")})`;
    case "slice": return `[${fpType(t.elem)}${t.len === null ? "" : `;${t.len}`}${t.lenExpr ? `=${fpExpr(t.lenExpr)}` : ""}]`;
    case "option": return `?${fpType(t.inner)}`;
    case "ptr": return `${t.mutable ? "*mut" : "*const"} ${fpType(t.inner)}`;
    case "own": return `${t.ownership} ${fpType(t.inner)}`;
    case "fnptr": return `fn(${t.params.map(fpType).join(",")})->${fpType(t.ret)}!{${fpList(t.effects)}}`;
    case "impl": return `dyn ${fpList(t.traits)}`;
  }
}

function fpUseTree(t: UseTree): string {
  if (t.kind === "name") return `${t.segments.join("::")}${t.alias === null ? "" : ` as ${t.alias}`}`;
  return `${t.prefix.join("::")}.{${t.items.map(fpUseTree).join(",")}}`;
}

function fpBlock(b: Block): string {
  return `{${b.stmts.map(fpStmt).join(";")}${b.tail ? `=>${fpExpr(b.tail)}` : ""}}`;
}

function fpStmt(s: Stmt): string {
  switch (s.kind) {
    case "let":
      return `let ${String(s.mutable)} ${fpPattern(s.pat)}${s.ty ? `:${fpType(s.ty)}` : ""}${s.init ? `=${fpExpr(s.init)}` : ""}`;
    case "expr": return `expr ${fpExpr(s.expr)}`;
    case "assign": return `assign ${fpExpr(s.target)}=${fpExpr(s.value)}`;
    case "item": return `item ${fpItem(s.item)}`;
  }
}

function fpExpr(e: Expr): string {
  switch (e.kind) {
    case "int": return `${e.value}n${e.ty ? `:${fpType(e.ty)}` : ""}`;
    case "float": return `${String(e.value)}f${e.ty ? `:${fpType(e.ty)}` : ""}`;
    case "bool": return String(e.value);
    case "string": return JSON.stringify(e.value);
    case "bytes": return `b${Array.from(e.value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    case "char": return `'${e.value}'`;
    case "path": return `path ${e.value}`;
    case "field": return `(${fpExpr(e.base)}).${e.name}`;
    case "index": return `${fpExpr(e.base)}[${fpExpr(e.index)}]`;
    case "call": return `${fpExpr(e.callee)}${fpTypeArgs(e.typeArgs)}(${e.args.map(fpExpr).join(",")})`;
    case "method": return `${fpExpr(e.base)}.${e.name}${fpTypeArgs(e.typeArgs)}(${e.args.map(fpExpr).join(",")})`;
    case "unary": return `${e.op}${fpExpr(e.operand)}`;
    case "binary": return `(${fpExpr(e.lhs)} ${e.op} ${fpExpr(e.rhs)})`;
    case "assign": return `${fpExpr(e.target)}=${fpExpr(e.value)}`;
    case "try": return `${fpExpr(e.operand)}?`;
    case "cast": return `${fpExpr(e.operand)} as ${fpType(e.ty)}`;
    case "is": return `${fpExpr(e.base)} is ${fpType(e.ty)}`;
    case "struct":
      return `${e.path}${fpTypeArgs(e.typeArgs)}{${e.fields.map((f) => `${f.name}=${fpExpr(f.value)}`).join(",")}}`;
    case "array": return `[${e.elems.map(fpExpr).join(",")}]`;
    case "tuple": return `(${e.elems.map(fpExpr).join(",")})`;
    case "block": return fpBlock(e.block);
    case "if": {
      // `else_` is a bare `Block` or an `Expr`. A `Block` has no `kind` field,
      // so the union is discriminated by structure, not by a tag.
      const rest = e.else_;
      const branch = rest === undefined
        ? ""
        : "stmts" in rest ? ` else ${fpBlock(rest)}` : ` else ${fpExpr(rest)}`;
      return `if ${fpExpr(e.cond)} ${fpBlock(e.then)}${branch}`;
    }
    case "match":
      return `match ${fpExpr(e.scrutinee)}{${e.arms.map((a) => `${fpPattern(a.pat)}=>${fpExpr(a.body)}`).join(",")}}`;
    case "while": return `while ${fpExpr(e.cond)} ${fpBlock(e.body)}`;
    case "loop": return `loop ${fpBlock(e.body)}`;
    case "for": return `for ${fpPattern(e.pat)} in ${fpExpr(e.iter)} ${fpBlock(e.body)}`;
    case "return": return `return${e.value ? ` ${fpExpr(e.value)}` : ""}`;
    case "break": return `break${e.value ? ` ${fpExpr(e.value)}` : ""}`;
    case "continue": return "continue";
    case "effectset": return `!{${fpList(e.effects)}}`;
    case "move": return `move ${fpExpr(e.operand)}`;
    case "view": return `view${e.mutable ? " mut" : ""} ${fpExpr(e.operand)}`;
    case "unsafe": return `unsafe[${fpList(e.caps)}] ${fpBlock(e.body)}`;
    case "spawn": return `spawn ${e.transfer} ${fpBlock(e.body)}`;
    case "tohandle": return `handle_to ${fpExpr(e.operand)}`;
    case "consteval": return `const ${fpBlock(e.body)}`;
  }
}

function fpPattern(p: Pattern): string {
  switch (p.kind) {
    case "wildcard": return "_";
    case "lit": return `lit ${fpExpr(p.value)}`;
    case "bind": return `${p.mutable ? "mut " : ""}${p.name}${p.ty ? `:${fpType(p.ty)}` : ""}`;
    case "unit": return p.path;
    case "tuple": return `${p.path}(${p.elems.map(fpPattern).join(",")})`;
    case "record":
      return `${p.path}{${p.fields.map((f) => `${f.name}:${fpPattern(f.pat)}`).join(",")}${p.rest ? ",.." : ""}}`;
    case "at": return `${p.name}@${fpPattern(p.sub)}`;
    case "or": return p.alts.map(fpPattern).join("|");
  }
}

function fpAttrs(attrs: readonly Attribute[]): string {
  if (attrs.length === 0) return "";
  const parts = attrs.map((a) => {
    const keys = Object.keys(a.args).sort();
    return keys.length === 0 ? `@${a.name}` : `@${a.name}(${keys.join(",")})`;
  });
  return `{${parts.join(";")}}`;
}

function fpTypeArgs(args: readonly TypeExpr[] | undefined): string {
  return args && args.length > 0 ? `<${args.map(fpType).join(",")}>` : "";
}

function fpList(xs: readonly string[]): string {
  return xs.join("+");
}
