import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const appBundlePath =
  process.env.GC_SMOKE_APP_BUNDLE ||
  join(root, "src-tauri", "target", "release", "bundle", "macos", "GC Console.app");
const appExecutablePath = join(appBundlePath, "Contents", "MacOS", "app");
const releaseBinaryPath =
  process.env.GC_SMOKE_RELEASE_BINARY || join(root, "src-tauri", "target", "release", "app");
const nodeSidecarPath = join(appBundlePath, "Contents", "MacOS", "node-sidecar");
const bundledBackendRoot = join(appBundlePath, "Contents", "Resources", "_up_");
const healthcheckUrl = process.env.GC_SMOKE_HEALTH_URL || "http://127.0.0.1:3131/api/health";
const dashboardUrl = process.env.GC_SMOKE_DASHBOARD_URL || "http://127.0.0.1:3131/";
const timeoutMs = Number.parseInt(process.env.GC_SMOKE_TIMEOUT_MS || "30000", 10);

let appProcess = null;

function ensureExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}\nRun "npm run tauri:build:adhoc" first.`);
  }
}

function tryRun(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (error.status === 1) {
      return error.stdout?.toString?.().trim?.() || "";
    }
    throw error;
  }
}

function pidsOnPort3131() {
  const output = tryRun("/usr/sbin/lsof", ["-ti", "tcp:3131"]);
  return output
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminatePidList(pids, signal, waitMs) {
  if (pids.length === 0) {
    return;
  }

  execFileSync("/bin/kill", [`-${signal}`, ...pids], {
    cwd: root,
    stdio: "ignore",
  });

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

async function terminateProcessesOnPort3131() {
  const initialPids = pidsOnPort3131();
  if (initialPids.length === 0) {
    return;
  }

  await terminatePidList(initialPids, "TERM", 1000);

  const remainingPids = pidsOnPort3131();
  if (remainingPids.length > 0) {
    await terminatePidList(remainingPids, "KILL", 250);
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`Unexpected ${response.status} from ${url}`);
  }
  return response.text();
}

async function waitForHealthcheck() {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const body = await fetchText(healthcheckUrl);
      if (body.includes('"ok":true')) {
        return body;
      }
      lastError = new Error(`Healthcheck returned unexpected body: ${body}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${healthcheckUrl}: ${lastError?.message || "unknown error"}`);
}

async function cleanup() {
  if (appProcess && !appProcess.killed) {
    appProcess.kill("SIGTERM");
    await sleep(1000);
    if (appProcess.exitCode === null && appProcess.signalCode === null) {
      appProcess.kill("SIGKILL");
    }
  }
  await terminateProcessesOnPort3131();
}

async function main() {
  ensureExists(appBundlePath, "App bundle");
  ensureExists(appExecutablePath, "App executable");
  ensureExists(releaseBinaryPath, "Release binary");
  ensureExists(nodeSidecarPath, "Bundled node-sidecar");
  ensureExists(bundledBackendRoot, "Bundled backend root");

  await terminateProcessesOnPort3131();

  let stdout = "";
  let stderr = "";

  appProcess = spawn(releaseBinaryPath, [], {
    cwd: root,
    env: {
      ...process.env,
      GC_CLI_SMOKE: "1",
      GC_SMOKE_NODE_PATH: nodeSidecarPath,
      GC_SMOKE_BACKEND_ROOT: bundledBackendRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  appProcess.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  appProcess.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealthcheck();
    const dashboard = await fetchText(dashboardUrl);
    if (!dashboard.includes("GC Console")) {
      throw new Error(`Dashboard HTML did not contain expected marker at ${dashboardUrl}`);
    }

    console.log("CLI smoke test passed");
    console.log(`App bundle: ${appBundlePath}`);
    console.log(`Release binary: ${releaseBinaryPath}`);
    console.log(`Healthcheck: ${healthcheckUrl}`);
  } catch (error) {
    if (stdout.trim()) {
      console.error("\n--- app stdout ---");
      console.error(stdout.trim());
    }
    if (stderr.trim()) {
      console.error("\n--- app stderr ---");
      console.error(stderr.trim());
    }
    throw error;
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
