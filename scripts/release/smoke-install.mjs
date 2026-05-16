import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function runText(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString();
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-smoke-"));

try {
  const packResult = runText("npm pack --silent", root).trim();
  const tgzName = packResult.split(/\r?\n/).pop();
  if (!tgzName) throw new Error("npm pack did not produce tarball name");
  const tgzPath = path.join(root, tgzName);

  run("npm init -y", tempDir);
  run(`npm install "${tgzPath}"`, tempDir);

  const flow = runText("npx --yes nms flow --format json", tempDir);
  if (!flow.includes("recent_workflow")) {
    throw new Error("Smoke failed: `nms flow` output missing recent_workflow");
  }

  const skillFlow = runText('npx --yes nms-skill "/nms-flow" --format human', tempDir);
  if (!skillFlow.includes("Behavior Cockpit")) {
    throw new Error("Smoke failed: `nms-skill /nms-flow` output missing Behavior Cockpit");
  }

  const doctor = runText("npx --yes nms doctor", tempDir);
  if (!doctor.includes("NMS Doctor")) {
    throw new Error("Smoke failed: `nms doctor` output missing NMS Doctor");
  }

  console.log("Smoke install check passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

