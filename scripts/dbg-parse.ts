import { readFileSync } from "node:fs";
import { lex } from "../src/lexer.ts";
import { parseFile } from "../src/parser.ts";

const src = process.argv[2] ?? "";
const text = readFileSync(src, "utf8");
const file = { module: "t", text, bytes: new TextEncoder().encode(text) };

const { tokens, diagnostics: lexDiags } = lex(text, 0);
if (lexDiags.length) console.log("LEX DIAGS:", lexDiags);

const parsed = parseFile(file, 0);
console.log("ITEMS:", parsed.items.map((i) => i.kind).join(", "));
if (parsed.diagnostics.length) {
  console.log("FIRST 5 DIAGS:");
  for (const d of parsed.diagnostics.slice(0, 5)) {
    const line = text.slice(0, d.span.start).split("\n").length;
    console.log(`  ${d.code} line ${line}: ${d.message}`);
    console.log(`    >> ${JSON.stringify(text.slice(d.span.start, d.span.end))}`);
  }
  console.log("TOKENS AROUND FIRST DIAG:");
  const at = tokens.findIndex((t) => t.span.start >= parsed.diagnostics[0]!.span.start);
  for (const t of tokens.slice(Math.max(0, at - 6), at + 6)) {
    console.log(`    ${t.kind.padEnd(7)} ${JSON.stringify(t.text)}`);
  }
}
