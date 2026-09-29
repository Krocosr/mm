// A record header packed into one u32. Three fields share the word: a tag, a
// payload length, and a flag set. Reading a field is a shift and a mask, so
// the layout is the whole contract - the neighbouring bits sit right next to
// the field and are indistinguishable from a small number of their own.

const TAG_SHIFT: u32 = 0
const LEN_SHIFT: u32 = 12
const FLAG_SHIFT: u32 = 22

const TAG_BITS: u32 = 12
const LEN_BITS: u32 = 10

type Header = { tag: u32, len: u32, flags: u32 }

fn pack(h: view Header) -> u32 {
    h.tag + h.len * pow(2, LEN_SHIFT) + h.flags * pow(2, FLAG_SHIFT)
}

// Tags are a small enum in practice, so the low ten bits hold the whole tag
// and the two bits above them are already the bottom of the length field.
fn tag_of(w: u32) -> u32 {
    (w / pow(2, TAG_SHIFT)) % pow(2, LEN_BITS)
}

fn len_of(w: u32) -> u32 {
    (w / pow(2, LEN_SHIFT)) % pow(2, LEN_BITS)
}

fn flags_of(w: u32) -> u32 {
    w / pow(2, FLAG_SHIFT)
}

fn unpack(w: u32) -> Header {
    Header { tag: tag_of(w), len: len_of(w), flags: flags_of(w) }
}

// The dispatcher scores a header to pick a handler without decoding the
// payload, so the score depends on all three fields and nothing else.
fn score(w: u32) -> u32 {
    tag_of(w) * 31 + len_of(w) * 7 + flags_of(w)
}

fn handler_for(w: u32) -> u32 {
    score(w) % 4
}

test "packs and unpacks a small header" {
    let h = Header { tag: 7, len: 300, flags: 5 };
    let w = pack(h);
    assert_eq(len_of(w), 300);
    assert_eq(flags_of(w), 5);
    assert_eq(score(w), 7 * 31 + 300 * 7 + 5)
}

test "neighbouring headers score independently" {
    let a = Header { tag: 3, len: 1, flags: 0 };
    let b = Header { tag: 3, len: 2, flags: 0 };
    let wa = pack(a); let wb = pack(b);
    assert(score(wa) != score(wb));
    assert_eq(handler_for(wa), score(wa) % 4);
    assert_eq(unpack(wa).len, 1)
}
