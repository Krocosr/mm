// FNV-1a over byte strings: the hashing row of the benchmark matrix.
// The loop is the whole algorithm; what matters is that it is branch-free and
// that the same body serves a slice, a Text, and a chunked stream.

const OFFSET: u32 = 2166136261
const PRIME: u32 = 16777619

fn fnv1a(data: view Bytes) -> u32 {
    let mut h = OFFSET;
    for b in data {
        h ^= b as u32;
        h = h * PRIME;
    };
    h
}

// Text hashes identically to its UTF-8 bytes.
fn fnv1a_text(s: Text) -> u32 {
    fnv1a(s.as_bytes())
}

// Order-sensitive combination, so a chunked hash differs from a concatenated one.
fn combine(h1: u32, h2: u32) -> u32 {
    (h1 ^ h2) * PRIME
}

fn fnv1a_chunks(chunks: view [Bytes]) -> u32 {
    let mut h = OFFSET; let mut i = 0;
    while i < chunks.len() {
        h = combine(h, fnv1a(chunks[i]));
        i += 1;
    };
    h
}

test "fnv1a known vectors" {
    assert_eq(fnv1a(b""), 2166136261); assert_eq(fnv1a(b"a"), 3826002220);
    assert_eq(fnv1a(b"foobar"), 3214735720)
}

test "text and bytes agree" {
    assert_eq(fnv1a_text("foobar"), 3214735720); assert_eq(fnv1a_text(""), 2166136261)
}

test "chunked hashing is order sensitive" {
    let one = fnv1a_chunks([b"foo", b"bar"]); let two = fnv1a_chunks([b"bar", b"foo"]); assert(one != two);
    assert_eq(one, combine(combine(OFFSET, fnv1a(b"foo")), fnv1a(b"bar")))
}
