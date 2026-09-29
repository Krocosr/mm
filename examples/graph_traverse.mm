// Breadth-first and depth-first traversal of a Map adjacency table: the graph
// row of the benchmark matrix. Both walks share one `seen` discipline and one
// caller-owned visit buffer, so neither allocates.

type Graph = Map<u32, [u32]>

// Level order: the visit buffer doubles as the queue.
fn bfs(g: view Graph, start: u32, seen: view mut [u8], order: view mut [u32]) -> usize {
    seen[start as usize] = 1;
    order[0] = start; let mut n = 1; let mut head = 0;
    while head < n {
        let node = order[head];
        head += 1; let neighbours = g.get(node); let mut i = 0;
        while i < neighbours.len() {
            let next = neighbours[i];
            if seen[next as usize] == 0 {
                seen[next as usize] = 1;
                order[n] = next;
                n += 1;
            };
            i += 1;
        };
    };
    n
}

// Depth order: the recursion carries the write cursor, so no stack of indices.
fn dfs_from(g: view Graph, node: u32, seen: view mut [u8], order: view mut [u32], at: usize) -> usize {
    if seen[node as usize] == 1 { return at };
    seen[node as usize] = 1;
    order[at] = node; let mut next = at + 1; let neighbours = g.get(node); let mut i = 0;
    while i < neighbours.len() {
        next = dfs_from(g, neighbours[i], seen, order, next);
        i += 1;
    };
    next
}

fn dfs(g: view Graph, start: u32, seen: view mut [u8], order: view mut [u32]) -> usize {
    dfs_from(g, start, seen, order, 0)
}

// Edges leaving each visited node, counted once.
fn edge_count(g: view Graph, order: view [u32], count: usize) -> usize {
    let mut edges = 0; let mut i = 0;
    while i < count {
        edges += g.get(order[i]).len();
        i += 1;
    };
    edges
}

test "bfs reaches the whole component" {
    let mut g: Graph = Map::new();
    g.insert(1, [2, 3]);
    g.insert(2, [4]);
    g.insert(3, [4]);
    g.insert(4, []); let mut seen: [u8] = [0, 0, 0, 0, 0, 0]; let mut order: [u32] = [0, 0, 0, 0, 0, 0];
    let reached = bfs(g, 1, seen, order); assert_eq(reached, 4); assert_eq(order[0], 1);
    assert_eq(order[1], 2); assert_eq(edge_count(g, order, reached), 4)
}

test "dfs visits the same set in depth order" {
    let mut g: Graph = Map::new();
    g.insert(1, [2, 3]);
    g.insert(2, [4]);
    g.insert(3, [4]);
    g.insert(4, []); let mut seen: [u8] = [0, 0, 0, 0, 0, 0]; let mut order: [u32] = [0, 0, 0, 0, 0, 0];
    let reached = dfs(g, 1, seen, order); assert_eq(reached, 4); assert_eq(order[0], 1);
    assert_eq(order[1], 2); assert_eq(order[2], 4); assert_eq(order[3], 3)
}
