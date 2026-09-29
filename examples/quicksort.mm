// Quicksort: generics, partitioning, and the three-parameter range form that
// keeps the recursion from allocating a slice header per level.

fn swap[T](xs: view mut [T], i: usize, j: usize) {
    let tmp = xs[i];
    xs[i] = xs[j];
    xs[j] = tmp
}

// Lomuto partition around the last element; returns the pivot's final index.
fn partition[T: Ord](xs: view mut [T], lo: usize, hi: usize) -> usize {
    let pivot = xs[hi]; let mut store = lo; let mut scan = lo;
    while scan < hi {
        if xs[scan] < pivot {
            swap(xs, store, scan);
            store += 1;
        };
        scan += 1;
    };
    swap(xs, store, hi);
    store
}

fn quicksort_range[T: Ord](xs: view mut [T], lo: usize, hi: usize) -> usize {
    if lo >= hi { return 0 }; let pivot = partition(xs, lo, hi);
    // Lomuto puts the pivot last when every element in the range is smaller than it, so
    // `pivot` can land on `hi`. Recursing on `[lo, pivot]` would then hand back the very
    // range we started with and never terminate. That case is exactly "the tail is
    // already in place": sort the range below it and treat the pivot as settled.
    let left = if pivot >= hi { quicksort_range(xs, lo, hi - 1) } else { quicksort_range(xs, lo, pivot) };
    let right = quicksort_range(xs, pivot + 1, hi);
    1 + left + right
}

fn quicksort[T: Ord](xs: view mut [T]) -> usize {
    if xs.len() < 2 { return 0 };
    quicksort_range(xs, 0, xs.len() - 1)
}

fn is_sorted[T: Ord](xs: view [T]) -> bool {
    let mut i = 1;
    while i < xs.len() {
        if xs[i] < xs[i - 1] { return false };
        i += 1;
    };
    true
}

test "sorts an unsorted slice" {
    let xs: [u32] = [3, 1, 4, 1, 5, 9, 2, 6]; let partitions = quicksort(xs); assert_eq(partitions, 7);
    assert_eq(xs[0], 1); assert_eq(xs[7], 9); assert(is_sorted(xs))
}

test "already sorted input still partitions" {
    let xs: [u32] = [1, 2, 3, 4]; assert_eq(quicksort(xs), 3); assert(is_sorted(xs))
}
