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
    core_explicit_whitelist: ["src/core/"]
  }
};
