const mode = process.env.APPLE_SIGNING_IDENTITY === "-" ? "ad-hoc" : "signed";
const notarization =
  Boolean(process.env.APPLE_API_ISSUER?.trim()) ||
  Boolean(process.env.APPLE_ID?.trim())
    ? "enabled"
    : "disabled";

console.log(`Preparing ${mode} macOS bundle (${notarization} notarization context).`);
