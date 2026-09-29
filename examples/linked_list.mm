// An owned, singly-linked list. `Cons` owns its tail, so the whole list is one
// affine value: traversals borrow it with `view`, consumers take it by value.

type List =
    Nil
  | Cons { head: u32, tail: List }

// Builds the list back to front, so the tail is always the list so far.
fn from_backward(xs: view [u32]) -> List {
    let mut out = Nil; let mut i = xs.len();
    while i > 0 {
        i -= 1;
        out = Cons { head: xs[i], tail: out };
    };
    out
}

fn sum(xs: view List) -> u32 {
    match xs {
        Nil => 0,
        Cons { head, tail } => head + sum(tail)
    }
}

fn len(xs: view List) -> usize {
    match xs {
        Nil => 0,
        Cons { head, tail } => 1 + len(tail)
    }
}

fn nth(xs: view List, k: usize) -> u32 {
    match xs {
        Nil => 0,
        Cons { head, tail } => if k == 0 { head } else { nth(tail, k - 1) }
    }
}

fn map_doubled(xs: view List) -> List {
    match xs {
        Nil => Nil,
        Cons { head, tail } => Cons { head: head * 2, tail: map_doubled(tail) }
    }
}

// Consuming traversal: the list is moved into the call, not borrowed.
fn into_buffer(xs: List, out: view mut [u32]) -> usize {
    let mut n = 0; let mut cur = xs;
    while n < out.len() {
        match cur {
            Nil => { break },
            Cons { head, tail } => { out[n] = head; cur = tail; n += 1 }
        };
    };
    n
}

test "builds and traverses" {
    let xs: [u32] = [1, 2, 3, 4]; let list = from_backward(xs); assert_eq(len(list), 4);
    assert_eq(sum(list), 10); assert_eq(nth(list, 2), 3); assert_eq(nth(list, 9), 0)
}

test "map and consuming traversal" {
    let xs: [u32] = [5, 6]; let doubled = map_doubled(from_backward(xs)); assert_eq(sum(doubled), 22);
    let mut out: [u32] = [0, 0]; assert_eq(into_buffer(from_backward(xs), out), 2); assert_eq(out[0], 5);
    assert_eq(out[1], 6)
}
