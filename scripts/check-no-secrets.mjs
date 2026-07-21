import { execFileSync } from "node:child_process";

const blockedFiles = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.prod",
  ".env.staging",
  ".dev.vars",
  ".dev.vars.production",
]);

const stagedFiles = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--"],
  { encoding: "utf8" },
)
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

const secrets = stagedFiles.filter((file) => blockedFiles.has(file));

if (secrets.length > 0) {
  console.error("Refusing to commit local secret files:");
  for (const file of secrets) console.error(`- ${file}`);
  console.error("Remove them from the staged changes and run npm run ship again.");
  process.exit(1);
}

console.log(`Secret check passed (${stagedFiles.length} staged file${stagedFiles.length === 1 ? "" : "s"}).`);
