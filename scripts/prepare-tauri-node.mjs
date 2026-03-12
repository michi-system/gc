import { mkdirSync, copyFileSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const binariesDir = join(projectRoot, "src-tauri", "binaries");
const targetTriple = execSync("rustc --print host-tuple", { cwd: projectRoot, encoding: "utf8" }).trim();
const destination = join(binariesDir, `node-sidecar-${targetTriple}`);

mkdirSync(binariesDir, { recursive: true });

for (const entry of readdirSync(binariesDir)) {
  if (entry.startsWith("node-sidecar-")) {
    rmSync(join(binariesDir, entry), { force: true });
  }
}

copyFileSync(process.execPath, destination);
chmodSync(destination, 0o755);

console.log(`Prepared bundled Node runtime at ${destination}`);
