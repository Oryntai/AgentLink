import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentity } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPaths = process.argv.slice(2).map((item) => path.resolve(item));
if (!configPaths.length) {
  throw new Error("Usage: node scripts/migrate-identity.js CONFIG [CONFIG...]");
}

for (const configPath of configPaths) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config.identity?.publicKey || !config.identity?.privateKey) {
    config.identity = createIdentity();
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`Identity created: ${configPath}`);
  } else {
    console.log(`Identity already present: ${configPath}`);
  }
}
