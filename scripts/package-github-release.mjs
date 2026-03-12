import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const releaseDir = join(root, "release", "github");
const appName = "GC Console";
const appBundlePath = join(root, "src-tauri", "target", "release", "bundle", "macos", `${appName}.app`);
const dmgPath = join(root, "src-tauri", "target", "release", "bundle", "dmg", `${appName}_${version}_aarch64.dmg`);
const zipPath = join(releaseDir, `${appName}_${version}_macOS.zip`);
const stagedDmgPath = join(releaseDir, `${appName}_${version}_macOS.dmg`);
const checksumsPath = join(releaseDir, "SHA256SUMS.txt");
const installGuidePath = join(releaseDir, "INSTALL_MAC.md");

function ensureExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

ensureExists(appBundlePath, "App bundle");
ensureExists(dmgPath, "DMG");

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

cpSync(dmgPath, stagedDmgPath);

execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appBundlePath, zipPath], {
  cwd: root,
  stdio: "inherit",
});

const dmgSha = run("shasum", ["-a", "256", stagedDmgPath]);
const zipSha = run("shasum", ["-a", "256", zipPath]);
writeFileSync(checksumsPath, `${dmgSha}\n${zipSha}\n`);

writeFileSync(
  installGuidePath,
  `# Install GC Console on macOS

## Download

- Download either \`${appName}_${version}_macOS.dmg\` or \`${appName}_${version}_macOS.zip\` from GitHub Releases.
- DMG is easier for normal install. ZIP is useful when DMG mounting is blocked.

## Install

1. Open the downloaded DMG, or unzip the ZIP.
2. Drag \`${appName}.app\` into Applications.
3. Open the app.

## First launch warning

Because this build is distributed without Apple notarization, macOS may block the first launch.

Use one of these:

1. Finder で app を右クリックして \`開く\`
2. \`システム設定 > プライバシーとセキュリティ\` で \`このまま開く\`

If macOS still blocks the app, run:

\`\`\`bash
xattr -dr com.apple.quarantine "/Applications/${appName}.app"
\`\`\`

## Notes

- This build is intended for trusted manual distribution through GitHub Releases.
- \`SHA256SUMS.txt\` is included for integrity checks.
`,
);

console.log(`Prepared GitHub release assets in ${releaseDir}`);
