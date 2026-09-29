/**
 * MM — deterministic decision record/replay.
 *
 * An agent decision is the one place an MM program is legitimately
 * nondeterministic, which makes it the one place CI needs to freeze. Three modes:
 *
 * - `live`    — call the provider. Nothing is written.
 * - `record`  — call the provider and append the result to an append-only log
 *               keyed by a content hash of the *inputs*, so the same input always
 *               replays the same output.
 * - `replay`  — read the log and return the recorded decision. An input with no
 *               recorded decision is a hard error: falling back to a live call
 *               would reintroduce exactly the nondeterminism this exists to
 *               remove, and it would fail differently in CI than on a laptop.
 *
 * The provider is an interface, so a Jev (or any other) adapter plugs in without
 * the core naming a vendor.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { diag, type Diagnostic, type Span } from "../ast.ts";
import type { DecisionRequestFn } from "./interp.ts";
import { floatV, hashValue, intV, UNIT, type Value } from "./value.ts";

export type ReplayMode = "live" | "record" | "replay";

export interface DecisionRequest {
  /** The decision input, as an MM value. */
  readonly input: Value;
  /** Content hash of `input`; this is the log key. */
  readonly inputHash: string;
}

export interface DecisionOutcome {
  readonly value: Value;
  readonly confidence: number;
}

export interface DecisionProvider {
  readonly id: string;
  readonly model: string;
  decide(request: DecisionRequest): DecisionOutcome;
}

/** One recorded decision. Append-only: an existing key is never overwritten. */
export interface DecisionEntry {
  readonly inputHash: string;
  readonly provider: string;
  readonly model: string;
  readonly confidence: number;
  /** The decision's value, in the JSON codec below. */
  readonly value: Json;
}

const NO_SPAN: Span = { start: 0, end: 0, file: -1 };

// ---------------------------------------------------------------------------
// Value codec: the log is JSON, so decisions need a lossless textual form
// ---------------------------------------------------------------------------

export type Json =
  | { t: "int"; v: string }
  | { t: "float"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "char"; v: string }
  | { t: "text"; v: string }
  | { t: "unit" }
  | { t: "tuple"; v: Json[] }
  | { t: "record"; name: string | null; keys: string[]; v: Json[] }
  | { t: "variant"; name: string; type: string | null; v: Json }
  | { t: "array"; v: Json[] };

export function toJson(v: Value): Json {
  switch (v.k) {
    case "int": return { t: "int", v: v.v.toString() };
    // Floats keep their exact bit pattern, so `NaN` and `-0` survive a round trip.
    case "float": return { t: "float", v: v.v.toString() };
    case "bool": return { t: "bool", v: v.v };
    case "char": return { t: "char", v: v.v };
    case "text": return { t: "text", v: v.v };
    case "unit": return { t: "unit" };
    case "tuple": return { t: "tuple", v: v.elems.map(toJson) };
    case "record": {
      // Keys are sorted so two structurally equal records encode identically.
      const keys = Object.keys(v.fields).sort();
      return { t: "record", name: v.name, keys, v: keys.map((k) => toJson(v.fields[k]!)) };
    }
    case "variant": return { t: "variant", name: v.name, type: v.type, v: toJson(v.payload) };
    case "slice": return { t: "array", v: v.elems.map(toJson) };
    default:
      throw new Error(
        `decision value kind \`${v.k}\` cannot be recorded; it has no JSON form`,
      );
  }
}

