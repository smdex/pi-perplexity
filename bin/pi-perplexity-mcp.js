#!/usr/bin/env node
// MCP server launcher for pi-perplexity.
//
// Registers jiti's TypeScript loader, then loads the TS server entry and runs
// it. jiti is a declared runtime dependency (not a deep node_modules path), so
// this shim is stable across upgrades. Requires Node >= 22 (fastmcp-ts).
//
// The static import of "jiti/register" is evaluated before this module's body,
// installing the loader hook in time for the dynamic import of the .ts entry.
import "jiti/register";

// jiti/register compiles TS to a CommonJS namespace exposed as the ESM
// `default` export, so destructure main() off it.
const { main } = (await import("../src/mcp/server.ts")).default;

await main();
