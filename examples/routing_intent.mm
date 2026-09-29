// Agent routing: the decision surface, not the execution path. A `choice` type
// is the routing enum the System Plan renders as a schema, and `@intent` marks
// the functions the agent runtime may call. The effect row is the contract -
// `agent` and `nondet` say the answer may differ between calls, `clock` says it
// may depend on when it was asked.

type Route = choice { fast, deep, reject }

type Ticket = { id: u32, lines: u32, urgent: u8 }

const DEEP_THRESHOLD: u32 = 500

fn route_name(r: Route) -> Text {
    match r {
        fast => "fast",
        deep => "deep",
        reject => "reject"
    }
}

fn is_expensive(r: Route) -> bool {
    match r {
        deep => true,
        fast => false,
        reject => false
    }
}

// The deterministic rule the provider is expected to reproduce. A checker can
// compare the two without executing the model.
fn triage_checked(t: Ticket) -> Route {
    if t.urgent == 1 { return fast };
    if t.lines > DEEP_THRESHOLD { return deep };
    fast
}

@intent
fn triage(t: Ticket) -> Decision<Route> !{agent, nondet, clock} {
    let mut route = triage_checked(t);
    if t.id == 0 { route = reject }; let d = Decision { value: route, confidence: 0.9 };
    d
}

// The escalation path: a second intent with a narrower effect set.
@intent
fn escalate(t: Ticket) -> Decision<Route> !{agent, nondet} {
    let d = Decision { value: deep, confidence: 0.5 };
    d
}

fn confidence_of(d: Decision<Route>) -> f32 {
    d.confidence
}

fn chosen_route(d: Decision<Route>) -> Route {
    d.value
}

test "a small ticket takes the fast path" {
    let t = Ticket { id: 7, lines: 12, urgent: 0 }; let d = triage(t);
    assert_eq(route_name(chosen_route(d)), "fast"); assert(confidence_of(d) > 0.5);
    assert_eq(is_expensive(chosen_route(d)), false)
}

test "a large ticket escalates to the deep path" {
    let t = Ticket { id: 8, lines: 5000, urgent: 0 }; assert_eq(route_name(chosen_route(triage(t))), "deep");
    assert(is_expensive(chosen_route(escalate(t)))); assert_eq(route_name(chosen_route(escalate(t))), "deep")
}

test "the deterministic rule matches the intent" {
    let small = Ticket { id: 1, lines: 10, urgent: 0 }; let large = Ticket { id: 2, lines: 900, urgent: 0 };
    assert_eq(route_name(triage_checked(small)), "fast");
    let anonymous = Ticket { id: 0, lines: 1, urgent: 0 };
    assert_eq(route_name(chosen_route(triage(anonymous))), "reject")
}
