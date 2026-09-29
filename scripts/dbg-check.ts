import { readFileSync } from "node:fs";
import { analyzePasses } from "../src/check.ts";

const path = process.argv[2]!;
const text = readFileSync(path, "utf8");
const module = path.split(/[\\/]/).pop()!.replace(/\.mm$/, "");
const result = analyzePasses([{ module, text }]);
const diags = result.program.diagnostics;
console.log(`== ${path} ==`);
if (diags.length === 0) {
  console.log("  no diagnostics");
}
for (const d of diags) {
  const line = text.slice(0, d.span.start).split("\n").length;
  const src = text.slice(d.span.start, d.span.end).split("\n")[0]!.slice(0, 40);
  console.log(`  ${d.severity === "error" ? "error" : "warn "} ${d.code} ${d.kind} @${line}: ${d.message}`);
  console.log(`        >> ${JSON.stringify(src)}`);
  if (d.repairs?.length) {
    console.log(`        repairs: ${d.repairs.map((r) => r.op).join(", ")}`);
  }
}
if (result.system) {
  console.log(`  system plan: ${result.system.entries.length} entries, requests [${result.system.requested.join(", ")}]`);
}
