import type { NmsConfig } from "../types.js";

const UI_HINTS = ["ui", "view", "component", ".css", ".scss", ".tsx", ".jsx"];

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

export function validateWriteScope(files: string[], config: NmsConfig): { ok: boolean; reason?: string } {
  for (const rawFile of files) {
    const file = rawFile.replaceAll("\\", "/");
    const inAllowedRoot = config.harness.allowed_roots.some((root) => file.startsWith(root));
    if (!inAllowedRoot) {
      const isCoreWhitelisted = config.harness.core_explicit_whitelist.some((core) => file.startsWith(core));
      if (!isCoreWhitelisted) {
        return { ok: false, reason: `Out of whitelist path: ${file}` };
      }
    }
    if (!(isUiFile(file) || isTestFile(file) || isNewFile(file))) {
      return { ok: false, reason: `File type not allowed by policy: ${file}` };
    }
  }
  return { ok: true };
}
