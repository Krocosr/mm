/**
 * MM — the builtin function universe.
 *
 * Effectful operations are *not* library code. They are compiler-known functions with
 * fixed effect rows, because an effect is a capability request and a capability request
 * must not be satisfiable by a user module that happens to define a function with the
 * right name. Registering them here means:
 *
 *   - `fs.open` always costs `fs.read` + `fs.close`, whatever the user wrote;
 *   - the System IR can enumerate the program's full authority surface;
 *   - a user cannot shadow a capability away, since resolution finds the builtin first.
 *
 * Pure builtins (arithmetic, text, collections) carry no authority, so they get no effect
 * row and no policy — but they are still declared here, because this table is also the
 * signature registry the checker resolves calls against. They live in the interpreter
 * prelude for their *implementation*; their *types* have to be here too, or a call to
 * working code is refused with `E0203 unknown_function`.
 *
 * See docs/spec/kernel.md §4, §6.4.
 */

import type { Ownership } from "./ast.ts";
import type { Ty } from "./types.ts";
import { BUILTIN, TY_ERR } from "./types.ts";

export interface BuiltinFn {
  /** Dotted name as written in source, e.g. `fs.open`. */
  readonly name: string;
  readonly params: readonly string[];
  /** Result type in mini-notation, see `resolveMiniType`. */
  readonly ret: string;
  /** The effects this operation requires. This is the capability request. */
  readonly effects: readonly string[];
  /** Free-form description surfaced in `mm.system` and semantic packets. */
  readonly doc: string;
}

const TEXT: string = "Text";
const BYTES: string = "Bytes";

export const BUILTIN_FNS: readonly BuiltinFn[] = [
  // -- filesystem --------------------------------------------------------
  {
    name: "fs.open", params: ["Path"], ret: `Result<${TEXT},IoErr>`,
    effects: ["fs.read", "fs.close"], doc: "open a file for reading; the result is an owned resource",
  },
  {
    name: "fs.open_write", params: ["Path"], ret: `Result<${TEXT},IoErr>`,
    effects: ["fs.write", "fs.close"], doc: "create or truncate a file; the result is an owned resource",
  },
  {
    name: "fs.read", params: ["Path"], ret: `Result<${BYTES},IoErr>`,
    effects: ["fs.read"], doc: "read an entire file",
  },
  {
    name: "fs.write", params: ["Path", BYTES], ret: `Result<usize,IoErr>`,
    effects: ["fs.write"], doc: "write a file, replacing its contents",
  },
  {
    // Takes a file handle, not a path: this is the close a `@resource(close = fs.close)`
    // type names, so its parameter is the contract the drop path is checked against.
    name: "fs.close", params: ["Handle<Fd>"], ret: "Result<Unit,IoErr>",
    effects: ["fs.close"], doc: "close a resource explicitly; drop does this otherwise",
  },
  {
    name: "fs.exists", params: ["Path"], ret: "bool",
    effects: ["fs.read"], doc: "test for a file's existence",
  },
  {
    name: "fs.read_all", params: [TEXT], ret: `Result<${BYTES},IoErr>`,
    effects: ["fs.read"], doc: "read a whole open resource",
  },

  // -- network -----------------------------------------------------------
  {
    name: "net.get", params: [TEXT], ret: `Result<${BYTES},NetErr>`,
    effects: ["net"], doc: "HTTP GET; the target must appear in the granted network allowlist",
  },
  {
    name: "net.post", params: [TEXT, BYTES], ret: `Result<${BYTES},NetErr>`,
    effects: ["net", "net.tls"], doc: "HTTP POST over TLS",
  },

  // -- process / os ------------------------------------------------------
  {
    name: "proc.exec", params: [TEXT, "[Text]"], ret: `Result<i32,IoErr>`,
    effects: ["proc", "proc.exec"], doc: "run a program; the executable must be on the grant list",
  },
  {
    name: "os.mmap", params: ["Fd", "usize"], ret: "Result<Handle<u8>,IoErr>",
    effects: ["os.vm", "unsafe"], doc: "map a page range; requires an unsafe caller",
  },
  {
    name: "clock.now", params: [], ret: "u64",
    effects: ["clock"], doc: "monotonic nanosecond clock",
  },
  {
    name: "random.bytes", params: ["usize"], ret: BYTES,
    effects: ["random"], doc: "cryptographic random bytes",
  },
  {
    name: "env.get", params: [TEXT], ret: `Result<${TEXT},IoErr>`,
    effects: ["env"], doc: "read an environment variable",
  },
  {
    name: "secret.read", params: [TEXT], ret: `Result<${BYTES},IoErr>`,
    effects: ["secret.read"], doc: "fetch a secret from the credential broker; the value is redacted everywhere",
  },

  // -- agent -------------------------------------------------------------
  {
    name: "agent.decide", params: [TEXT], ret: `Result<Decision<Text>,NetErr>`,
    effects: ["agent", "nondet"], doc: "ask the decision provider; the result is typed but untrusted",
  },
  {
    name: "agent.stream", params: [TEXT], ret: `Result<Stream<Text>,NetErr>`,
    effects: ["agent", "nondet"], doc: "open a token stream from the provider",
  },

  // -- ownership (kernel.md §3.4) -----------------------------------------
  {
    name: "shared_new", params: ["T"], ret: "shared T",
    effects: [], doc: "wrap a value in a fresh reference-counted `shared` handle",
  },
  {
    name: "shared_clone", params: ["T"], ret: "T",
    effects: [], doc: "clone a `shared` handle; increments the reference count",
  },
  {
    name: "arena_new", params: ["T"], ret: "arena T",
    effects: [], doc: "allocate a value into the enclosing region",
  },
  {
    name: "handle_of", params: ["T"], ret: "handle T",
    effects: [], doc: "convert an arena value into a checked generational handle",
  },

];

