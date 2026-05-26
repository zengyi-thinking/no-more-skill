import type { NmsConfig } from "./types.js";

export const DEFAULT_CONFIG: NmsConfig = {
  cleaner: {
    max_skills: 10,
    max_workflows: 5,
    decay_days: 30
  },
  harness: {
    max_retry: 3,
    allowed_roots: ["sandbox/", "feature/"],
    core_explicit_whitelist: ["src/core/"],
    policy_profiles: {
      strict: {
        allowed_roots: ["sandbox/", "feature/"],
        core_explicit_whitelist: [],
        secret_scan_enabled: true
      },
      normal: {
        allowed_roots: ["sandbox/", "feature/"],
        core_explicit_whitelist: ["src/core/"],
        secret_scan_enabled: true
      },
      experimental: {
        allowed_roots: ["sandbox/", "feature/", "src/ui/", "src/components/", "tests/"],
        core_explicit_whitelist: ["src/core/"],
        secret_scan_enabled: true
      }
    }
  }
};
