// Iterative Fibonacci: the Integer/CPU row of the benchmark matrix.
// Two shapes - a caller-owned output buffer and a rolling pair - plus the
// loop-carried accumulation a systems programmer would actually write.

// Fills `out` with the first `n` Fibonacci numbers and returns the last one.
// The caller owns the storage, so the function allocates nothing.
fn fib_into(out: view mut [u64], n: usize) -> u64 {
    if out.len() < n { return 0 };
    if n == 0 { return 0 };
    out[0] = 0;
    if n == 1 { return 0 };
    out[1] = 1; let mut i = 2;
    while i < n {
        out[i] = out[i - 1] + out[i - 2];
        i += 1;
    };
    out[n - 1]
}

// The rolling-pair form: constant storage regardless of `n`.
fn fib_rolling(n: u64) -> u64 {
    if n == 0 { return 0 }; let mut prev: u64 = 0; let mut cur: u64 = 1; let mut i: u64 = 1;
    while i < n {
        let next = prev + cur;
        prev = cur;
        cur = next;
        i += 1;
    };
    cur
}

fn fib_ratio(n: u64) -> f64 {
    if n == 0 { return 0.0 };
    fib_rolling(n) as f64 / fib_rolling(n - 1) as f64
}

test "fib into a caller-owned buffer" {
    let mut buf: [u64] = [0, 0, 0, 0, 0, 0, 0, 0]; let last = fib_into(buf, 6); assert_eq(last, 5);
    assert_eq(buf[3], 2); assert_eq(buf[5], 5)
}

test "rolling pair agrees with the buffer form" {
    assert_eq(fib_rolling(0), 0); assert_eq(fib_rolling(10), 55); assert_eq(fib_rolling(30), 832040);
    assert_eq(fib_rolling(50), 12586269025)
}

test "consecutive terms approach the golden ratio" {
    let r = fib_ratio(40); assert(r > 1.618); assert(r < 1.619)
}
