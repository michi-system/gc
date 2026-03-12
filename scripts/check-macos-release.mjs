import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasCommand(command, args = ["--version"]) {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

function printCheck(label, ok, detail = "") {
  const icon = ok ? "OK " : "NG ";
  console.log(`${icon}${label}${detail ? `: ${detail}` : ""}`);
}

const identitiesOutput = (() => {
  try {
    return run("security", ["find-identity", "-v", "-p", "codesigning"]);
  } catch {
    return "";
  }
})();

const hasDevId = /Developer ID Application/i.test(identitiesOutput);
const requestedIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "";
const usingAdhoc = requestedIdentity === "-";

const apiKeyMode =
  Boolean(process.env.APPLE_API_ISSUER?.trim()) &&
  Boolean(process.env.APPLE_API_KEY?.trim()) &&
  Boolean(process.env.APPLE_API_KEY_PATH?.trim());

const appleIdMode =
  Boolean(process.env.APPLE_ID?.trim()) &&
  Boolean(process.env.APPLE_PASSWORD?.trim()) &&
  Boolean(process.env.APPLE_TEAM_ID?.trim());

const notarizationReady = apiKeyMode || appleIdMode;
const apiKeyPathExists = process.env.APPLE_API_KEY_PATH ? existsSync(process.env.APPLE_API_KEY_PATH) : false;
const xcodeReady = hasCommand("xcrun", ["notarytool", "--help"]);

printCheck("Xcode notarytool", xcodeReady);
printCheck(
  "Signing identity",
  usingAdhoc || Boolean(requestedIdentity) || hasDevId,
  usingAdhoc
    ? "ad-hoc"
    : requestedIdentity || (hasDevId ? "Developer ID Application found in keychain" : "not configured"),
);
printCheck("App Store Connect API credentials", apiKeyMode, apiKeyMode ? "configured" : "missing");
if (process.env.APPLE_API_KEY_PATH) {
  printCheck("APPLE_API_KEY_PATH", apiKeyPathExists, process.env.APPLE_API_KEY_PATH);
}
printCheck("Apple ID notarization credentials", appleIdMode, appleIdMode ? "configured" : "missing");

if (usingAdhoc) {
  console.log("\nAd-hoc signing mode selected. Notarization will not run.");
  process.exit(0);
}

const failures = [];

if (!xcodeReady) {
  failures.push("xcrun notarytool is unavailable. Install Xcode / Command Line Tools.");
}

if (!(Boolean(requestedIdentity) || hasDevId)) {
  failures.push("No signing identity configured. Install a Developer ID Application certificate or set APPLE_SIGNING_IDENTITY=- for ad-hoc builds.");
}

if (!notarizationReady) {
  failures.push(
    "Notarization credentials are missing. Set APPLE_API_ISSUER + APPLE_API_KEY + APPLE_API_KEY_PATH, or APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID.",
  );
}

if (process.env.APPLE_API_KEY_PATH && !apiKeyPathExists) {
  failures.push(`APPLE_API_KEY_PATH does not exist: ${process.env.APPLE_API_KEY_PATH}`);
}

if (failures.length > 0) {
  console.error("\nmacOS signed release preflight failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("\nmacOS signed release preflight passed.");
