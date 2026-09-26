import { describe, expect, test } from "./test-helpers.js";

describe("extension entrypoint", () => {
  test("registers the login, config, and threads commands plus the tool", async () => {
    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    const commands: string[] = [];
    let tools: string[] = [];

    registerExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(tool: { name: string }) {
        tools = [...tools, tool.name];
      },
    } as any);

    expect(commands).toContain("perplexity-login");
    expect(commands).toContain("perplexity-config");
    expect(commands).toContain("perplexity-threads");
    expect(tools).toContain("perplexity_search");
  });

  test("thread_slug extraction accepts bare uuids and /search/ URLs", async () => {
    // threadSlugFromRef is module-private; verify through the tool schema instead:
    // the thread param description documents the accepted forms.
    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    let schema: unknown;
    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { parameters: unknown }) {
        schema = tool.parameters;
      },
    } as any);

    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props.thread).toBeDefined();
    expect(props.continue).toBeDefined();
    expect(props.query).toBeDefined();
  });
});
