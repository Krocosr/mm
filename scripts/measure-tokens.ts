#!/usr/bin/env bun
/**
 * MM — the token-efficiency experiment.
 *
 * The report's central measurable claim is R_token: an agent working from semantic
 * packets should need materially fewer tokens than one reading source, *without* losing
 * task success. Measuring the first half is what this script does; the second half needs
 * an agent run, and is not faked here.
 *
 * Two conditions are measured for real:
 *
 *   Baseline       the agent reads the `.mm` source
 *   Semantic text  the agent reads a compiler-produced packet for the same module
 *
 * A third condition — compact source — is a formatter, not a compiler projection, and is
 * measured so the two effects are not confused.
 *
 * Every row records which tokenizer produced it and whether that tokenizer is an
 * approximation. A ratio computed from a character-count proxy is never reported as a
 * token saving — and a number that looks like a result but is not would be worse
 * than no number at all.
 *
 * See docs/spec/kernel.md §7.3.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { analyzePasses } from "../src/check.ts";
import { buildGraph } from "../src/graph.ts";
import { renderPacket } from "../src/packet.ts";
import { type Measurement, compare, resolveTokenizer } from "../src/tokens.ts";
import { formatFile } from "../src/format.ts";

/** One measured (file, condition) pair, with the provenance the report demands. */
interface Row {
  file: string;
  condition: string;
  chars: number;
  tokens: number;
  tokenizerId: string;
  approximate: boolean;
}

async function measureAll(corpusDir: string, tokenizerId: string): Promise<{ rows: Row[]; note: string }> {
  const resolved = await resolveTokenizer(tokenizerId);
  if (resolved.status === "unavailable") {
    return { rows: [], note: resolved.reason };
  }
  const tok = resolved.tokenizer;
  const rows: Row[] = [];

  for (const file of readdirSync(corpusDir).sort()) {
    if (!file.endsWith(".mm")) continue;
    const text = readFileSync(join(corpusDir, file), "utf8");
    const module = file.replace(/\.mm$/, "");
    const program = analyzePasses([{ module, text }]).program;
    const graph = buildGraph(program);

    const conditions: Array<{ name: string; body: string }> = [
      // The baseline the agent actually faces: the source it would read.
      { name: "baseline-source", body: text },
      // The compiler projection: signatures, effects, call edges; no imports or comments.
      { name: "semantic-packet", body: renderPacket(graph, { nodes: graph.byKind("fn").map((n) => n.hash) }) },
      // Deterministic formatting — included so its effect is not credited to the graph.
      { name: "compact-source", body: formatFile({ module, text, bytes: new TextEncoder().encode(text) }) },
    ];

    for (const c of conditions) {
      rows.push({
        file,
        condition: c.name,
        chars: c.body.length,
        tokens: tok.count(c.body),
        tokenizerId: tok.id,
        approximate: tok.approximate,
      });
    }
  }
  return { rows, note: "" };
}

function total(rows: Row[], condition: string): Measurement {
  const sel = rows.filter((r) => r.condition === condition);
  const first = sel[0];
  return {
    tokens: sel.reduce((a, r) => a + r.tokens, 0),
    tokenizerId: first?.tokenizerId ?? "none",
    approximate: sel.some((r) => r.approximate),
    chars: sel.reduce((a, r) => a + r.chars, 0),
  };
}

async function main(): Promise<number> {
  const corpusDir = process.argv[2] ?? "examples";
  const tokenizerId = process.argv[3] ?? "heuristic/v1";
  const { rows, note } = await measureAll(corpusDir, tokenizerId);
  if (rows.length === 0) {
    console.error(`measure-tokens: no rows measured — ${note}`);
    return 1;
  }

  const base = total(rows, "baseline-source");
  const semantic = total(rows, "semantic-packet");
  const compact = total(rows, "compact-source");
  const rSemantic = compare(base, semantic);
  const rCompact = compare(base, compact);

  console.log(`corpus: ${corpusDir} (${new Set(rows.map((r) => r.file)).size} files)`);
  console.log(`tokenizer: ${base.tokenizerId}${base.approximate ? "  [APPROXIMATE]" : ""}`);
  console.log("");
  console.log("condition          tokens   characters   vs baseline");
  for (const c of [base, semantic, compact]) {
    const r = compare(base, c);
    const pct = r.valid && r.ratio !== null ? `  ${(r.ratio * 100).toFixed(1)}%` : "  n/a";
    console.log(
      `${c === base ? "baseline-source" : c === semantic ? "semantic-packet" : "compact-source"}`.padEnd(19) +
      `${String(c.tokens).padStart(6)}   ${String(c.chars).padStart(10)}   ${pct}`,
    );
  }
  console.log("");
  console.log(`R_token (semantic packet / source): ${rSemantic.ratio === null ? "invalid" : rSemantic.ratio.toFixed(4)}`);
  console.log(`R_token (compact source  / source): ${rCompact.ratio === null ? "invalid" : rCompact.ratio.toFixed(4)}`);
  if (base.approximate) {
    console.log("");
    console.log(
      "NOTE: this tokenizer is an APPROXIMATION. The ratio is a character-density\n" +
      "      comparison, not a measured model-vocabulary saving. Re-run with a real\n" +
      "      tokenizer before quoting this as a token result.",
    );
  }
  console.log("");
  console.log("NOT MEASURED: the fourth condition, 'semantic tools' (the agent querying the");
  console.log("  graph live rather than receiving a packet), and the task-success rate that");
  console.log("  the report requires alongside any token saving. Both need an agent run over");
  console.log("  a fixed task set; neither is estimated here.");

  mkdirSync("bench", { recursive: true });
  writeFileSync(
    "bench/tokens.json",
    `${JSON.stringify({
      corpus: corpusDir,
      tokenizerId: base.tokenizerId,
      approximate: base.approximate,
      conditions: {
        baselineSource: base,
        semanticPacket: semantic,
        compactSource: compact,
      },
      ratios: { semanticPacket: rSemantic, compactSource: rCompact },
      notMeasured: ["semantic-tools (live queries)", "task success rate"],
      rows,
    }, null, 2)}\n`,
  );
  console.log("wrote bench/tokens.json");
  return 0;
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; });
}
