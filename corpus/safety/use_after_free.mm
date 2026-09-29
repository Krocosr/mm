// case: use_after_free (owner dropped, view used) - expect E0413 (static)
//
// R-Own-3: a view is valid only within the region of the place it derives from.
// `v` is a `view` of `buf`; `buf` goes out of scope at the end of the inner block,
// and `v` is read afterwards — the borrow outlives what it points at, so the read
// is a dangling pointer.
type Buf = { data: Bytes, len: usize }

fn read_len(b: view Buf) -> usize {
    b.len
}

fn summarize() -> usize {
    let v = {
        let buf = Buf { data: b"abcd", len: 4 };
        view buf
    };
    read_len(v)
}
