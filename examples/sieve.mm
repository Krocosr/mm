// Sieve of Eratosthenes over a caller-owned [bool]: the memory row of the
// benchmark matrix. The sieve never allocates; the caller owns the storage and
// the function borrows it as `view mut`.

const WIDTH: usize = 32

// A zeroed scratch buffer of WIDTH slots.
fn scratch() -> [bool] {
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}

// Marks every prime below `limit` in `xs` and returns how many were found.
fn sieve(xs: view mut [bool], limit: usize) -> usize {
    let n = xs.len(); let mut i = 0;
    while i < n {
        xs[i] = 1;
        i += 1;
    }; let mut bound = limit;
    if bound > n { bound = n }; let mut p = 2; let mut found = 0;
    while p < bound {
        if xs[p] == 1 {
            let mut m = p * p;
            while m < n {
                xs[m] = 0;
                m += p;
            };
            found += 1;
        };
        p += 1;
    };
    found
}

fn count_set(xs: view [bool], upto: usize) -> usize {
    let mut total = 0; let mut i = 2;
    while i < upto {
        if i < xs.len() && xs[i] == 1 { total += 1 };
        i += 1;
    };
    total
}

fn is_prime(xs: view [bool], n: usize) -> bool {
    if n < 2 { return false };
    if n >= xs.len() { return false };
    xs[n] == 1
}

test "sieve marks composites" {
    let flags = scratch(); let found = sieve(flags, 20); assert_eq(found, 8); assert_eq(flags[4], 0);
    assert_eq(flags[7], 1); assert_eq(flags[9], 0)
}

test "every prime below 32 survives" {
    let flags = scratch();
    sieve(flags, 32); assert_eq(count_set(flags, 32), 11); assert(is_prime(flags, 29));
    assert(!is_prime(flags, 30))
}
