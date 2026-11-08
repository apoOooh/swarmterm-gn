/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `"corp"` in a `--mode corp` build, else `"standard"` (vite.config.ts). */
  readonly VITE_SWARMTERM_EDITION: 'standard' | 'corp'
}
