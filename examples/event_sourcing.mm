// An append-only event log folded into state: the server row. The log is the
// source of truth, `replay` is the only way to read it, and every event is
// @wire so the same bytes can cross a process boundary.

@wire
type Event =
    Deposited { amount: u32 }
  | Withdrawn { amount: u32 }
  | Closed { }

type Account = { balance: u32, deposits: u32, withdrawals: u32, closed: u8 }

const TAG_DEPOSIT: u8 = 1
const TAG_WITHDRAW: u8 = 2
const TAG_CLOSE: u8 = 3

fn blank_account() -> Account {
    Account { balance: 0, deposits: 0, withdrawals: 0, closed: 0 }
}

fn closed_event() -> Event {
    Closed { }
}

// The wire encoding: one tag byte, then the payload.
fn encode(e: Event, out: view mut [u8]) -> usize {
    match e {
        Deposited { amount } => { out[0] = TAG_DEPOSIT; out[1] = amount as u8; 2 },
        Withdrawn { amount } => { out[0] = TAG_WITHDRAW; out[1] = amount as u8; 2 },
        Closed { } => { out[0] = TAG_CLOSE; 1 }
    }
}

fn tag_of(e: Event) -> u8 {
    match e {
        Deposited { amount } => TAG_DEPOSIT,
        Withdrawn { amount } => TAG_WITHDRAW,
        Closed { } => TAG_CLOSE
    }
}

// One transition. State is threaded through, so replay is just a fold.
fn apply(a: view mut Account, e: Event) -> Account {
    match e {
        Deposited { amount } => {
            a.balance = a.balance + amount;
            a.deposits = a.deposits + 1;
        },
        Withdrawn { amount } => {
            a.balance = a.balance - amount;
            a.withdrawals = a.withdrawals + 1;
        },
        Closed { } => { a.closed = 1 }
    };
    a
}

fn replay(log: view [Event]) -> Account {
    let mut a = blank_account(); let mut i = 0;
    while i < log.len() {
        apply(a, log[i]);
        i += 1;
    };
    a
}

fn total_deposited(a: Account) -> u32 {
    a.balance + a.withdrawals
}

test "replaying a log folds the state" {
    let mut log: [Event; 4] = [closed_event(), closed_event(), closed_event(), closed_event()];
    log[0] = Deposited { amount: 100 };
    log[1] = Withdrawn { amount: 30 };
    log[2] = Deposited { amount: 5 }; let a = replay(log); assert_eq(a.balance, 75); assert_eq(a.deposits, 2);
    assert_eq(a.withdrawals, 1); assert_eq(a.closed, 1)
}

test "closing the account is a fold like any other" {
    let mut log: [Event; 2] = [closed_event(), closed_event()];
    log[0] = Deposited { amount: 10 }; let a = replay(log); assert_eq(a.closed, 1);
    assert_eq(total_deposited(a), 10)
}

test "the wire form round-trips through tags" {
    let mut buf: [u8] = [0, 0, 0, 0]; let e = Deposited { amount: 7 }; assert_eq(encode(e, buf), 2);
    assert_eq(tag_of(e), 1); assert_eq(buf[1], 7); let done = closed_event(); assert_eq(encode(done, buf), 1);
    assert_eq(tag_of(done), 3)
}
