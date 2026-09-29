// A binary search tree held in caller-owned memory and reached only through
// generational `handle` slots. This is the one ownership check MM makes at run
// time: a stale generation is a checked fault, not a silent bad read.

const CAPACITY: usize = 16
const NONE: handle Slot = Handle::none()

type Slot = { key: u32, gen: u32, value: u32, left: handle Slot, right: handle Slot }
type Tree = { slots: [Slot], root: handle Slot, used: usize, gen: u32 }

fn blank() -> Slot {
    Slot { key: 0, gen: 0, value: 0, left: NONE, right: NONE }
}

fn new_tree() -> Tree {
    let mut slots: [Slot; 16] = [blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank(),
                                blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank()];
    Tree { slots: slots, root: NONE, used: 0, gen: 1 }
}

fn has_room(t: view Tree) -> bool {
    t.used < CAPACITY
}

// Hands out a fresh slot and stamps it with the tree's current generation.
fn alloc_slot(t: view mut Tree) -> handle Slot {
    if has_room(t) == false { return NONE }; let h = Handle::at(t.used, t.gen);
    t.slots[t.used] = Slot { key: 0, gen: t.gen, value: 0, left: NONE, right: NONE };
    t.used += 1;
    h
}

// A checked dereference: null, out of range, and stale all read as blank.
fn deref(t: view Tree, h: handle Slot) -> Slot {
    if h.is_null() { return blank() };
    if h.index() >= t.slots.len() { return blank() };
    if h.generation() != t.slots[h.index()].gen { return blank() };
    t.slots[h.index()]
}

fn attach(t: view mut Tree, parent: handle Slot, key: u32, value: u32, left: bool) -> bool {
    let h = alloc_slot(t);
    if h.is_null() { return false };
    let node = Slot { key: key, gen: h.generation(), value: value, left: NONE, right: NONE };
    t.slots[h.index()] = node;
    if left { t.slots[parent.index()].left = h } else { t.slots[parent.index()].right = h };
    true
}

fn make_slot(key: u32, value: u32, gen: u32) -> Slot {
    Slot { key: key, gen: gen, value: value, left: NONE, right: NONE }
}

fn insert(t: view mut Tree, key: u32, value: u32) -> bool {
    if t.root.is_null() {
        let h = alloc_slot(t); let node = make_slot(key, value, h.generation());
        t.slots[h.index()] = node;
        t.root = h;
        return true;
    }; let mut cur = t.root;
    while cur.is_live(t.slots) {
        if t.slots[cur.index()].key == key {
            t.slots[cur.index()].value = value;
            return false;
        };
        if key < t.slots[cur.index()].key {
            if t.slots[cur.index()].left.is_null() { return attach(t, cur, key, value, true) };
            cur = t.slots[cur.index()].left;
        } else {
            if t.slots[cur.index()].right.is_null() { return attach(t, cur, key, value, false) };
            cur = t.slots[cur.index()].right;
        };
    };
    false
}

fn get(t: view Tree, key: u32) -> u32 {
    let mut cur = t.root;
    while cur.is_live(t.slots) {
        let node = deref(t, cur);
        if node.key == key { return node.value };
        if key < node.key { cur = node.left } else { cur = node.right };
    };
    0
}

fn depth(t: view Tree) -> usize {
    let mut d = 0; let mut cur = t.root;
    while cur.is_live(t.slots) {
        cur = t.slots[cur.index()].left;
        d += 1;
    };
    d
}

test "builds a tree and reads it back" {
    let mut t = new_tree(); assert(insert(t, 5, 50)); assert(insert(t, 3, 30)); assert(insert(t, 8, 80));
    assert_eq(t.used, 3); assert_eq(get(t, 3), 30); assert_eq(get(t, 8), 80); assert_eq(get(t, 4), 0)
}

test "re-inserting a key updates in place" {
    let mut t = new_tree();
    insert(t, 5, 50); assert_eq(insert(t, 5, 51), false); assert_eq(t.used, 1); assert_eq(get(t, 5), 51);
    assert_eq(depth(t), 1)
}
