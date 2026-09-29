// A `@resource` handle and its close path. The early return in `scan` is the
// point of the example: the drop path runs exactly once on every exit, so the
// empty-file case does not leak and does not double close.

use std.fs.{open, read_all, close}

@resource(close = fs.close)
type File = Handle<Fd>

type Scan = { lines: usize, bytes: usize }

const NEWLINE: u8 = 10

fn empty_scan() -> Scan {
    Scan { lines: 0, bytes: 0 }
}

fn count_lines(body: Bytes) -> usize {
    let mut n = 0;
    for b in body {
        if b == NEWLINE { n += 1 };
    };
    n
}

fn scan_bytes(body: Bytes) -> Scan {
    let s = Scan { lines: count_lines(body), bytes: body.len() };
    s
}

fn is_empty_file(f: view File) -> bool {
    f.size() == 0
}

// Scans a path. `?` propagates the open and read failures; the resource drop
// still runs on each of the three exits.
fn scan(path: Path) -> Result<Scan, IoErr> !{fs.read, fs.close} {
    let f = open(path)?;
    if is_empty_file(f) { return Ok(empty_scan()) }; let body = read_all(f)?; let s = scan_bytes(body);
    Ok(s)
}

fn or_empty(r: Result<Scan, IoErr>) -> Scan {
    match r { Ok(s) => s, Err(e) => empty_scan() }
}

test "counts the lines of a scanned buffer" {
    let s = scan_bytes(b"a\nb\nc"); assert_eq(s.lines, 2); assert_eq(s.bytes, 5);
    assert_eq(scan_bytes(b"").lines, 0)
}

test "a failed scan reads as empty" {
    let missing = or_empty(scan("does/not/exist")); assert_eq(missing.lines, 0); assert_eq(missing.bytes, 0);
    assert_eq(count_lines(b"\n\n\n"), 3)
}
