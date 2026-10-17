import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/**
 * A docker exec child for launchRuntime tests. Its stdin is captured, `answer` runs once the context is written,
 * and its stdout and exit are the test's to script. kill ends it the way SIGKILL would.
 */
export class FakeExecChild extends EventEmitter {
  /** What was written to stdin, in order. */
  readonly input: string[] = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.input.push(chunk.toString("utf8"));
      callback();
    },
  });
  killed: string | null = null;

  constructor(answer: (child: FakeExecChild) => void) {
    super();
    this.stdin.on("finish", () => answer(this));
  }

  kill(signal: string): boolean {
    this.killed = signal;
    this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: string | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  /** Viewed as the process handle launchRuntime is given. */
  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}
