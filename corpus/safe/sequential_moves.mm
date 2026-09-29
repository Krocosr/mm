// safe: an owned value is moved into a callee exactly once; the source region
// ends at the call and the destination is dropped once. Baseline R-Own-1.
type Token = { id: u64, text: Text }

fn make(id: u64) -> Token {
    Token { id: id, text: "t" }
}

fn consume(t: Token) -> u64 {
    t.id
}

fn run() -> u64 {
    let t = make(7);
    consume(t)
}
