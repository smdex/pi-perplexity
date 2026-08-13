import { describe, expect, test } from "../test-helpers.js";

import { createServer, deepInput, searchInput } from "../../src/mcp/server.js";

const CFG = { model: "pplx_pro_upgraded", deepModel: "pplx_alpha" };

describe("createServer", () => {
  test("returns a FastMCP server with tool and run methods", () => {
    const server = createServer({ config: CFG });
    expect(server).toBeTruthy();
    expect(typeof server.tool).toBe("function");
    expect(typeof server.run).toBe("function");
    expect(typeof server.getContext).toBe("function");
  });
});

describe("searchInput schema", () => {
  test("rejects missing query", () => {
    expect(() => searchInput.parse({})).toThrow();
  });

  test("rejects empty query", () => {
    expect(() => searchInput.parse({ query: "" })).toThrow();
  });

  test("accepts a bare query", () => {
    expect(searchInput.parse({ query: "hello" })).toMatchObject({ query: "hello" });
  });

  test("rejects invalid recency", () => {
    expect(() => searchInput.parse({ query: "x", recency: "decade" })).toThrow();
  });

  test("rejects out-of-range or non-integer limit", () => {
    expect(() => searchInput.parse({ query: "x", limit: 0 })).toThrow();
    expect(() => searchInput.parse({ query: "x", limit: 51 })).toThrow();
    expect(() => searchInput.parse({ query: "x", limit: 1.5 })).toThrow();
  });

  test("accepts full valid input", () => {
    expect(searchInput.parse({ query: "x", recency: "week", limit: 10 })).toMatchObject({
      query: "x",
      recency: "week",
      limit: 10,
    });
  });
});

describe("deepInput schema", () => {
  test("accepts optional model override", () => {
    expect(deepInput.parse({ query: "x", model: "pplx_alpha" })).toMatchObject({ query: "x", model: "pplx_alpha" });
  });

  test("model is optional", () => {
    expect(deepInput.parse({ query: "x" })).toMatchObject({ query: "x" });
  });
});
