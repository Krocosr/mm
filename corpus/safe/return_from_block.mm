// safe: a value constructed inside a nested scope is returned out of it.
// Nothing viewable into the inner scope escapes; the returned `Config` is
// owned, and the inner block's region ends at the return.
type Config = { retries: u32, timeout_ms: u32 }

fn default_config() -> Config {
    let retries = 3;
    let c = Config { retries: retries, timeout_ms: 5000 };
    c
}
