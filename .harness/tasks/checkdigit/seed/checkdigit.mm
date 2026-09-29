// The mod-10 check digit used on decimal identifiers. A number's digits are
// added together with every second digit doubled - the ones sitting one place
// in from the right end - and a doubled digit that comes out above nine loses
// nine. The check digit is whatever brings a payload's total to a multiple of
// ten once the check digit itself has been appended, so a number is valid when
// the total over all of its digits already is a multiple of ten.

const ZERO: u8 = 48
const NINE: u32 = 9
const TEN: u32 = 10

fn is_digits(s: Text) -> bool {
    let bytes = s.as_bytes();
    let mut ok = bytes.len() > 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] < ZERO || bytes[i] > ZERO + 9 { ok = false };
        i += 1;
    };
    ok
}

fn digit_at(s: Text, i: usize) -> u32 {
    (s.as_bytes()[i] - ZERO) as u32
}

// A doubled digit only ever reaches eighteen, so subtracting nine once is
// enough to fold it back into a single digit.
fn fold(d: u32) -> u32 {
    if d > NINE { d - NINE } else { d }
}

// The doubling pass starts at the leftmost digit and alternates from there, so
// the loop is a straight scan of the string and never has to walk backwards.
fn luhn_total(s: Text) -> u32 {
    let mut total = 0; let mut i = 0;
    while i < s.len() {
        let mut d = digit_at(s, i);
        if i % 2 == 0 { d = fold(d * 2) };
        total = total + d;
        i += 1;
    };
    total
}

// Appending the check digit puts it at the right end without moving any payload
// digit, and the check digit itself is never doubled. Running the same total
// over the payload with a placeholder zero in the check position therefore
// gives the total that the real check digit has to complete.
fn check_digit(payload: Text) -> u32 {
    (TEN - luhn_total(payload + "0") % TEN) % TEN
}

fn last_digit(s: Text) -> u32 {
    if s.len() == 0 { return 0 };
    digit_at(s, s.len() - 1)
}

// A number is valid when the total over all of its digits is a multiple of ten.
fn verify(s: Text) -> bool {
    luhn_total(s) % TEN == 0
}

// The same check written over a payload and the check digit it carries.
fn verify_pair(payload: Text, check: u32) -> bool {
    check_digit(payload) == check
}

test "a sixteen digit number totals a multiple of ten" {
    assert(is_digits("4539578763621486"));
    assert_eq(luhn_total("4539578763621486"), 80);
    assert(verify("4539578763621486"));
    assert_eq(luhn_total("6011000990139424"), 50);
    assert(verify("6011000990139424"));
    assert_eq(luhn_total("4012888888881881"), 90);
    assert(verify("4012888888881881"))
}

test "the check digit completes a short payload" {
    assert_eq(check_digit("305"), 3);
    assert_eq(check_digit("49054"), 0);
    assert_eq(check_digit("1"), 8);
    assert_eq(check_digit("12345"), 5);
    assert_eq(check_digit("109"), 9);
    assert_eq(check_digit("8675309"), 2)
}

test "a payload that already completes needs a zero" {
    assert_eq(luhn_total("490540"), 30);
    assert(verify("490540"));
    assert_eq(check_digit("00000000"), 0);
    assert_eq(last_digit("00000000"), 0)
}

test "verify_pair agrees with the check digit" {
    assert_eq(verify_pair("305", 3), true);
    assert_eq(verify_pair("305", 4), false);
    assert_eq(last_digit("3053"), 3);
    assert(verify("3053"))
}

test "non digits are rejected" {
    assert_eq(is_digits(""), false);
    assert_eq(is_digits("12a4"), false);
    assert_eq(is_digits("1234"), true)
}
