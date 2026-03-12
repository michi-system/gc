import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

const root = process.cwd();
const appPath = join(root, "src-tauri", "target", "release", "bundle", "macos", "GC Console.app");
const dmgPath = join(root, "src-tauri", "target", "release", "bundle", "dmg", "GC Console_0.1.0_aarch64.dmg");

function sign(target, args) {
  execFileSync("codesign", args, {
    stdio: "inherit",
  });
  console.log(`Ad-hoc signed ${target}`);
}

if (existsSync(appPath)) {
  sign(appPath, ["--force", "--deep", "--sign", "-", appPath]);
}

if (existsSync(dmgPath)) {
  sign(dmgPath, ["--force", "--sign", "-", dmgPath]);
}
