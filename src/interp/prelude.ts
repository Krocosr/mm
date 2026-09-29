/**
 * MM — the builtin function surface.
 *
 * Everything here is **pure**. There is deliberately no `fs.*`, `net.*`, `proc.*`,
 * `clock`, `random` or `env` implementation: those need a capability grant, and a
 * stub returning a fabricated success would be a lie the agent then debugs for an
 * hour. A call to one of them reports a diagnostic naming the missing capability.
 */

import { diag, type Diagnostic, type Span } from "../ast.ts";
import type { BuiltinContext, BuiltinFn, Value } from "./value.ts";
import { deref, floatV, intV, isResourceValue, mapKey, sliceV, UNIT, valueEq } from "./value.ts";

// ---------------------------------------------------------------------------
// Capability errors
// ---------------------------------------------------------------------------

/**
 * Names that exist in the language surface but need a capability grant. Calling
 * one is an error naming the capability, not a simulated success.
 */
export const CAPABILITY_GATED: Record<string, string> = {
  open: "fs.read",
  read_file: "fs.read",
  write_file: "fs.write",
  read: "fs.read",
  write: "fs.write",
  close: "fs.close",
  net_connect: "net",
  http_get: "net",
  http_post: "net",
  exec: "proc.exec",
  command: "proc.exec",
  now: "clock",
  sleep: "clock",
  random: "random",
  env_get: "env",
  read_secret: "secret.read",
  decide: "agent",
  ask: "agent",
};

export function capabilityDiagnostic(name: string, span: Span): Diagnostic {
  const cap = CAPABILITY_GATED[name] ?? "unknown";
  return diag("E0503", "missing_capability",
    `\`${name}\` requires the \`${cap}\` capability, which this build does not grant`,
    span, { data: { capability: cap, builtin: name } });
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** A bad-argument abort from inside a builtin. Converted to a diagnostic on the way out. */
export class ArgError extends Error {
  constructor(
    readonly code: string,
    readonly kind: string,
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = "ArgError";
  }
}

function badArg(span: Span, message: string): never {
  throw new ArgError("E0190", "bad_argument", message, span);
}

function wantInt(ctx: BuiltinContext, args: Value[], i: number, span: Span): bigint {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || !a || a.k !== "int") badArg(span, `argument ${i + 1} must be an integer`);
  return a.v;
}

function wantFloat(ctx: BuiltinContext, args: Value[], i: number, span: Span): number {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || !a) badArg(span, `argument ${i + 1} is missing`);
  if (a.k === "float") return a.v;
  if (a.k === "int") return Number(a.v);
  badArg(span, `argument ${i + 1} must be a number`);
}

// Every `want*` accessor derefs its argument. A `view T` parameter reaches a builtin
// still wrapped in its view, so an accessor that skipped `deref` rejected values that
// were plainly the right type — `view Bytes` failed every Bytes method.
function wantText(ctx: BuiltinContext, args: Value[], i: number, span: Span): string {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || !a || a.k !== "text") badArg(span, `argument ${i + 1} must be Text`);
  return a.v;
}

function wantBytes(ctx: BuiltinContext, args: Value[], i: number, span: Span): Uint8Array {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || !a || a.k !== "bytes") badArg(span, `argument ${i + 1} must be Bytes`);
  return a.v;
}

function wantSlice(ctx: BuiltinContext, args: Value[], i: number, span: Span): Value[] {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || !a) badArg(span, `argument ${i + 1} is missing`);
  if (a.k === "slice") return a.elems;
  if (a.k === "text") return [...a.v].map((c) => ({ k: "text", v: c } satisfies Value));
  badArg(span, `argument ${i + 1} must be a slice`);
}

function wantMap(ctx: BuiltinContext, args: Value[], i: number, span: Span) {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || a?.k !== "map") badArg(span, `argument ${i + 1} must be a Map`);
  return a;
}

