// CRC-32 (IEEE 802.3, reflected, polynomial 3988292384): the bitwise row of
// the benchmark matrix. Two implementations of the same check value - one
// folding the polynomial a bit at a time, one indexing a table built from it.

const POLY: u32 = 3988292384
const INIT: u32 = 4294967295

// One byte in, one byte of state out: the inner step both forms share.
// Division by two is the halving step; the operands are unsigned.
fn crc32_step(crc: u32, byte: u8) -> u32 {
    crc = crc ^ byte as u32; let mut k = 0;
    while k < 8 {
        if crc % 2 == 1 { crc = crc / 2 ^ POLY } else { crc = crc / 2 };
        k += 1;
    };
    crc
}

// Bitwise form: eight folds per input byte, no lookup table.
fn crc32(data: view Bytes) -> u32 {
    let mut crc = INIT;
    for b in data {
        crc = crc32_step(crc, b);
    };
    crc ^ INIT
}

// Fills a 256-entry lookup table from the polynomial. The caller owns it.
fn build_table(table: view mut [u32]) {
    let mut i = 0;
    while i < table.len() {
        table[i] = crc32_step(0, i as u8);
        i += 1;
    }
}

// Table-driven form: one lookup per input byte, same answer.
fn crc32_table(data: view Bytes, table: view [u32]) -> u32 {
    let mut crc = INIT;
    for b in data {
        let idx = ((crc ^ b as u32) % 256) as usize;
        crc = table[idx] ^ crc / 256;
    };
    crc ^ INIT
}

fn crc32_text(s: Text) -> u32 {
    crc32(s.as_bytes())
}

// A zeroed 256-entry table: the checksum owns its scratch space explicitly.
fn zero_table() -> [u32] {
[    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}

test "crc32 check value" {
    assert_eq(crc32(b"123456789"), 3421780262); assert_eq(crc32(b""), 0);
    assert_eq(crc32(b"hello"), 907060870)
}

test "table form agrees with the bitwise form" {
    let mut table = zero_table();
    build_table(table); assert_eq(table[1], 1996959894);
    assert_eq(crc32_table(b"123456789", table), 3421780262);
    assert_eq(crc32_table(b"hello", table), crc32(b"hello")); assert_eq(crc32_text("hello"), 907060870)
}
