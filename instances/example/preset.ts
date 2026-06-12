/**
 * Example — an instance preset (based on a hypothetical Kotlin/Spring Boot monorepo).
 *
 *   usage: bun run src/cli/index.ts discover <repo> --preset example
 *
 * include/exclude are globs relative to the target repo root.
 * For your own project, copy this to instances/<tag>/preset.ts and edit it.
 * If one org has multiple products, instances/<org>/presets/<tag>.ts works too (the CLI searches both).
 */

export type Preset = {
  include: string[];
  exclude: string[];
};

export const preset: Preset = {
  include: [
    // main application
    'domain/**/*.kt',
    'infrastructure/**/*.kt',
    'application/**/*.kt',
    // shared modules it depends on (only those worth searching — constants/utils/exceptions, etc.)
    'core/src/main/kotlin/**/*.kt',
  ],
  exclude: [
    '**/test/**',
    '**/tests/**',
    '**/build/**',
    '**/.gradle/**',
    '**/.git/**',
    '**/*.test.*',
    '**/*Test.kt',
  ],
};

export default preset;
