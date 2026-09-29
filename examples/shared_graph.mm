// A `shared` node graph: explicit reference counting instead of a long-lived
// borrow. Nodes are cloned into each other's peer lists, so a walk may hold one
// node while the graph keeps growing around it.

type Node = { id: u32, label: Text, peers: [shared Node] }

// The factory is how a `shared` value is born: the compiler refcounts it once.
fn make_node(id: u32, label: Text) -> shared Node {
    Node { id: id, label: label, peers: [] }
}

fn connect(a: shared Node, b: shared Node) -> usize {
    a.peers.push(b);
    b.peers.push(a);
    a.peers.len()
}

fn fanout(n: shared Node) -> usize {
    n.peers.len()
}

fn label_len(n: shared Node) -> usize {
    n.label.len()
}

// Marks visited ids and returns how many distinct nodes the walk reached.
fn walk(n: shared Node, seen: view mut [u8], budget: usize) -> usize {
    if seen[n.id as usize] == 1 { return 0 };
    if budget == 0 { return 0 };
    seen[n.id as usize] = 1; let mut reached = 1; let mut i = 0;
    while i < n.peers.len() {
        reached += walk(n.peers[i], seen, budget - 1);
        i += 1;
    };
    reached
}

// A fold over the same graph, with the seen set threaded through the recursion.
fn total_id(n: shared Node, seen: view mut [u8]) -> u32 {
    if seen[n.id as usize] == 1 { return 0 };
    seen[n.id as usize] = 1; let mut total = n.id; let mut i = 0;
    while i < n.peers.len() {
        total += total_id(n.peers[i], seen);
        i += 1;
    };
    total
}

test "two shared nodes link both ways" {
    let a = make_node(1, "alpha"); let b = make_node(2, "beta"); assert_eq(connect(a, b), 1);
    assert_eq(fanout(a), 1); assert_eq(fanout(b), 1); assert_eq(label_len(a), 5)
}

test "a walk terminates on a cycle" {
    let a = make_node(1, "alpha"); let b = make_node(2, "beta"); let c = make_node(3, "gamma");
    connect(a, b);
    connect(b, c);
    connect(c, a); let mut seen: [u8] = [0, 0, 0, 0]; assert_eq(walk(a, seen, 16), 3);
    let mut folded: [u8] = [0, 0, 0, 0]; assert_eq(total_id(a, folded), 6)
}

test "the walk respects its budget" {
    let a = make_node(1, "alpha"); let b = make_node(2, "beta");
    connect(a, b); let mut seen: [u8] = [0, 0, 0, 0]; assert_eq(walk(a, seen, 1), 1)
}
