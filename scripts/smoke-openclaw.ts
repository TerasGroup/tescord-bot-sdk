import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "nekord-openclaw-smoke-"),
);
const configFile = path.join(directory, "openclaw.json");
const plugin = path.resolve("packages/openclaw-channel");
await fs.writeFile(
  configFile,
  JSON.stringify({
    plugins: {
      allow: ["nekord"],
      load: { paths: [plugin] },
      entries: { nekord: { enabled: true } },
    },
    channels: {
      nekord: {
        enabled: true,
        serverUrl: "https://nekord.example.invalid",
        allowFrom: ["*"],
      },
    },
  }),
);
const env: NodeJS.ProcessEnv = {
  OPENCLAW_STATE_DIR: directory,
  OPENCLAW_CONFIG_PATH: configFile,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  NO_COLOR: "1",
};
for (const key of [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATHEXT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
])
  if (process.env[key]) env[key] = process.env[key];
await fs.mkdir("test-results", { recursive: true });
try {
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules/openclaw/openclaw.mjs"),
        "plugins",
        "inspect",
        "nekord",
        "--runtime",
        "--json",
      ],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("OPENCLAW_SMOKE_TIMEOUT"));
    }, 55000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  await fs.writeFile(
    "test-results/openclaw-cli.log",
    result.stdout + "\n" + result.stderr,
  );
  assert.equal(result.status, 0, result.stderr);
  const start = result.stdout.indexOf("{");
  const details: unknown = JSON.parse(result.stdout.slice(start));
  assert.ok(details && typeof details === "object");
  const outer = details as Record<string, unknown>;
  const record = (outer.plugin ?? outer) as Record<string, unknown>;
  assert.equal(record.id, "nekord");
  assert.equal(record.status, "loaded", JSON.stringify(details));
  assert.equal(record.imported, true, JSON.stringify(details));
  if (Array.isArray(record.channelIds))
    assert.ok(record.channelIds.includes("nekord"));
  console.log(
    "PASS OpenClaw 2026.10.9: CLI discovery, manifest/config validation and runtime entry registration; no model request",
  );
} finally {
  if (
    path.dirname(directory) === os.tmpdir() &&
    path.basename(directory).startsWith("nekord-openclaw-smoke-")
  )
    await fs.rm(directory, { recursive: true, force: true });
}
