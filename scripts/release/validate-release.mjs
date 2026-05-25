import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const root = process.cwd();

const required = [
  ".claude-plugin/marketplace.json",
  "agents/openai.yaml",
  "skills/nms-core/SKILL.md",
  "README.md",
  "README.en.md"
];

const missing = required.filter((p) => !fs.existsSync(path.join(root, p)));
if (missing.length > 0) {
  console.error("Missing required release files:");
  for (const m of missing) console.error(`- ${m}`);
  process.exit(1);
}

console.log("Release validation passed.");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const zipName = `nms-core-${pkg.version}.zip`;
const zipPath = path.join(root, "dist", "releases", zipName);
if (fs.existsSync(zipPath)) {
  const zip = new AdmZip(zipPath);
  const entries = new Set(zip.getEntries().map((e) => e.entryName.replaceAll("\\", "/")));
  const requiredZip = [
    "skills/nms-core/SKILL.md",
    "agents/openai.yaml",
    ".claude-plugin/marketplace.json",
    "SKILL.md",
    "README.md",
    "README.en.md"
  ];
  const missingZip = requiredZip.filter((p) => !entries.has(p));
  if (missingZip.length > 0) {
    console.error("Zip artifact missing required files:");
    for (const m of missingZip) console.error(`- ${m}`);
    process.exit(1);
  }
  console.log("Zip artifact validation passed.");
}
