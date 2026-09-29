// case: Cap constructed from a value - expect E0602 (static)
//
// Capability non-escalation (kernel.md §6.3): a `Cap<E>` may only be *received*
// from a caller or granted by a trusted host. There is no syntax that builds one
// from a value, so a classifier score can never become authority.
fn score_is_authority(s: f32) -> Cap<bank.transfer> {
    Cap { name: "bank.transfer" }
}
