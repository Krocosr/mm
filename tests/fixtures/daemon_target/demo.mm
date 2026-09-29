// A small package the daemon and extension tests query. It exists to have a wire schema,
// a resource, an effectful function, and a call graph with a known shape.
@wire
type Job = { id: u64, label: Text }

@resource(close = fs.close)
type File = Handle<Fd>

fn helper(n: i64) -> i64 {
    n * 2
}

fn load(path: Path) -> Result<Bytes, IoErr> !{fs.read} {
    fs.read(path)
}

pub fn run(p: Path) -> Result<i64, IoErr> !{fs.read} {
    let b = load(p)?
    Ok(helper(b.len() as i64))
}

test "the package checks clean" {
    assert_eq(helper(21), 42)
}