function wantSet(ctx: BuiltinContext, args: Value[], i: number, span: Span) {
  const a = args[i] === undefined ? undefined : deref(args[i]);
  if (!ctx.tick() || a?.k !== "set") badArg(span, `argument ${i + 1} must be a Set`);
  return a;
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

const fns: Record<string, BuiltinFn> = {
  // -- receiver methods -----------------------------------------------------
  //
  // A method call `xs.len()` is dispatched as `<receiverTag>_<name>`, so the surface a
  // type actually has lives under its own namespace. These are the shapes every real
  // program reaches for first; anything not here is a diagnostic, never a silent zero.
  slice_len: (ctx, args, span) => intV(BigInt(wantSlice(ctx, args, 0, span).length)),
  slice_is_empty: (ctx, args, span) => ({ k: "bool", v: wantSlice(ctx, args, 0, span).length === 0 }),
  slice_get: (ctx, args, span) => {
    const elems = wantSlice(ctx, args, 0, span);
    const i = Number(wantInt(ctx, args, 1, span));
    const v = elems[i];
    return v ?? { k: "variant", name: "None", type: "Opt", payload: UNIT };
  },
  slice_push: (ctx, args, span) => {
    const elems = wantSlice(ctx, args, 0, span);
    const v = args[1];
    if (v === undefined) badArg(span, "slice_push needs a value");
    elems.push(deref(v));
    return UNIT;
  },
  array_len: (ctx, args, span) => intV(BigInt(wantSlice(ctx, args, 0, span).length)),
  array_get: (ctx, args, span) => {
    const elems = wantSlice(ctx, args, 0, span);
    const i = Number(wantInt(ctx, args, 1, span));
    return elems[i] ?? { k: "variant", name: "None", type: "Opt", payload: UNIT };
  },
  text_as_bytes: (ctx, args, span) => {
    const s = wantText(ctx, args, 0, span);
    return { k: "bytes", v: new TextEncoder().encode(s) };
  },
  text_chars: (ctx, args, span) => {
    const s = wantText(ctx, args, 0, span);
    return sliceV([...s].map((c) => ({ k: "text", v: c } satisfies Value)));
  },
  text_starts_with: (ctx, args, span) => ({
    k: "bool",
    v: wantText(ctx, args, 0, span).startsWith(wantText(ctx, args, 1, span)),
  }),
  // Generational handles need a way to *make* one before a store slot exists: a "null"
  // handle for the empty case, and a direct (index, generation) handle for callers that
  // manage their own pool. `handle_alloc` remains the ordinary path.
  // Named `handle_none` so that the associated constructor `Handle::none` resolves:
  // the call path lowercases the owner and member into `<owner>_<member>`.
  handle_none: (ctx) => {
    if (!ctx.tick()) return UNIT;
    return { k: "handle", store: -1, index: -1, generation: 0 };
  },
  handle_at: (ctx, args, span) => {
    const i = wantInt(ctx, args, 0, span);
    const g = wantInt(ctx, args, 1, span);
    return { k: "handle", store: -1, index: Number(i), generation: Number(g) };
  },
  text_ends_with: (ctx, args, span) => ({
    k: "bool",
    v: wantText(ctx, args, 0, span).endsWith(wantText(ctx, args, 1, span)),
  }),
  set_len: (ctx, args, span) => intV(BigInt(wantSet(ctx, args, 0, span).entries.size)),
  set_contains: (ctx, args, span) => {
    const s = wantSet(ctx, args, 0, span);
    const key = args[1];
    if (!key) badArg(span, "set_contains needs a value");
    return { k: "bool", v: s.entries.has(mapKey(key)) };
  },
  handle_is_null: (ctx, args, span) => {
    const h = deref(args[0] as Value);
    if (!ctx.tick() || h?.k !== "handle") badArg(span, "handle_is_null expects a handle");
    return { k: "bool", v: h.index < 0 };
  },
  handle_is_live: (ctx, args, span) => {
    const h = deref(args[0] as Value);
    if (!ctx.tick() || h?.k !== "handle") badArg(span, "handle_is_live expects a handle");
    const slot = ctx.stores.get(h.store)?.slots[h.index];
    return { k: "bool", v: slot !== undefined && slot.alive && slot.generation === h.generation };
  },
  handle_index: (ctx, args, span) => {
    const h = deref(args[0] as Value);
    if (!ctx.tick() || h?.k !== "handle") badArg(span, "handle_index expects a handle");
    return intV(BigInt(h.index));
  },
  handle_generation: (ctx, args, span) => {
    const h = deref(args[0] as Value);
    if (!ctx.tick() || h?.k !== "handle") badArg(span, "handle_generation expects a handle");
    return intV(BigInt(h.generation));
  },
  resource_is_open: (ctx, args, span) => {
    const r = deref(args[0] as Value);
    if (!ctx.tick() || r?.k !== "resource") badArg(span, "is_open expects a resource");
    return { k: "bool", v: !r.closed };
  },
  // -- arithmetic / comparison helpers ---------------------------------------
  abs: (ctx, args, span) => {
    const a = args[0];
    if (a?.k === "float") return floatV(Math.abs(a.v));
    return intV(-wantInt(ctx, args, 0, span));
  },
  min: (ctx, args, span) => {
    if (args[0]?.k === "float" || args[1]?.k === "float") {
      return floatV(Math.min(wantFloat(ctx, args, 0, span), wantFloat(ctx, args, 1, span)));
    }
    const a = wantInt(ctx, args, 0, span);
    const b = wantInt(ctx, args, 1, span);
    return intV(a < b ? a : b);
  },
  max: (ctx, args, span) => {
    if (args[0]?.k === "float" || args[1]?.k === "float") {
      return floatV(Math.max(wantFloat(ctx, args, 0, span), wantFloat(ctx, args, 1, span)));
    }
    const a = wantInt(ctx, args, 0, span);
    const b = wantInt(ctx, args, 1, span);
    return intV(a > b ? a : b);
  },
  clamp: (ctx, args, span) => {
    if (args.some((a) => a?.k === "float")) {
      const x = wantFloat(ctx, args, 0, span);
      const lo = wantFloat(ctx, args, 1, span);
      const hi = wantFloat(ctx, args, 2, span);
      return floatV(x < lo ? lo : x > hi ? hi : x);
    }
    const x = wantInt(ctx, args, 0, span);
    const lo = wantInt(ctx, args, 1, span);
    const hi = wantInt(ctx, args, 2, span);
    return intV(x < lo ? lo : x > hi ? hi : x);
  },
  pow: (ctx, args, span) =>
    intV(wantInt(ctx, args, 0, span) ** wantInt(ctx, args, 1, span)),
  sqrt: (ctx, args, span) => floatV(Math.sqrt(wantFloat(ctx, args, 0, span))),
  sum: (ctx, args, span) => {
    const elems = wantSlice(ctx, args, 0, span);
    let anyFloat = false;
    let accFloat = 0;
    let accInt = 0n;
    for (const e of elems) {
      if (!ctx.tick()) return anyFloat ? floatV(accFloat) : intV(accInt);
      if (e.k === "float") { anyFloat = true; accFloat += e.v; }
      else if (e.k === "int") { accInt += e.v; accFloat += Number(e.v); }
      else badArg(span, `sum over \`${e.k}\` is not defined`);
    }
    return anyFloat ? floatV(accFloat) : intV(accInt);
  },
  len: (ctx, args, span) => {
    const a = args[0];
    if (!ctx.tick() || !a) badArg(span, "len of nothing");
    switch (a.k) {
      case "slice": return intV(BigInt(a.len));
      case "text": case "bytes": return intV(BigInt(a.v.length));
      case "map": return intV(BigInt(a.entries.size));
      case "set": return intV(BigInt(a.entries.size));
      case "tuple": return intV(BigInt(a.elems.length));
      case "record": return intV(BigInt(Object.keys(a.fields).length));
      default: return intV(1n);
    }
  },

  // -- assertions (tests) ----------------------------------------------------
  assert: (ctx, args, span) => {
    const a = args[0];
    if (!ctx.tick() || a?.k !== "bool" || !a.v) {
      ctx.report(diag("E0191", "assertion_failed", "assertion failed", span));
    }
    return UNIT;
  },
  assert_eq: (ctx, args, span) => {
    const [a, b] = args;
    if (!ctx.tick() || !a || !b || !valueEq(a, b)) {
      ctx.report(diag("E0191", "assertion_failed",
        `assert_eq failed: left is ${describe(a)}, right is ${describe(b)}`, span));
    }
    return UNIT;
  },
  assert_ne: (ctx, args, span) => {
    const [a, b] = args;
    if (!ctx.tick() || !a || !b || valueEq(a, b)) {
      ctx.report(diag("E0191", "assertion_failed",
        `assert_ne failed: both sides are ${describe(a)}`, span));
    }
    return UNIT;
  },

  // -- Text ------------------------------------------------------------------
  text_len: (ctx, args, span) => intV(BigInt(wantText(ctx, args, 0, span).length)),
  text_slice: (ctx, args, span) => {
    const s = wantText(ctx, args, 0, span);
    const from = Number(wantInt(ctx, args, 1, span));
    const to = args[2] === undefined ? s.length : Number(wantInt(ctx, args, 2, span));
    if (from < 0 || to > s.length || from > to) {
      ctx.report(diag("E0193", "slice_out_of_range",
        `text_slice(${from}, ${to}) is outside a string of length ${s.length}`, span));
      return { k: "text", v: "" };
    }
    return { k: "text", v: s.slice(from, to) };
  },
  text_concat: (ctx, args, span) => {
    let out = "";
    for (let i = 0; i < args.length; i++) out += wantText(ctx, args, i, span);
    return { k: "text", v: out };
  },
  text_eq: (ctx, args, span) =>
    ({ k: "bool", v: wantText(ctx, args, 0, span) === wantText(ctx, args, 1, span) }),
  text_upper: (ctx, args, span) => ({ k: "text", v: wantText(ctx, args, 0, span).toUpperCase() }),
  text_lower: (ctx, args, span) => ({ k: "text", v: wantText(ctx, args, 0, span).toLowerCase() }),
  text_contains: (ctx, args, span) =>
    ({ k: "bool", v: wantText(ctx, args, 0, span).includes(wantText(ctx, args, 1, span)) }),
  text_bytes: (ctx, args, span) =>
    ({ k: "bytes", v: new TextEncoder().encode(wantText(ctx, args, 0, span)) }),

  // -- Bytes -----------------------------------------------------------------
  bytes_len: (ctx, args, span) => intV(BigInt(wantBytes(ctx, args, 0, span).length)),
  bytes_get: (ctx, args, span) => {
    const b = wantBytes(ctx, args, 0, span);
    const i = Number(wantInt(ctx, args, 1, span));
    if (i < 0 || i >= b.length) {
      ctx.report(diag("E0193", "index_out_of_range",
        `bytes_get(${i}) is outside a buffer of length ${b.length}`, span));
      return intV(0n);
    }
    return intV(BigInt(b[i]!));
  },
  bytes_set: (ctx, args, span) => {
    const b = wantBytes(ctx, args, 0, span);
    const i = Number(wantInt(ctx, args, 1, span));
    const v = Number(wantInt(ctx, args, 2, span));
    if (i < 0 || i >= b.length) {
      ctx.report(diag("E0193", "index_out_of_range",
        `bytes_set(${i}) is outside a buffer of length ${b.length}`, span));
      return UNIT;
    }
    b[i] = v & 0xff;
    return UNIT;
  },
  bytes_concat: (ctx, args, span) => {
    let total = 0;
    for (let i = 0; i < args.length; i++) total += wantBytes(ctx, args, i, span).length;
    const out = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < args.length; i++) {
      const p = wantBytes(ctx, args, i, span);
      out.set(p, at);
      at += p.length;
    }
    return { k: "bytes", v: out };
  },
  bytes_slice: (ctx, args, span) => {
    const b = wantBytes(ctx, args, 0, span);
    const from = Number(wantInt(ctx, args, 1, span));
    const to = args[2] === undefined ? b.length : Number(wantInt(ctx, args, 2, span));
    if (from < 0 || to > b.length || from > to) {
      ctx.report(diag("E0193", "slice_out_of_range",
        `bytes_slice(${from}, ${to}) is outside a buffer of length ${b.length}`, span));
      return { k: "bytes", v: new Uint8Array(0) };
    }
    return { k: "bytes", v: b.slice(from, to) };
  },
  bytes_eq: (ctx, args, span) => {
    const a = wantBytes(ctx, args, 0, span);
    const b = wantBytes(ctx, args, 1, span);
    return { k: "bool", v: a.length === b.length && a.every((x, i) => x === b[i]) };
  },

  // -- Map / Set -------------------------------------------------------------
  map_new: (ctx) => {
    if (!ctx.tick()) return UNIT;
    return { k: "map", entries: new Map() };
  },
  map_insert: (ctx, args, span) => {
    const m = wantMap(ctx, args, 0, span);
    const key = args[1];
    const val = args[2];
    if (!key || !val) badArg(span, "map_insert needs a key and a value");
    m.entries.set(mapKey(key), { key, val });
    return UNIT;
  },
  // `get` is total: a missing key reads as the value type's zero. That is deliberate, not
  // a shortcut — a `Map<K, V>` here is a counter or an adjacency list, where "absent" and
  // "zero" are the same thing, and forcing every read through an `Opt` turns ordinary
  // counting into noise. `get_opt` is there when the difference is real.
  map_get: (ctx, args, span) => {
    const m = wantMap(ctx, args, 0, span);
    const key = args[1];
    if (!key) badArg(span, "map_get needs a key");
    return m.entries.get(mapKey(key))?.val ?? zeroValue(m);
  },
  map_get_opt: (ctx, args, span) => {
    const m = wantMap(ctx, args, 0, span);
    const key = args[1];
    if (!key) badArg(span, "map_get_opt needs a key");
    return m.entries.get(mapKey(key))?.val
      ?? { k: "variant", name: "None", type: "Opt", payload: UNIT };
  },
  map_has: (ctx, args, span) => {
    const m = wantMap(ctx, args, 0, span);
    const key = args[1];
    if (!key) badArg(span, "map_has needs a key");
    return { k: "bool", v: m.entries.has(mapKey(key)) };
  },
  map_remove: (ctx, args, span) => {
    const m = wantMap(ctx, args, 0, span);
    const key = args[1];
    if (!key) badArg(span, "map_remove needs a key");
    m.entries.delete(mapKey(key));
    return UNIT;
  },
  map_keys: (ctx, args, span) => {
    const m = wantMap(ctx, args, 0, span);
    const elems = [...m.entries.values()].map((e) => e.key);
    return sliceV(elems);
  },
  set_new: (ctx) => {
    if (!ctx.tick()) return UNIT;
    return { k: "set", entries: new Map() };
  },
  set_insert: (ctx, args, span) => {
    const s = wantSet(ctx, args, 0, span);
    const v = args[1];
    if (!v) badArg(span, "set_insert needs a value");
    s.entries.set(mapKey(v), v);
    return UNIT;
  },
  set_has: (ctx, args, span) => {
    const s = wantSet(ctx, args, 0, span);
    const v = args[1];
    if (!v) badArg(span, "set_has needs a value");
    return { k: "bool", v: s.entries.has(mapKey(v)) };
  },
  set_remove: (ctx, args, span) => {
    const s = wantSet(ctx, args, 0, span);
    const v = args[1];
    if (!v) badArg(span, "set_remove needs a value");
    s.entries.delete(mapKey(v));
    return UNIT;
  },
  set_values: (ctx, args, span) => {
    const s = wantSet(ctx, args, 0, span);
    return sliceV([...s.entries.values()]);
  },

  // -- ownership runtime -----------------------------------------------------
  /** Wrap a value in a fresh `shared` with one reference (R-Own-6). */
  shared_new: (ctx, args, span) => {
    const v = args[0];
    if (!ctx.tick() || !v) badArg(span, "shared_new(value)");
    const id = ctx.nextSharedId();
    ctx.shareds.set(id, { id, rc: 1, atomic: false, value: v });
    return { k: "shared", id, value: v, rc: 1, atomic: false };
  },
  shared_clone: (ctx, args, span) => {
    const a = args[0];
    if (!ctx.tick() || a?.k !== "shared") badArg(span, "shared_clone expects a shared value");
    ctx.retain(a);
    return { k: "shared", id: a.id, value: a.value, rc: a.rc, atomic: a.atomic };
  },
  shared_rc: (ctx, args, span) => {
    const a = args[0];
    if (!ctx.tick() || a?.k !== "shared") badArg(span, "shared_rc expects a shared value");
    // Read the store, not the handle's cached copy: two handles to one shared
    // must not report stale counts.
    return intV(BigInt(ctx.shareds.get(a.id)?.rc ?? a.rc));
  },
  /** Move a `shared` into a host container — the only way to leak one from source. */
  shared_escape: (ctx, args, span) => {
    const a = args[0];
    if (!ctx.tick() || a?.k !== "shared") badArg(span, "shared_escape expects a shared value");
    ctx.escape(a);
    return UNIT;
  },
  arena_new: (ctx) => intV(BigInt(ctx.nextArena().id)),
  arena_alloc: (ctx, args, span) => {
    const id = Number(wantInt(ctx, args, 0, span));
    const arena = ctx.arenas.get(id);
    const v = args[1];
    if (!arena || !v) badArg(span, "arena_alloc(arena, value)");
    if (!arena.alive) {
      ctx.report(diag("E0415", "arena_escape",
        `arena ${id} has been destroyed; allocation into it is invalid`, span));
      return UNIT;
    }
    arena.elems.push(v);
    return { k: "arena", arena: id, index: arena.elems.length - 1, generation: arena.generation };
  },
  arena_load: (ctx, args, span) => {
    const a = args[0];
    if (!ctx.tick() || a?.k !== "arena") badArg(span, "arena_load expects an arena reference");
    const arena = ctx.arenas.get(a.arena);
    // R-Own-7: an arena reference never outlives its arena.
    if (!arena || !arena.alive || arena.generation !== a.generation) {
      ctx.report(diag("E0415", "arena_escape",
        `arena ${a.arena} has been destroyed; reference ${a.arena}.${a.index} is dangling`, span));
      return UNIT;
    }
    const v = arena.elems[a.index];
    if (v === undefined) {
      ctx.report(diag("E0193", "index_out_of_range",
        `arena ${a.arena} has no element at index ${a.index}`, span));
      return UNIT;
    }
    return v;
  },
  arena_destroy: (ctx, args, span) => {
    const id = Number(wantInt(ctx, args, 0, span));
    const arena = ctx.arenas.get(id);
    if (!arena) badArg(span, `arena ${id} does not exist`);
    if (!arena.alive) {
      ctx.report(diag("E0417", "double_free", `arena ${id} is already destroyed`, span));
      return UNIT;
    }
    arena.alive = false;
    arena.generation += 1;
    arena.elems = [];
    return UNIT;
  },
  handle_store: (ctx) => intV(BigInt(ctx.nextStore().id)),
  handle_alloc: (ctx, args, span) => {
    const id = Number(wantInt(ctx, args, 0, span));
    const store = ctx.stores.get(id);
    const v = args[1];
    if (!store || !v) badArg(span, "handle_alloc(store, value)");
    let index: number;
    if (store.free.length > 0) {
      index = store.free.shift()!;
      // Reuse bumps the generation, which is exactly how a stale handle is caught.
      const reused = store.slots[index]!;
      reused.generation += 1;
      reused.value = v;
      reused.alive = true;
    } else {
      index = store.slots.length;
      store.slots.push({ generation: 1, value: v, alive: true });
    }
    return { k: "handle", store: id, index, generation: store.slots[index]!.generation };
  },
  handle_load: (ctx, args, span) => {
    const h = args[0];
    if (!ctx.tick() || h?.k !== "handle") badArg(span, "handle_load expects a handle");
    const store = ctx.stores.get(h.store);
    const slot = store?.slots[h.index];
    if (!store || !slot || !slot.alive || slot.generation !== h.generation) {
      // R-Own-8: the one ownership check the spec keeps at run time.
      ctx.report(diag("E0416", "stale_handle",
        `handle ${h.store}:${h.index}#${h.generation} is stale`, span,
        { data: { store: h.store, index: h.index, generation: h.generation } }));
      return UNIT;
    }
    return slot.value ?? UNIT;
  },
  handle_free: (ctx, args, span) => {
    const h = args[0];
    if (!ctx.tick() || h?.k !== "handle") badArg(span, "handle_free expects a handle");
    const store = ctx.stores.get(h.store);
    const slot = store?.slots[h.index];
    if (!store || !slot || !slot.alive || slot.generation !== h.generation) {
      ctx.report(diag("E0416", "stale_handle",
        `handle ${h.store}:${h.index}#${h.generation} is stale`, span));
      return UNIT;
    }
    slot.alive = false;
    slot.value = undefined;
    store.free.push(h.index);
    return UNIT;
  },

  // -- resources -------------------------------------------------------------
  resource_new: (ctx, args, span) => {
    const type = args[0];
    if (!ctx.tick() || type?.k !== "text") badArg(span, "resource_new(type_name, payload, close_fn)");
    const closeFn = args[2];
    return {
      k: "resource",
      type: type.v,
      payload: args[1] ?? UNIT,
      closed: false,
      closeFn: closeFn?.k === "text" ? closeFn.v : null,
    };
  },
  resource_close: (ctx, args, span) => {
    const r = args[0];
    if (!ctx.tick() || !r || !isResourceValue(r)) badArg(span, "resource_close expects a resource");
    const res = r.k === "view" ? r.cell.value : r;
    if (!res || res.k !== "resource") badArg(span, "resource_close expects a resource");
    if (res.closed) {
      ctx.report(diag("E0417", "double_free", `resource ${res.type} is already closed`, span));
      return UNIT;
    }
    closeResource(ctx, res, "explicit", span);
    return UNIT;
  },
  resource_is_closed: (ctx, args, span) => {
    const r = args[0];
    if (!ctx.tick() || r?.k !== "resource") badArg(span, "resource_is_closed expects a resource");
    return { k: "bool", v: r.closed };
  },
  resource_payload: (ctx, args, span) => {
    const r = args[0];
    if (!ctx.tick() || r?.k !== "resource") badArg(span, "resource_payload expects a resource");
    if (r.closed) {
      ctx.report(diag("E0418", "use_after_drop",
        `resource ${r.type} was used after it was dropped`, span));
      return UNIT;
    }
    return r.payload;
  },

  // -- decisions -------------------------------------------------------------
  decision_new: (ctx, args, span) => {
    const v = args[0];
    const conf = args[1];
    if (!ctx.tick() || !v || !conf || (conf.k !== "float" && conf.k !== "int")) {
      badArg(span, "decision_new(value, confidence, provider, model)");
    }
    const provider = args[2]?.k === "text" ? args[2].v : "builtin";
    const model = args[3]?.k === "text" ? args[3].v : "rule";
    return {
      k: "decision",
      value: v,
      confidence: conf.k === "float" ? conf.v : Number(conf.v),
      provider,
      model,
      inputHash: ctx.hash(v),
    };
  },
  decision_value: (ctx, args, span) => {
    const d = args[0];
    if (!ctx.tick() || d?.k !== "decision") badArg(span, "decision_value expects a Decision");
    return d.value;
  },
  decision_confidence: (ctx, args, span) => {
    const d = args[0];
    if (!ctx.tick() || d?.k !== "decision") badArg(span, "decision_confidence expects a Decision");
    return floatV(d.confidence);
  },
  hash_of: (ctx, args, span) => {
    const v = args[0];
    if (!ctx.tick() || !v) badArg(span, "hash_of(value)");
    return { k: "text", v: ctx.hash(v) };
  },
};

