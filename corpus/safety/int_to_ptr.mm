// case: integer-to-pointer misuse - expect E0430 (static)
//
// A `usize` is cast straight to `*mut u8` in safe code. An int-to-pointer
// conversion is only legal inside an `unsafe[rawptr]` context; in safe code
// the `usize` has no provenance and the deref is unsound.
fn poke(addr: usize) -> u8 {
    let p = addr as *mut u8;
    *p
}
