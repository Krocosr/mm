use checkdigit

// The grading suite for `checkdigit.mm`. Every vector here has a length whose
// parity decides which digits the doubling pass is supposed to reach, so none
// of them can be satisfied by a rule that only ever looks at the leftmost
// digit of a pair.

test "the doubling pass follows the length of the string" {
    assert_eq(luhn_total("1"), 1);
    assert_eq(luhn_total("4"), 4);
    assert_eq(luhn_total("305"), 8);
    assert_eq(luhn_total("109"), 10);
    assert_eq(luhn_total("12345"), 21);
    assert_eq(luhn_total("8675309"), 31)
}

test "a known eleven digit number totals a multiple of ten" {
    assert_eq(luhn_total("79927398713"), 70);
    assert(verify("79927398713"));
    assert_eq(verify_pair("7992739871", 3), true);
    assert_eq(check_digit("7992739871"), 3);
    assert_eq(last_digit("79927398713"), 3)
}

test "a fifteen digit payload totals what the rule says" {
    assert_eq(luhn_total("601100099013942"), 53);
    assert_eq(check_digit("601100099013942"), 4);
    assert_eq(verify_pair("601100099013942", 4), true)
}

test "the check digit of a long payload is the completing digit" {
    assert_eq(check_digit("45395787636214"), 9);
    assert_eq(verify_pair("45395787636214", 9), true);
    assert_eq(verify_pair("45395787636214", 3), false);
    assert(verify("453957876362149"));
    assert_eq(check_digit("12345678901234"), 7);
    assert(verify("123456789012347"));
    assert_eq(check_digit("30569309025904"), 9);
    assert(verify("305693090259049"))
}

test "short payloads of every length still complete" {
    assert_eq(check_digit("18"), 2);
    assert(verify("182"));
    assert_eq(check_digit("4905"), 6);
    assert(verify("49056"));
    assert_eq(check_digit("2024"), 8);
    assert(verify("20248"));
    assert_eq(check_digit("453957876362148"), 6);
    assert(verify("4539578763621486"))
}

test "an even length number is unaffected" {
    assert_eq(luhn_total("4539578763621486"), 80);
    assert_eq(luhn_total("6011000990139424"), 50);
    assert_eq(luhn_total("4012888888881881"), 90);
    assert_eq(luhn_total("2024"), 12);
    assert_eq(luhn_total("490540"), 30);
    assert(verify("490540"))
}
