// case: reference escapes its arena - expect E0415 (static)
//
// R-Own-7: the bump allocation behind an `arena` is bounded by the callee's
// region, so a `view` derived from it cannot outlive that region. The only
// sanctioned escape is `handle_of`, which re-allocates into a generational
// store; returning a borrow is not that.
type Node = { value: u32 }

fn first_of(a: arena Node) -> view Node {
    view a
}
