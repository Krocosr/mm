use tally

// The grading suite for `tally.mm`. Every key here is chosen so that its probe
// run reaches the end of the slot array, which is the case the walk has to get
// right for a count to survive.

test "a run that reaches the end of the table still finds its key" {
    let mut t = new_table();
    assert_eq(tally(t, [2, 18, 34]), 3);
    assert_eq(count_of(t, 2), 1);
    assert_eq(count_of(t, 18), 1);
    assert_eq(count_of(t, 34), 1);
    assert_eq(distinct(t), 3)
}

test "recounting the same keys does not create new entries" {
    let mut t = new_table();
    assert_eq(tally(t, [2, 18, 34]), 3);
    assert_eq(tally(t, [2, 18, 34]), 3);
    assert_eq(distinct(t), 3);
    assert_eq(count_of(t, 2), 2);
    assert_eq(count_of(t, 18), 2);
    assert_eq(count_of(t, 34), 2);
    assert_eq(total(t), 6)
}

test "a run of six keys past the end of the table is fully readable" {
    let mut t = new_table(); let mut i = 0;
    while i < 6 {
        let k: u32 = 2 + (i as u32) * 16;
        assert(add(t, k));
        i += 1;
    };
    assert_eq(distinct(t), 6);
    assert_eq(total(t), 6);
    assert_eq(count_of(t, 2), 1);
    assert_eq(count_of(t, 18), 1);
    assert_eq(count_of(t, 34), 1);
    assert_eq(count_of(t, 50), 1);
    assert_eq(count_of(t, 66), 1);
    assert_eq(count_of(t, 82), 1)
}

test "a run that starts in the last slot is fully readable" {
    let mut t = new_table(); let mut i = 0;
    while i < 6 {
        let k: u32 = 9 + (i as u32) * 16;
        assert(add(t, k));
        i += 1;
    };
    assert_eq(distinct(t), 6);
    assert_eq(count_of(t, 9), 1);
    assert_eq(count_of(t, 25), 1);
    assert_eq(count_of(t, 41), 1);
    assert_eq(count_of(t, 57), 1);
    assert_eq(count_of(t, 73), 1);
    assert_eq(count_of(t, 89), 1)
}

test "a wrapped run keeps recounting the same keys" {
    let mut t = new_table();
    assert_eq(tally(t, [2, 18, 34, 50, 34, 50, 34, 50]), 8);
    assert_eq(distinct(t), 4);
    assert_eq(count_of(t, 2), 1);
    assert_eq(count_of(t, 18), 1);
    assert_eq(count_of(t, 34), 3);
    assert_eq(count_of(t, 50), 3);
    assert_eq(total(t), 8);
    assert_eq(busiest(t), 3)
}

test "a mixed stream keeps every key readable" {
    let mut t = new_table();
    assert_eq(tally(t, [1, 2, 18, 5, 34, 9, 50, 3]), 8);
    assert_eq(distinct(t), 8);
    assert_eq(total(t), 8);
    assert_eq(count_of(t, 1), 1);
    assert_eq(count_of(t, 2), 1);
    assert_eq(count_of(t, 18), 1);
    assert_eq(count_of(t, 5), 1);
    assert_eq(count_of(t, 34), 1);
    assert_eq(count_of(t, 9), 1);
    assert_eq(count_of(t, 50), 1);
    assert_eq(count_of(t, 3), 1)
}
