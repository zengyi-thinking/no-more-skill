import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const root = process.cwd();
const outDir = path.join(root, "dist", "releases");
fs.mkdirSync(outDir, { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const zipName = `nms-core-${version}.zip`;
const zipPath = path.join(outDir, zipName);

if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const includePaths = [
  "skills/nms-core",
  ".claude-plugin/marketplace.json",
  "SKILL.md",
  "README.md",
  "README.en.md"
];

const zip = new AdmZip();
for (const relative of includePaths) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing path for pack: ${relative}`);
  }
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    zip.addLocalFolder(full, relative);
  } else {
    zip.addLocalFile(full, path.dirname(relative), path.basename(relative));
  }
}
zip.writeZip(zipPath);

console.log(`Packed: ${zipPath}`);
