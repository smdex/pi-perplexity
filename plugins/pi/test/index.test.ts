import { describe, expect, test } from "./test-helpers.js";

describe("extension entrypoint", () => {
  test("registers the perplexity_search tool and no slash commands", async () => {
    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    const commands: string[] = [];
    const tools: string[] = [];

    registerExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
    } as any);

    expect(tools).toEqual(["perplexity_search"]);
    expect(commands).toEqual([]);
  });

  test("tool schema covers the CLI-supported options plus overrides", async () => {
    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    let schema: unknown;
    registerExtension({
      registerTool(tool: { parameters: unknown }) {
        schema = tool.parameters;
      },
    } as any);

    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const key of ["query", "files", "thread", "continue", "recency", "limit", "model", "sources", "space"]) {
      expect(props[key]).toBeDefined();
    }
  });
});
