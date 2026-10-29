/**
 * Which edition this renderer runs as (docs/editions.md). The Corp edition
 * is a separate build: Rust feature `corp` plus `vite --mode corp`. Either
 * side saying "corp" wins, so a mismatched pair (corp backend with a standard
 * bundle, e.g. a dev run) still hides what the backend compiled out.
 */
export type Edition = 'standard' | 'corp'

/** Fixed at build time by vite.config.ts from `--mode`. */
export const BUILD_EDITION: Edition = import.meta.env.VITE_SWARMTERM_EDITION === 'corp' ? 'corp' : 'standard'

export function effectiveEdition(build: Edition, backend: Edition): Edition {
  return build === 'corp' || backend === 'corp' ? 'corp' : 'standard'
}

export function productName(edition: Edition): string {
  return edition === 'corp' ? 'Swarmterm GN Corp' : 'Swarmterm GN'
}

/** Features whose code the Corp binary does not contain, so their UI is
 *  hidden rather than greyed out. */
export function editionFeatures(edition: Edition): { companion: boolean; modelDownload: boolean } {
  const on = edition !== 'corp'
  return { companion: on, modelDownload: on }
}
