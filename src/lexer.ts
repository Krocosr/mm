/**
 * MM — lexer.
 *
 * Produces a flat token stream. Errors are collected, never thrown, so a single
 * malformed file still yields every diagnostic it deserves (agents pay per round trip;
 * one error per compile is the expensive case).
 *
 * See docs/spec/kernel.md §1.
 */

import { type Diagnostic, type Span, diag } from "./ast.ts";

export type TokKind =
  | "ident" | "int" | "float" | "string" | "bytes" | "cstr" | "char"
  | "keyword" | "punct" | "eof";

export interface Token {
  readonly kind: TokKind;
  /** For ident/keyword: the name. punct: the symbol. literals: the raw text. */
  readonly text: string;
  readonly span: Span;
  /** Parsed value for literals. */
  readonly value?: bigint | number | string;
  /** True when a newline (or block-comment boundary) preceded this token. */
  readonly nlBefore: boolean;
}

export const KEYWORDS: Record<string, true> = {
  use: true, type: true, fn: true, trait: true, impl: true, const: true, test: true,
  pub: true, unsafe: true, extern: true, return: true, break: true, continue: true,
  let: true, mut: true, match: true, if: true, else: true, while: true, for: true,
  loop: true, in: true, move: true, view: true, shared: true, arena: true, handle: true,
  as: true, is: true, choice: true, spawn: true, task: true, dyn: true,
  true: true, false: true, self: true,
};

/** Longest-first so `<<=` beats `<<` beats `<`. */
const PUNCT: string[] = [
  "->", "=>", "==", "!=", "<=", ">=", "&&", "||", "<<=", ">>=", "::", "..", "<<", ">>",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "+", "-", "*", "/", "%", "<", ">", "=", "!", "&", "|", "^", "?", ".", ",", ":",
  ";", "(", ")", "[", "]", "{", "}", "@", "#", "~", "$",
];