/** Shared by `resource_close` and the interpreter's drop elaboration. */
export function closeResource(
  ctx: BuiltinContext,
  res: Extract<Value, { k: "resource" }>,
  reason: "scope" | "return" | "propagate" | "explicit",
  span: Span,
): void {
  if (res.closed) {
    ctx.report(diag("E0417", "double_free", `resource ${res.type} is closed twice`, span));
    return;
  }
  res.closed = true;
  ctx.closes.push({ type: res.type, closeFn: res.closeFn, reason });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function isBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(fns, name);
}

/** Invoke a builtin. Capability-gated names report instead of faking success. */
export function callBuiltin(ctx: BuiltinContext, name: string, args: Value[], span: Span): Value {
  const f = fns[name];
  if (!f) {
    if (Object.prototype.hasOwnProperty.call(CAPABILITY_GATED, name)) {
      ctx.report(capabilityDiagnostic(name, span));
    } else {
      ctx.report(diag("E0199", "unknown_builtin",
        `no function or builtin named \`${name}\``, span));
    }
    return UNIT;
  }
  try {
    return f(ctx, args, span);
  } catch (e) {
    if (e instanceof ArgError) {
      ctx.report(diag(e.code, e.kind, e.message, e.span));
      return UNIT;
    }
    throw e;
  }
}

function describe(v: Value | undefined): string {
  if (!v) return "<missing>";
  switch (v.k) {
    case "int": return `${v.v}`;
    case "float": return `${v.v}`;
    case "bool": return v.v ? "true" : "false";
    case "text": case "char": return JSON.stringify(v.v);
    case "unit": return "()";
    case "variant": return `${v.name}(...)`;
    default: return v.k;
  }
}

export const BUILTIN_NAMES: readonly string[] = Object.freeze(Object.keys(fns).sort());

/**
 * The zero of a map's value type, used when `get` misses.
 *
 * A fresh map carries no value type at run time, so the zero is inferred from what the
 * map already holds, falling back to the integer zero. That is honest about what it
 * knows: `get_opt` exists precisely for the cases where "missing" and "zero" differ.
 */
function zeroValue(m: { entries: Map<string, { key: Value; val: Value }> }): Value {
  for (const entry of m.entries.values()) {
    const v = entry.val;
    if (v.k === "int") return intV(0n);
    if (v.k === "float") return floatV(0);
    if (v.k === "text") return { k: "text", v: "" };
    if (v.k === "bool") return { k: "bool", v: false };
  }
  return intV(0n);
}
