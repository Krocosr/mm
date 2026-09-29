// Recursive Fibonacci: call overhead, branch prediction, and stack depth.
// The naive form is the baseline; the tail-recursive and accumulator forms are
// the two rewrites a systems programmer reaches for first.

fn fib_rec(n: u64) -> u64 {
    if n < 2 { n } else { fib_rec(n - 1) + fib_rec(n - 2) }
}

// Tail-recursive: the recursive call is in tail position, so the frame is reused.
fn fib_tail(n: u64, a: u64, b: u64) -> u64 {
    if n == 0 { a } else { fib_tail(n - 1, b, a + b) }
}

// The accumulator form: the running sum is a parameter rather than a stack slot.
fn fib_step(n: u64, f0: u64, f1: u64) -> u64 {
    if n == 0 { return f0 };
    fib_step(n - 1, f1, f0 + f1)
}

// Work done by the naive form: it doubles at every level, so the call count
// grows as the golden ratio to the n.
fn fib_work(n: u64) -> u64 {
    if n < 2 { 1 } else { 1 + fib_work(n - 1) + fib_work(n - 2) }
}

test "naive recursion" {
    assert_eq(fib_rec(0), 0); assert_eq(fib_rec(10), 55); assert_eq(fib_rec(20), 6765)
}

test "tail recursion matches naive recursion" {
    assert_eq(fib_tail(20, 0, 1), 6765); assert_eq(fib_step(20, 0, 1), 6765);
    assert_eq(fib_tail(30, 0, 1), fib_rec(30))
}

test "call count grows as the golden ratio" {
    assert_eq(fib_work(10), 177); assert_eq(fib_work(15), 1973)
}
