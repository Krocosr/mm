// safe: an `arena` value used freely inside its region, then converted to a
// checked `handle` at the boundary.
//
// R-Own-7 says a *reference into* an arena may not escape. The only sanctioned escape
// is `handle_of`, which allocates into a generational store: the result is a
// run-time-checked indirection rather than a borrowed pointer, which is why the spec
// accepts this conversion instead of forbidding the escape outright.
//
// The companion that must be *rejected* is `corpus/safety/arena_escape.mm`, which
// returns a `view` derived from the arena.
type Node = { value: u32 }

fn inside(a: arena Node) -> u32 {
    a.value
}

fn boundary(a: arena Node) -> handle Node {
    let v = inside(a)
    if v == 0 {
        return handle_of(a)
    }
    handle_of(a)
}