/**
 * Pure builtins: implemented in the interpreter prelude, carrying no authority.
 *
 * They are a *separate* table from `BUILTIN_FNS` because the two have opposite shadowing
 * rules. A capability builtin must win over a user function — otherwise a program could
 * define `fn open(..)` and shed the effect it was going to request, which is the whole
 * point of registering them. A pure builtin is just a function, so a user function of the
 * same name must win, exactly as it does at run time: `evalCall` resolves the user
 * function *before* falling back to a builtin.
 *
 * Having them in the wrong table, or checked in the wrong order, produces a false
 * rejection either way — declaring `sum` here and checking builtins first made a program's
 * own `fn sum(xs: view [f32])` fail to resolve against its own call sites.
 *
 * `T` binds to the first argument's type. A function whose result depends on the *element*
 * type of a slice argument cannot be expressed in this notation, because `T` is already
 * bound to the whole slice; such a builtin must take a concrete element type.
 */
export const PURE_BUILTIN_FNS: readonly BuiltinFn[] = [
  {
    name: "abs", params: ["T"], ret: "T",
    effects: [], doc: "absolute value; preserves the argument's numeric type",
  },
  {
    name: "min", params: ["T", "T"], ret: "T",
    effects: [], doc: "the smaller of two values of the same numeric type",
  },
  {
    name: "max", params: ["T", "T"], ret: "T",
    effects: [], doc: "the larger of two values of the same numeric type",
  },
  {
    name: "clamp", params: ["T", "T", "T"], ret: "T",
    effects: [], doc: "constrain a value to a closed range",
  },
  {
    // The prelude's `**` works on any integer width, so a narrower signature than `T`
    // would reject `pow(u32, 2)` — which the interpreter runs.
    name: "pow", params: ["T", "T"], ret: "T",
    effects: [], doc: "integer exponentiation",
  },
  {
    name: "sqrt", params: ["f64"], ret: "f64",
    effects: [], doc: "square root; always floating point, as the runtime computes it",
  },
  // Associated constructors. `evalCall` rewrites `Owner::member` to `owner_member`
  // before consulting the prelude, so these are reachable as written — but the checker
  // had no route to them, and a corpus program writing `Handle::at(i, g)` was refused.
  {
    name: "Handle::at", params: ["usize", "u32"], ret: "handle T",
    effects: [], doc: "a generational handle naming a slot and the generation it had",
  },
  {
    name: "Handle::none", params: [], ret: "T",
    effects: [], doc: "the null handle",
  },
  {
    name: "Map::new", params: [], ret: "T",
    effects: [], doc: "an empty map",
  },
  {
    name: "Set::new", params: [], ret: "T",
    effects: [], doc: "an empty set",
  },
  {
    name: "assert", params: ["bool"], ret: "Unit",
    effects: [], doc: "fail the run unless the condition holds",
  },
  {
    name: "assert_eq", params: ["T", "T"], ret: "Unit",
    effects: [], doc: "fail the run unless the two values are equal",
  },
];

export function pureBuiltinFnId(name: string): number {
  const i = PURE_BUILTIN_FNS.findIndex((f) => f.name === name);
  if (i < 0) return Number.MIN_SAFE_INTEGER;
  return PURE_BUILTIN_FN_BASE - i;
}

export function pureBuiltinFnById(id: number): BuiltinFn | null {
  if (id > PURE_BUILTIN_FN_BASE) return null;
  return PURE_BUILTIN_FNS[PURE_BUILTIN_FN_BASE - id] ?? null;
}

/**
 * Ids for builtin functions live in their own negative block, below the builtin *types*.
 * They are stable across runs; the semantic graph hashes them by name.
 */
export const BUILTIN_FN_BASE = -1000;

/** Ids for the pure table, below the authority block so the two never collide. */
export const PURE_BUILTIN_FN_BASE = BUILTIN_FN_BASE - 1000;

export function builtinFnId(name: string): number {
  const i = BUILTIN_FNS.findIndex((f) => f.name === name);
  if (i < 0) return Number.MIN_SAFE_INTEGER;
  return BUILTIN_FN_BASE - i;
}

