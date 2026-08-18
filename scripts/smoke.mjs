// Smoke test: spawns the built stdio MCP server, drives it through initialize -> initialized ->
// tools/list over JSON-RPC (newline-delimited), and prints the registered tool names.
// Exits 0 on success within 10s, non-zero otherwise.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "server.js");

const TIMEOUT_MS = 10_000;

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

async function main() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderrBuffer = "";
  const responses = new Map();
  const waiters = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        console.error("Failed to parse line from server stdout:", line);
        continue;
      }
      if (msg.id !== undefined) {
        responses.set(msg.id, msg);
        const waiter = waiters.get(msg.id);
        if (waiter) waiter(msg);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf-8");
  });

  function waitForResponse(id) {
    if (responses.has(id)) return Promise.resolve(responses.get(id));
    return new Promise((resolve) => waiters.set(id, resolve));
  }

  const timeout = setTimeout(() => {
    console.error("Smoke test timed out after 10s.");
    if (stderrBuffer) console.error("--- server stderr ---\n" + stderrBuffer);
    child.kill();
    process.exit(1);
  }, TIMEOUT_MS);

  try {
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.1" },
      },
    });
    const initResponse = await waitForResponse(1);
    if (initResponse.error) {
      throw new Error("initialize failed: " + JSON.stringify(initResponse.error));
    }

    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResponse = await waitForResponse(2);
    if (toolsResponse.error) {
      throw new Error("tools/list failed: " + JSON.stringify(toolsResponse.error));
    }

    const names = (toolsResponse.result?.tools ?? []).map((t) => t.name);
    console.log("Registered tools (" + names.length + "):");
    for (const name of names) {
      console.log("  - " + name);
    }

    clearTimeout(timeout);
    child.kill();
    process.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    console.error("Smoke test failed:", err);
    if (stderrBuffer) console.error("--- server stderr ---\n" + stderrBuffer);
    child.kill();
    process.exit(1);
  }
}

main();
