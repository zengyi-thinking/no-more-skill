import fs from "node:fs";
import path from "node:path";
import type { NmsConfig, PolicyProfileName, SecretScanHit } from "../types.js";

const UI_HINTS = ["ui", "view", "component", ".css", ".scss", ".tsx", ".jsx"];
const SECRET_PATTERNS: Array<{ rule: SecretScanHit["rule"]; pattern: RegExp; summary: string }> = [
  { rule: ".env", pattern: /(^|\/)\.env(\.|$)/i, summary: "dotenv file" },
  { rule: "token", pattern: /\b(Bearer\s+[A-Za-z0-9._~+/=-]+|token\s*[:=]\s*["']?[^\s"',;]+)/i, summary: "token-like content" },
  { rule: "api_key", pattern: /\b(api[_-]?key|sk-[A-Za-z0-9_-]{12,})\b/i, summary: "api key-like content" },
  { rule: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, summary: "private key block" }
];

function isUiFile(file: string): boolean {
  const lower = file.toLowerCase();
  return UI_HINTS.some((hint) => lower.includes(hint));
}

function isTestFile(file: string): boolean {
  return /(\.test\.|\.spec\.)/i.test(file) || file.includes("/tests/");
}

function isNewFile(file: string): boolean {
  return file.includes("new/") || file.startsWith("sandbox/new/");
}

export function resolvePolicyProfile(
  config: NmsConfig,
  profile: PolicyProfileName = "normal"
): { allowed_roots: string[]; core_explicit_whitelist: string[]; secret_scan_enabled: boolean } {
  return config.harness.policy_profiles[profile] ?? config.harness.policy_profiles.normal;
}

export function scanSecretsInFiles(files: string[], cwd = process.cwd()): SecretScanHit[] {
  const hits: SecretScanHit[] = [];
  for (const rawFile of files) {
    const file = rawFile.replaceAll("\\", "/");
    for (const rule of SECRET_PATTERNS) {
      if (rule.rule === ".env" && rule.pattern.test(file)) {
        hits.push({ file, rule: ".env", summary: rule.summary });
      }
    }
    const fullPath = path.resolve(cwd, file);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    for (const rule of SECRET_PATTERNS.filter((item) => item.rule !== ".env")) {
      if (rule.pattern.test(content)) {
        hits.push({ file, rule: rule.rule, summary: rule.summary });
      }
    }
  }
  return hits;
}

export function validateWriteScope(
  files: string[],
  config: NmsConfig,
  profile: PolicyProfileName = "normal"
): { ok: boolean; reason?: string; secret_hits?: SecretScanHit[] } {
  const policy = resolvePolicyProfile(config, profile);
  for (const rawFile of files) {
    const file = rawFile.replaceAll("\\", "/");
    const inAllowedRoot = policy.allowed_roots.some((root) => file.startsWith(root));
    if (!inAllowedRoot) {
      const isCoreWhitelisted = policy.core_explicit_whitelist.some((core) => file.startsWith(core));
      if (!isCoreWhitelisted) {
        return { ok: false, reason: `Out of whitelist path: ${file}` };
      }
    }
    if (!(isUiFile(file) || isTestFile(file) || isNewFile(file))) {
      return { ok: false, reason: `File type not allowed by policy: ${file}` };
    }
  }
  if (policy.secret_scan_enabled) {
    const secretHits = scanSecretsInFiles(files);
    if (secretHits.length > 0) {
      const first = secretHits[0];
      return {
        ok: false,
        reason: `Secret scan blocked: ${first.rule} in ${first.file}`,
        secret_hits: secretHits
      };
    }
  }
  return { ok: true };
}
