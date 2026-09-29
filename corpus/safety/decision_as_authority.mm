// case: Decision used as authority - expect E0601 (static)
//
// Trust monotonicity (kernel.md §4.5): a `Decision<T>` is typed but *untrusted*.
// Promoting it to `Verified<T>` is only legal inside a `verify` function that
// performed deterministic checks. Forging the promotion here is what lets a
// model's confidence score stand in for a bank's authorization.
type Approval = { amount: u64 }

@intent
pub fn approve(amount: u64) -> Decision<Approval> !{agent, nondet} {
    Decision { value: Approval { amount: amount }, confidence: 0.9 }
}

fn forged(d: view Decision<Approval>) -> Verified<Approval> !{agent, nondet} {
    Verified { value: d.value }
}