export function builtinFnById(id: number): BuiltinFn | null {
  if (id > BUILTIN_FN_BASE) return null;
  return BUILTIN_FNS[BUILTIN_FN_BASE - id] ?? null;
}

/**
 * The id for a name in either table, authority block first.
 *
 * `checkBuiltinCall` records the callee id in the call facts and now serves both tables,
 * so it recovers the id from a definition rather than carrying it in.
 */
export function anyBuiltinFnId(name: string): number {
  const authority = builtinFnId(name);
  return authority !== Number.MIN_SAFE_INTEGER ? authority : pureBuiltinFnId(name);
}

/** Resolve the mini-notation used in `BuiltinFn.ret` against the builtin type universe. */
export function resolveMiniType(mini: string, args: readonly Ty[] = []): Ty {
  let s = mini.trim();
  if (s.endsWith("?")) return { k: "option", inner: resolveMiniType(s.slice(0, -1), args) };
  if (s === "Unit") return { k: "record", fields: [] };
  // `[T]` is a slice. Without this it fell through to the error type, so a builtin with a
  // slice parameter — `proc.exec`'s `[Text]` — silently accepted any argument, because
  // unification against an error type always succeeds.
  const bracket = /^\[(.+)\]$/.exec(s);
  if (bracket) return { k: "slice", elem: resolveMiniType(bracket[1]!, args) };
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\s*<(.+)>$/.exec(s);
  if (call) {
    const name = call[1]!;
    const parts = splitArgs(call[2]!).map((p) => resolveMiniType(p, args));
    // `Result<Ok, Err>` is structural, not a named node: `?` propagation and the
    // `Ok`/`Err` patterns both match on `k: "result"`, so a builtin that returns one
    // must produce the same shape the source-level `Result<T, E>` does.
    // `Result<Ok, Err>` is structural, not a named node: `?` propagation and the
    // `Ok`/`Err` patterns both match on `k: "result"`, so a builtin that returns one
    // must produce the same shape the source-level `Result<T, E>` does.
    if (name === "Result") {
      return { k: "result", ok: parts[0] ?? TY_ERR, err: parts[1] ?? TY_ERR };
    }
    // Likewise `Handle<T>` is the `handle` discipline applied to `T`, exactly as it is
    // in source. Resolving it as a named type here made a builtin's `Handle<T>` parameter
    // fail to match a source-level `Handle<T>`, which is the whole `@resource` contract.
    if (name === "Handle") {
      return { k: "own", ownership: "handle", inner: parts[0] ?? TY_ERR };
    }
    const def = TYPE_BY_NAME[name];
    if (def === undefined) return { k: "err" };
    return { k: "named", def, args: parts };
  }
  if (s === "T") return args[0] ?? { k: "err" };
  // Ownership wrappers, so a builtin can say `shared T` / `arena T` and the ownership
  // pass sees the discipline the source asked for rather than a bare value.
  const owned = /^(view|viewmut|shared|arena|handle)(?:\s+(mut))?\s+(.+)$/.exec(s);
  if (owned) {
    const discipline: Ownership = owned[2] === "mut" ? "viewmut" : (owned[1] as Ownership);
    return { k: "own", ownership: discipline, inner: resolveMiniType(owned[3]!, args) };
  }
  const def = TYPE_BY_NAME[s];
  if (def !== undefined) return { k: "named", def, args: [] };
  if (s === "i32") return { k: "prim", name: "i32" };
  if (s === "i64") return { k: "prim", name: "i64" };
  if (s === "u64") return { k: "prim", name: "u64" };
  if (s === "usize") return { k: "prim", name: "usize" };
  if (s === "f64") return { k: "prim", name: "f64" };
  if (s === "bool") return { k: "prim", name: "bool" };
  if (s === "char") return { k: "prim", name: "char" };
  if (s === "Fd") return { k: "prim", name: "Fd" };
  if (s === "Path") return { k: "prim", name: "Path" };
  if (s === "Handle<u8>") return { k: "named", def: BUILTIN.Handle, args: [{ k: "prim", name: "u8" }] };
  return { k: "err" };
}

const TYPE_BY_NAME: Record<string, number> = {
  Result: BUILTIN.Result,
  Opt: BUILTIN.Opt,
  Map: BUILTIN.Map,
  Set: BUILTIN.Set,
  Decision: BUILTIN.Decision,
  Untrusted: BUILTIN.Untrusted,
  Verified: BUILTIN.Verified,
  Cap: BUILTIN.Cap,
  Stream: BUILTIN.Stream,
  Context: BUILTIN.Context,
  Handle: BUILTIN.Handle,
  Bytes: BUILTIN.Bytes_,
  Text: BUILTIN.Text_,
  Ticket: BUILTIN.Ticket,
  IoErr: BUILTIN.IoErr,
  NetErr: BUILTIN.NetErr,
  ProviderId: BUILTIN.ProviderId,
  ModelId: BUILTIN.ModelId,
};

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    if (ch === ">" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
