use slot_pool

// The grading suite for `slot_pool.mm`. It is all about the one property the
// generation stamp exists to provide: once a handle has been released, nothing
// the pool does afterwards may make it read as live again.

test "a released handle is retired immediately" {
    let mut p = new_pool(); let a = alloc(p, 11); let b = alloc(p, 22);
    assert(release(p, a));
    assert_eq(is_stale(p, a), true);
    assert_eq(get(p, a), 0);
    assert_eq(is_stale(p, b), false);
    assert_eq(get(p, b), 22)
}

test "a reused slot does not resurrect the old holder's handle" {
    let mut p = new_pool(); let a = alloc(p, 11); let b = alloc(p, 22);
    assert(release(p, a));
    let c = alloc(p, 33);
    assert_eq(c.index(), a.index());
    assert_eq(get(p, c), 33);
    assert_eq(is_stale(p, a), true);
    assert_eq(get(p, a), 0)
}

test "a fresh handle never reuses a retired generation" {
    let mut p = new_pool(); let a = alloc(p, 11);
    assert(release(p, a));
    let c = alloc(p, 22);
    assert(a.generation() != c.generation());
    assert_eq(get(p, c), 22);
    assert_eq(get(p, a), 0)
}

test "the property holds across several alloc and release cycles" {
    let mut p = new_pool(); let a = alloc(p, 1);
    assert(release(p, a));
    let b = alloc(p, 2);
    assert_eq(get(p, a), 0);
    assert(release(p, b));
    let c = alloc(p, 3);
    assert_eq(get(p, a), 0);
    assert_eq(get(p, b), 0);
    assert_eq(get(p, c), 3);
    assert_eq(live_count(p), 1)
}

test "a retired handle stays retired while its slot is refilled" {
    let mut p = new_pool(); let a = alloc(p, 7); let b = alloc(p, 8); let d = alloc(p, 9);
    assert(release(p, b));
    let e = alloc(p, 10);
    assert_eq(get(p, b), 0);
    assert_eq(get(p, a), 7);
    assert_eq(get(p, d), 9);
    assert_eq(get(p, e), 10);
    assert_eq(live_count(p), 3)
}

test "releasing through a retired handle cannot free somebody else's record" {
    let mut p = new_pool(); let a = alloc(p, 1);
    assert(release(p, a));
    let b = alloc(p, 2);
    assert_eq(release(p, a), false);
    assert_eq(get(p, b), 2);
    assert_eq(live_count(p), 1)
}
