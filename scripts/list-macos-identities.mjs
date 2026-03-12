import { execFileSync } from "node:child_process";

try {
  const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  console.log(output);
} catch (error) {
  console.error("Failed to list macOS code signing identities.");
  console.error(error.stderr?.toString?.() || error.message);
  process.exit(1);
}
