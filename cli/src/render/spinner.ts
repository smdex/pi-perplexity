/**
 * stderr-only inline spinner (plan §4.11). Keeps stdout clean for piped
 * answer text (`pplx ask … | tee answer.md`). No-op when stderr is not a TTY
 * or PPLX_NO_SPINNER=1 is set.
 */

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function enabled(): boolean {
  return process.stderr.isTTY === true && process.env.PPLX_NO_SPINNER !== "1";
}

export class StderrSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private lastLine = "";
  /** True while a spinner frame is on screen and not yet cleared. */
  private visible = false;

  constructor(private readonly frames: string[] = DEFAULT_FRAMES) {}

  start(msg: string): void {
    if (!enabled() || this.timer !== null) return;
    this.lastLine = msg;
    this.visible = true;
    const tick = (): void => {
      const glyph = this.frames[this.frame % this.frames.length] ?? "";
      this.frame++;
      process.stderr.write(`\r${glyph} ${msg}`);
    };
    tick();
    this.timer = setInterval(tick, 90);
  }

  /** Update the message in place (keeps spinning). */
  update(msg: string): void {
    this.lastLine = msg;
  }

  /**
   * Stop and clear the spinner line. Idempotent AND write-free when already
   * stopped: the clear sequence (\r + spaces + \r) erases the first N columns
   * of whatever else is on screen (answer text on a shared tty), so emitting
   * it with no spinner visible corrupts that output (ask.ts used to print
   * answer prefixes repeatedly for exactly this reason).
   */
  stop(final?: string): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!enabled()) {
      if (final !== undefined && final.length > 0) process.stderr.write(`${final}\n`);
      return;
    }
    if (this.visible) {
      this.visible = false;
      process.stderr.write(`\r${" ".repeat(Math.max(this.lastLine.length + 2, final?.length ?? 0))}\r`);
    }
    if (final !== undefined && final.length > 0) process.stderr.write(`${final}\n`);
  }
}
