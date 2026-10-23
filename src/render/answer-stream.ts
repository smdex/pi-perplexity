import { stripVTControlCharacters } from "node:util";

/**
 * Preview in an alternate screen so revisions never erase surrounding output,
 * even after wrapping, resizing, or scrolling beyond the terminal's height.
 * No cursor hiding, saved row counts, or Unicode width assumptions. On success
 * restore the original screen and print the final answer there exactly once.
 * Redirected output is deliberately buffered: emitted bytes cannot be revised.
 */
export class AnswerStreamPrinter {
  private preview: string | null = null;
  private active = false;

  constructor(private readonly stdout: { write(text: string): unknown }) {}

  update(text: string): void {
    // Server text must not be able to exit the preview or move the cursor.
    const safe = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (safe === this.preview || (safe === "" && !this.active)) return;
    if (!this.active) {
      this.stdout.write("\x1b[?1049h");
      this.active = true;
    }
    this.stdout.write(`\x1b[H\x1b[2J${safe}`);
    this.preview = safe;
  }

  finish(text: string): void {
    this.restore();
    this.stdout.write(text);
  }

  restore(): void {
    if (!this.active) return;
    this.stdout.write("\x1b[?1049l");
    this.active = false;
  }
}
