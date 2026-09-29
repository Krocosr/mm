use bitfield

// The grading suite for `bitfield.mm`. It exercises header tags across the
// whole width the field is declared to have, including the two high bits that
// small tags never reach.

test "tags round-trip across the full field width" {
    let h = Header { tag: 1023, len: 11, flags: 1 };
    let w = pack(h);
    assert_eq(tag_of(w), 1023);
    assert_eq(len_of(w), 11);
    assert_eq(flags_of(w), 1)
}

test "tags above the ten bit range are not clipped" {
    let h = Header { tag: 3000, len: 10, flags: 1 };
    let w = pack(h);
    assert_eq(tag_of(w), 3000);
    assert_eq(score(w), 3000 * 31 + 10 * 7 + 1);
    assert_eq(handler_for(w), (3000 * 31 + 10 * 7 + 1) % 4)
}

test "the largest tag in a twelve bit field survives packing" {
    let h = Header { tag: 4095, len: 0, flags: 0 };
    let w = pack(h);
    assert_eq(tag_of(w), 4095);
    assert_eq(len_of(w), 0);
    assert_eq(flags_of(w), 0)
}

test "a large tag does not bleed into the length field" {
    let h = Header { tag: 2048, len: 777, flags: 3 };
    let w = pack(h);
    let back = unpack(w);
    assert_eq(back.tag, 2048);
    assert_eq(back.len, 777);
    assert_eq(back.flags, 3)
}

test "every tag in a stride is independent" {
    let mut t = 1024; let mut i = 0;
    while i < 6 {
        let h = Header { tag: t, len: 5, flags: 0 };
        let w = pack(h);
        assert_eq(tag_of(w), t);
        t = t + 1;
        i += 1;
    }
}
