import type { CommandModule } from "yargs";
import { completionScript, shellFromEnv, type ShellName } from "../complete.js";
import { out } from "./util.js";

/**
 * pplx completion [bash|zsh|fish] — emit a completion script for an explicit
 * shell (yargs' built-in generator picks from $SHELL and ignores a positional
 * shell name, so this command renders the scripts itself). The scripts call
 * `pplx --get-yargs-completions` at TAB time; dynamic candidates come from
 * complete.ts.
 */
export const completionCommand: CommandModule = {
  command: "completion [shell]",
  describe: `emit a shell completion script (bash, zsh, or fish; default: detected from $SHELL — currently ${shellFromEnv()})`,
  builder: (y) =>
    y.positional("shell", {
      type: "string",
      choices: ["bash", "zsh", "fish"],
      describe: "target shell",
    }),
  handler: (argv) => {
    const shell = (typeof argv.shell === "string" ? argv.shell : shellFromEnv()) as ShellName;
    out(completionScript(shell));
  },
};