function isIdentCont(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || (c >= 48 && c <= 57);
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

export function lex(text: string, fileIndex: number): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  // Offsets are UTF-16 code-unit indices into `text`, not byte offsets. The parser slices
  // `text` with these numbers, and `SourceFile.bytes` is only used by consumers that
  // genuinely want bytes. Mixing the two silently desynchronizes every span as soon as a
  // multi-byte character appears anywhere earlier in the file.
  const n = text.length;
  let i = 0;
  let nl = false;
  let depth = 0; // bracket depth: newlines only set `nl` at depth 0

  const at = (off = 0): number => (i + off < n ? text.charCodeAt(i + off) : -1);
  const sp = (start: number, end: number): Span => ({ start, end, file: fileIndex });
  const push = (kind: TokKind, s: number, e: number, value?: bigint | number | string): void => {
    tokens.push({
      kind,
      text: text.slice(s, e),
      span: sp(s, e),
      value,
      nlBefore: nl,
    });
    nl = false;
  };

  while (i < n) {
    const c = at();

    // ---- whitespace -------------------------------------------------------
    if (c === 10 || c === 13) {
      if (c === 13 && at(1) === 10) i += 2;
      else i += 1;
      if (depth === 0) nl = true;
      continue;
    }
    if (c === 32 || c === 9) { i += 1; continue; }

    // ---- comments ---------------------------------------------------------
    if (c === 47 /* / */ && at(1) === 47) {
      while (i < n && at() !== 10 && at() !== 13) i += 1;
      continue;
    }
    if (c === 47 && at(1) === 42 /* * */) {
      const start = i;
      i += 2;
      let closed = false;
      while (i < n) {
        if (at() === 42 && at(1) === 47) { i += 2; closed = true; break; }
        if (at() === 10 && depth === 0) nl = true;
        i += 1;
      }
      if (!closed) {
        diagnostics.push(diag("E0103", "unterminated_block_comment", "unterminated block comment", sp(start, n)));
      }
      continue;
    }

    // ---- strings / bytes / cstrings --------------------------------------
    if (c === 34 /* " */ || c === 98 && at(1) === 34 /* b" */ || c === 99 && at(1) === 34 /* c" */) {
      const start = i;
      const prefix = c === 34 ? "" : text[i]!;
      const isBytes = prefix === "b";
      i += prefix === "" ? 1 : 2;
      // The delimiter is always `"`; `at()` here already points *inside* the literal, so
      // using it as the terminator would close every string on its first character.
      const quote = 34;
      let value = "";
      let terminated = false;
      let segmentStart = i;
      while (i < n) {
        const d = at();
        if (d === 92 /* \ */) {
          value += text.slice(segmentStart, i);
          i += 1;
          const e = at();
          const simple: Record<string, string> = {
            n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'",
          };
          if (simple[e] !== undefined) { value += simple[e]; i += 1; }
          else if (e === 117 /* u */ && at(1) === 123) {
            i += 2;
            const close = text.indexOf("}", i);
            if (close < 0) break;
            const cp = Number.parseInt(text.slice(i, close), 16);
            if (Number.isFinite(cp)) value += String.fromCodePoint(cp);
            i = close + 1;
          } else { value += String.fromCharCode(e < 0 ? 0 : e); i += 1; }
          segmentStart = i;
          continue;
        }
        if (d === quote) { terminated = true; break; }
        value += text[i]!;
        i += 1;
      }
      if (!terminated) {
        diagnostics.push(diag("E0104", "unterminated_string", "unterminated string literal", sp(start, n)));
        push(isBytes ? "bytes" : "string", start, n, value);
        break;
      }
      i += 1;
      push(isBytes ? "bytes" : "string", start, i, value);
      continue;
    }

    // ---- char literal -----------------------------------------------------
    if (c === 39 /* ' */) {
      const start = i;
      i += 1;
      let value = "";
      if (at() === 92) {
        i += 1;
        const e = at();
        const simple: Record<string, string> = {
          n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", "'": "'",
        };
        value = simple[e] ?? String.fromCharCode(e < 0 ? 0 : e);
        i += 1;
      } else {
        // One Unicode scalar: 1 code unit below U+0800, a surrogate pair above it.
        const cp = text.codePointAt(i);
        if (cp !== undefined) {
          const len = cp < 0x80 ? 1 : cp < 0x800 ? 1 : 2;
          value = text.slice(i, i + len);
          i += len;
        }
      }
      if (at() !== 39) {
        diagnostics.push(diag("E0105", "unterminated_char", "unterminated char literal", sp(start, i)));
        push("char", start, i, value);
        continue;
      }
      i += 1;
      push("char", start, i, value);
      continue;
    }

    // ---- numbers ----------------------------------------------------------
    if (isDigit(c)) {
      const start = i;
      // 0x / 0b / 0o
      if (c === 48 && (at(1) === 120 || at(1) === 98 || at(1) === 111)) {
        const marker = at(1) === 120 ? "0x" : at(1) === 98 ? "0b" : "0o";
        i += 2;
        const digitsStart = i;
        while (i < n && (isIdentCont(at()) || at() === 95)) i += 1;
        const raw = text.slice(digitsStart, i).replace(/_/g, "");
        // The radix marker must be re-attached: `BigInt` parses `FF` as a decimal digit
        // string and throws, taking the whole compile down with it.
        const valid = new RegExp(`^${{ "0x": "[0-9a-fA-F]", "0b": "[01]", "0o": "[0-7]" }[marker]}+$`);
        if (raw.length === 0 || !valid.test(raw)) {
          diagnostics.push(diag("E0106", "invalid_int", `invalid \`${marker}\` integer literal`, sp(start, i)));
          push("int", start, i, 0n);
          continue;
        }
        push("int", start, i, BigInt(marker + raw));
        continue;
      }
      while (i < n && (isDigit(at()) || at() === 95)) i += 1;
      // float: `.` followed by a digit, or exponent
      let isFloat = false;
      if (at() === 46 && isDigit(at(1))) {
        isFloat = true;
        i += 1;
        while (i < n && isDigit(at())) i += 1;
      }
      if (at() === 101 || at() === 69) {
        const save = i;
        i += 1;
        if (at() === 43 || at() === 45) i += 1;
        if (isDigit(at())) {
          isFloat = true;
          while (i < n && isDigit(at())) i += 1;
        } else { i = save; }
      }
      // generic suffix: u8/i32/f64/usize/...
      const suffixStart = i;
      while (i < n && isIdentCont(at())) i += 1;
      const suffix = text.slice(suffixStart, i);
      if (isFloat || suffix === "f32" || suffix === "f64") {
        const v = Number.parseFloat(text.slice(start, suffixStart).replace(/_/g, ""));
        push("float", start, i, Number.isNaN(v) ? 0 : v);
      } else {
        const v = BigInt(text.slice(start, suffixStart).replace(/_/g, "") || "0");
        push("int", start, i, v);
      }
      continue;
    }

    // ---- identifiers / keywords ------------------------------------------
    if (isIdentCont(c) && !isDigit(c)) {
      const start = i;
      while (i < n && isIdentCont(at())) i += 1;
      const name = text.slice(start, i);
      push(KEYWORDS[name] ? "keyword" : "ident", start, i);
      continue;
    }

    // ---- punctuation ------------------------------------------------------
    let matched = "";
    for (const p of PUNCT) {
      if (text.startsWith(p, i)) { matched = p; break; }
    }
    if (matched === "") {
      diagnostics.push(
        diag("E0101", "unexpected_char", `unexpected character ${JSON.stringify(text[i] ?? "<eof>")}`, sp(i, i + 1)),
      );
      i += 1;
      continue;
    }
    if (matched === "(" || matched === "[" || matched === "{") depth += 1;
    if (matched === ")" || matched === "]" || matched === "}") depth = Math.max(0, depth - 1);
    push("punct", i, i + matched.length);
    i += matched.length;
  }

  tokens.push({ kind: "eof", text: "", span: sp(n, n), nlBefore: nl });
  return { tokens, diagnostics };
}
