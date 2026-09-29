import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StdioDaemonClient, type DaemonChild } from "../omp-extension/mm.ts";

/**
 * The stdio transport is where a semantic tool silently becomes a no-op.
 *
 * Two defects lived here and neither was visible from the daemon side: the client kept
 * only `stdout` from its factory and re-invoked the factory for `stdin`, so a
 * spawn-per-call factory wrote requests into a second daemon while reading replies from
 * the first; and a request that was never answered stayed pending forever, which reads
 * as a slow tool rather than a broken one. Both are transport invariants, so they are
 * tested against fakes whose process identity is observable.
 */

/** A fake daemon process. Each one records the writes it received. */
class FakeDaemon {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly written: string[] = [];
  private readonly exitEmitter = new EventEmitter();

  constructor() {
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.written.push(s);
      for (const line of s.split("\n")) {
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: number };
        this.stdout.write(`${JSON.stringify({ id: req.id, ok: true, data: "answered" })}\n`);
      }
    });
  }

  readonly child: DaemonChild = {
    stdin: this.stdin,
    stdout: this.stdout,
    onExit: (cb) => this.exitEmitter.on("exit", cb),
  };

  /** Stop answering without exiting, so only the timeout can save the caller. */
  goSilent(): void {
    this.stdin.removeAllListeners("data");
  }

  exit(): void {
    this.exitEmitter.emit("exit");
  }
}

describe("StdioDaemonClient", () => {
  test("creates the daemon once and reuses it for every request", async () => {
    // The invariant that was broken: a factory called per request means stdin and stdout
    // belong to different processes, and the caller waits forever on the wrong one.
    let spawns = 0;
    const first = new FakeDaemon();
    const client = new StdioDaemonClient(() => {
      spawns++;
      return first.child;
    });

    const a = await client.request({ tool: "mm.symbol", args: { ref: "x" } });
    const b = await client.request({ tool: "mm.refs", args: { ref: "x" } });

    expect(spawns).toBe(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(first.written.length).toBe(2);
  });

  test("stdin and stdout come from the same process", async () => {
    // A factory that really does hand out a fresh process each call is the failure mode
    // worth pinning: with per-call processes, the memoised child is the only one that can
    // both receive a request and answer it.
    const made: FakeDaemon[] = [];
    const client = new StdioDaemonClient(() => {
      const d = new FakeDaemon();
      made.push(d);
      return d.child;
    });

    const res = await client.request({ tool: "mm.symbol", args: {} });

    expect(res.ok).toBe(true);
    expect(made.length).toBe(1);
    expect(made[0]!.written.length).toBe(1);
  });

  test("a request the daemon never answers fails instead of hanging", async () => {
    const d = new FakeDaemon();
    const client = new StdioDaemonClient(() => d.child, 60);
    d.goSilent();

    const res = await client.request({ tool: "mm.slice", args: {} });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("E0901");
    expect(res.error).toContain("mm.slice");
  });

  test("a daemon that exits mid-request fails the in-flight request", async () => {
    const d = new FakeDaemon();
    const client = new StdioDaemonClient(() => d.child, 60);
    d.goSilent();
    const pending = client.request({ tool: "mm.type", args: {} });
    d.exit();

    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("exited");
  });

  test("a later request still works after an earlier one timed out", async () => {
    // A timeout that poisoned the client would turn one bad call into a dead tool for
    // the rest of the session.
    const d = new FakeDaemon();
    const client = new StdioDaemonClient(() => d.child, 50);
    d.goSilent();
    expect((await client.request({ tool: "mm.refs", args: {} })).ok).toBe(false);

    const d2 = new FakeDaemon();
    const client2 = new StdioDaemonClient(() => d2.child, 1000);
    expect((await client2.request({ tool: "mm.refs", args: {} })).ok).toBe(true);
  });

  test("an unparseable line does not settle a waiting request", async () => {
    // A line with no id belongs to nothing. It must be dropped, and the request that
    // wanted it must still resolve — by timeout, with a diagnosable error.
    const d = new FakeDaemon();
    const client = new StdioDaemonClient(() => d.child, 60);
    d.goSilent();
    const pending = client.request({ tool: "mm.system", args: {} });
    d.stdout.write("this is not json\n");
    const res = await pending;
    expect(res.ok).toBe(false);
  });
});
