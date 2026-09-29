// Bubble sort over a generic slice: the in-place `view mut [T]` pattern.
// The sort borrows the caller's storage exclusively and reports how many swaps
// it performed, which is the number a benchmark harness records.

fn bubble_sort[T: Ord](xs: view mut [T]) -> usize {
    let n = xs.len(); let mut swaps = 0; let mut i = 0;
    while i < n {
        let mut j = 0;
        while j + 1 < n - i {
            if xs[j] > xs[j + 1] {
                let tmp = xs[j];
                xs[j] = xs[j + 1];
                xs[j + 1] = tmp;
                swaps += 1;
            };
            j += 1;
        };
        i += 1;
    };
    swaps
}

// A read-only pass: `view`, so the sortedness check cannot mutate the slice.
fn is_sorted[T: Ord](xs: view [T]) -> bool {
    let mut i = 1;
    while i < xs.len() {
        if xs[i] < xs[i - 1] { return false };
        i += 1;
    };
    true
}

// Inversions are exactly the swaps bubble sort performs.
fn count_inversions(xs: view [u32]) -> usize {
    let mut inversions = 0; let mut i = 0;
    while i < xs.len() {
        let mut j = i + 1;
        while j < xs.len() {
            if xs[j] < xs[i] { inversions += 1 };
            j += 1;
        };
        i += 1;
    };
    inversions
}

test "sorts and counts swaps" {
    let xs: [u32] = [5, 3, 9, 1, 3]; let swaps = bubble_sort(xs); assert_eq(swaps, 6); assert_eq(xs[0], 1);
    assert_eq(xs[2], 3); assert_eq(xs[4], 9); assert(is_sorted(xs))
}

test "swap count equals the inversion count" {
    let ys: [u32] = [9, 7, 5, 3, 1]; let inversions = count_inversions(ys); let swaps = bubble_sort(ys);
    assert_eq(swaps, inversions); assert_eq(inversions, 10); assert(is_sorted(ys))
}
