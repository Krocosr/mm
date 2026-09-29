// safe: a `shared` node graph walked recursively. `shared` is refcounted, so the
// walk re-borrows an RC handle rather than an exclusive one. R-Own-6 makes this
// legal; only the RC atomicity choice differs.
type Node = { name: Text, next: shared Node? }

fn walk(n: shared Node, depth: usize) -> usize {
    match n.next {
        Some(next) => depth + walk(next, depth + 1)
        None => depth
    }
}

fn leaf(name: Text) -> shared Node {
    shared_new(Node { name: name, next: None })
}

fn run() -> usize {
    let root = leaf("a")
    walk(root, 0)
}