export function fromJson(j: Json): Value {
  switch (j.t) {
    case "int": return intV(BigInt(j.v));
    case "float": return floatV(Number(j.v));
    case "bool": return { k: "bool", v: j.v };
    case "char": return { k: "char", v: j.v };
    case "text": return { k: "text", v: j.v };
    case "unit": return UNIT;
    case "tuple": return { k: "tuple", elems: j.v.map(fromJson) };
    case "variant": return { k: "variant", name: j.name, type: j.type, payload: fromJson(j.v) };
    case "array": return { k: "slice", elems: j.v.map(fromJson), len: j.v.length };
    case "record": {
      const fields: Record<string, Value> = {};
      j.keys.forEach((k, i) => { fields[k] = fromJson(j.v[i]!); });
      return { k: "record", name: j.name, fields };
    }
  }
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

export interface DecisionLogFile {
  readonly version: 1;
  readonly entries: DecisionEntry[];
}

/**
 * An append-only record of decisions, keyed by input content hash.
 *
 * Append-only is a hard invariant, not a convention: re-recording a hash that
 * already exists is reported rather than silently overwriting, because a replay
 * that disagrees with its own recording is the failure this whole module exists
 * to prevent.
 */
export class DecisionLog {
  /** Keyed by input hash — dynamic keys, so a `Map` rather than a `Record`. */
  readonly entries = new Map<string, DecisionEntry>();

  get size(): number {
    return this.entries.size;
  }

  has(inputHash: string): boolean {
    return this.entries.has(inputHash);
  }

  get(inputHash: string): DecisionEntry | undefined {
    return this.entries.get(inputHash);
  }

  /** Append a decision. Returns a diagnostic if the hash was already recorded. */
  append(entry: DecisionEntry, span: Span = NO_SPAN): Diagnostic[] {
    const existing = this.entries.get(entry.inputHash);
    if (existing) {
      return [diag("E0904", "decision_log_conflict",
        `input ${entry.inputHash} is already recorded (${existing.provider}/${existing.model})`,
        span, { data: { inputHash: entry.inputHash } })];
    }
    this.entries.set(entry.inputHash, entry);
    return [];
  }

  /** Replace the log contents, e.g. after loading a file. */
  loadAll(entries: readonly DecisionEntry[]): void {
    this.entries.clear();
    for (const e of entries) this.entries.set(e.inputHash, e);
  }

  /** Stable serialization: entries sorted by hash, so a re-record is byte-stable. */
  toFile(): DecisionLogFile {
    const entries = [...this.entries.values()].sort((a, b) =>
      a.inputHash < b.inputHash ? -1 : a.inputHash > b.inputHash ? 1 : 0);
    return { version: 1, entries };
  }
}

// ---------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------

export interface DeciderOptions {
  readonly mode: ReplayMode;
  readonly provider: DecisionProvider;
  /** Existing log. `replay` requires one; `record` appends to it. */
  readonly log?: DecisionLog;
  /** Where `record` mode writes on `flush`. */
  readonly path?: string;
  /**
   * Receives every diagnostic this decider produces, so the run that hit a replay miss
   * reports it too. Without this a failed replay looks like a successful run returning
   * `()` — exactly the silent nondeterminism the mode exists to prevent.
   */
  readonly onDiagnostic?: (d: Diagnostic) => void;
}

export interface Decider {
  /** Ready to hand to `Interp` as `RunOptions.decider`. */
  readonly request: DecisionRequestFn;
  readonly log: DecisionLog;
  readonly diagnostics: Diagnostic[];
  /** The file path in use, if any. */
  readonly path: string | undefined;
  /** Write the log to `path`. No-op when no path was configured. */
  flush(): void;
}

/**
 * Build the decision function the interpreter calls.
 *
 * In `replay` mode a miss is a hard error: the diagnostic is recorded and `()`
 * is returned, so the interpreter surfaces a failure instead of inventing an
 * answer. There is deliberately no code path from a replay miss to the provider.
 */
export function createDecider(opts: DeciderOptions): Decider {
  const log = opts.log ?? new DecisionLog();
  // Every diagnostic this decider produces is also handed to the run, so a replay miss
  // shows up in the run that hit it rather than only in the decider's own array.
  const diagnostics: Diagnostic[] = [];
  const report = (d: Diagnostic): void => {
    diagnostics.push(d);
    opts.onDiagnostic?.(d);
  };
  if (opts.mode === "replay" && log.size === 0) {
    report(diag("E0901", "missing_decision_record",
      "replay mode was given an empty decision log; there is nothing to replay",
      NO_SPAN));
  }

  const request: DecisionRequestFn = (input: Value, span: Span): Value => {
    const inputHash = hashValue(input);
    if (opts.mode === "replay") {
      const entry = log.get(inputHash);
      if (!entry) {
        report(diag("E0901", "missing_decision_record",
          `no recorded decision for input ${inputHash}; replay mode does not fall back to a live provider call`,
          span, { data: { inputHash } }));
        return UNIT;
      }
      return {
        k: "decision",
        value: fromJson(entry.value),
        confidence: entry.confidence,
        provider: entry.provider,
        model: entry.model,
        inputHash: entry.inputHash,
      };
    }

    const outcome = opts.provider.decide({ input, inputHash });
    if (opts.mode === "record") {
      diagnostics.push(...log.append({
        inputHash,
        provider: opts.provider.id,
        model: opts.provider.model,
        confidence: outcome.confidence,
        value: toJson(outcome.value),
      }, span));
    }
    return {
      k: "decision",
      value: outcome.value,
      confidence: outcome.confidence,
      provider: opts.provider.id,
      model: opts.provider.model,
      inputHash,
    };
  };

  return {
    request,
    log,
    diagnostics,
    path: opts.path,
    flush() {
      if (opts.path) writeDecisionLog(opts.path, log);
    },
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Read a log file. A missing or corrupt file is an empty log plus a diagnostic. */
export function readDecisionLog(path: string): { log: DecisionLog; diagnostics: Diagnostic[] } {
  const log = new DecisionLog();
  const diagnostics: Diagnostic[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    diagnostics.push(diag("E0901", "missing_decision_record",
      `decision log \`${path}\` could not be read; replay has nothing to return`,
      NO_SPAN, { data: { path } }));
    return { log, diagnostics };
  }
  let parsed: DecisionLogFile;
  try {
    parsed = JSON.parse(raw) as DecisionLogFile;
  } catch {
    diagnostics.push(diag("E0901", "corrupt_decision_record",
      `decision log \`${path}\` is not valid JSON`, NO_SPAN, { data: { path } }));
    return { log, diagnostics };
  }
  if (parsed.version !== 1) {
    diagnostics.push(diag("E0901", "corrupt_decision_record",
      `decision log \`${path}\` has version ${String(parsed.version)}, expected 1`,
      NO_SPAN, { data: { path, version: parsed.version } }));
    return { log, diagnostics };
  }
  log.loadAll(parsed.entries);
  return { log, diagnostics };
}

/** Write a log file. */
export function writeDecisionLog(path: string, log: DecisionLog): void {
  writeFileSync(path, `${JSON.stringify(log.toFile(), null, 2)}\n`, "utf8");
}

/** A provider built from a function. For tests, and for deterministic rules. */
export function fixedProvider(
  id: string, model: string, produce: (request: DecisionRequest) => DecisionOutcome,
): DecisionProvider {
  return { id, model, decide: produce };
}
