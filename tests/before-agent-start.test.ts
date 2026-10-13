import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("custom-message turns do not replace the tracked user prompt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "powerline-before-agent-start-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, "settings.json"), JSON.stringify({ powerline: { welcome: false } }));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const { default: extension } = await import("../index.ts");
  const handlers = new Map<string, (event: object, context: object) => unknown>();
  (extension as unknown as (api: object) => void)({
    on: (name: string, handler: (event: object, context: object) => unknown) => handlers.set(name, handler),
    registerCommand() {},
    sendUserMessage() {},
    getCommands: () => [],
  });
  const ctx = { cwd: root, hasUI: false, sessionManager: { getBranch: () => [], getSessionId: () => "test", getCwd: () => root } };
  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(beforeAgentStart);

  // Pi 1.2 fires before_agent_start for extension-triggered custom turns without a prompt.
  await assert.doesNotReject(async () => {
    await beforeAgentStart({ prompt: "Fix the checkout bug" }, ctx);
    await beforeAgentStart({
      type: "before_agent_start",
      messageType: "custom",
      message: { role: "custom", customType: "subagent_complete", content: "Finished", display: true },
      systemPrompt: "System prompt",
    }, ctx);
  });
});
