// case: iterator_invalidation (mutate a slice while a read view is live) - expect E0414 (static)
//
// R-Own-4: the `view xs` read borrow is still live when `push` writes through the
// same place. Reallocating under a live read view is exactly the
// iterator-invalidation the rule exists to reject.
fn normalize_and_grow(xs: view mut [f32]) -> usize {
    let r = view xs;
    let n = r.len();
    xs.push(1.0);
    n
}
