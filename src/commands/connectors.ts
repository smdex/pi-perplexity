import type { CommandModule } from "yargs";
import { listConnectors } from "../api/sources.js";
import { BUILTIN_SOURCES } from "../constants.js";
import { out, run } from "./util.js";

/**
 * pplx connectors [--all] — GET /rest/sources. Default shows connected sources
 * only; --all shows the catalog (limit 40). Ids feed `pplx ask --sources`.
 */
export const connectorsCommand: CommandModule = {
  command: "connectors",
  describe: "list sources/connectors (ids usable in `pplx ask --sources`)",
  builder: (y) =>
    y
      .option("all", { type: "boolean", describe: "include disconnected connectors" })
      .option("json", { type: "boolean", describe: "print JSON" }),
  handler: async (argv) => {
    await run(argv.json === true, async () => {
      const connectors = await listConnectors({ connectedOnly: argv.all !== true });
      if (argv.json) {
        out(JSON.stringify(connectors));
        return;
      }
      if (connectors.length === 0) {
        out(argv.all ? "no connectors found" : "no connected connectors (try --all for the catalog)");
        return;
      }
      const rows = connectors.map((c) => {
        const builtin = (BUILTIN_SOURCES as readonly string[]).includes(c.id) ? " [builtin]" : "";
        const auth = c.authType ? ` (${c.authType})` : "";
        return `${c.id}${builtin}${auth} — ${c.displayName}`;
      });
      out(rows.join("\n"));
    });
  },
};
