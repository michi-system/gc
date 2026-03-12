import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const appPath =
  process.argv[2] || join(process.cwd(), "src-tauri", "target", "release", "bundle", "macos", "GC Console.app");
const dmgPath =
  process.argv[3] || join(process.cwd(), "src-tauri", "target", "release", "bundle", "dmg", "GC Console_0.1.0_aarch64.dmg");

function printHeader(title) {
  console.log(`\n=== ${title} ===`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function tryRun(command, args) {
  try {
    return { ok: true, output: run(command, args) };
  } catch (error) {
    return {
      ok: false,
      output: error.stdout?.toString?.() || "",
      error: error.stderr?.toString?.() || error.message,
    };
  }
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function report(result) {
  if (result.ok) {
    console.log("OK");
    if (result.output) {
      console.log(result.output);
    }
    return;
  }

  console.log("NG");
  if (result.output) {
    console.log(result.output);
  }
  if (result.error) {
    console.log(result.error);
  }
  process.exitCode = 1;
}

try {
  assertExists(appPath, "App bundle");
  printHeader("App bundle");
  console.log(appPath);

  printHeader("codesign identity");
  report(tryRun("codesign", ["-dv", "--verbose=4", appPath]));

  printHeader("codesign verify");
  report(tryRun("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]));

  printHeader("Gatekeeper");
  report(tryRun("spctl", ["-a", "-vv", "-t", "exec", appPath]));

  printHeader("Stapler validate (app)");
  report(tryRun("xcrun", ["stapler", "validate", appPath]));

  if (existsSync(dmgPath)) {
    printHeader("DMG");
    console.log(dmgPath);

    printHeader("codesign verify (dmg)");
    report(tryRun("codesign", ["--verify", "--verbose=2", dmgPath]));

    printHeader("Stapler validate (dmg)");
    report(tryRun("xcrun", ["stapler", "validate", dmgPath]));
  } else {
    printHeader("DMG");
    console.log(`Skipping; not found: ${dmgPath}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
