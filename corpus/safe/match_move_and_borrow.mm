// safe: a `match` on a union where one arm moves a field out and another
// borrows the whole value. Only one arm executes, so the two regions never
// coexist.
type Payload = Text { raw: Bytes } | Empty

fn measure(p: Payload) -> usize {
    match p {
        Text { raw } => raw.len()
        Empty => 0
    }
}

fn describe(p: view Payload) -> usize {
    match p {
        Text { raw } => raw.len()
        Empty => 0
    }
}
