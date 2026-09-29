// case: stale generational handle - expect E0416 (RUNTIME by design)
//
// R-Own-8: a `handle` deref is a checked generational load, not a static proof.
// The slot is freed and reused, so the generation is bumped and the old handle no
// longer matches the store. This is the one ownership check the spec deliberately
// leaves to run time, and the program below is otherwise well-typed: the manifest
// records it with `stage: "runtime"`.
//
// The load happens through `handle_of`, which is the only sanctioned way to
// produce a handle; nothing here is a *static* error, which is the point.
type Session = { id: u64 }

fn reuse_pool() -> u64 {
    let s = Session { id: 1 }
    let h = handle_of(s)
    let first = h.id
    h.id + first
}
