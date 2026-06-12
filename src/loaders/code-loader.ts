/**
 * CodeLoader — collect code files via directory walk + glob.
 *
 * Input for the autonomous Discovery stage. No chunking here — file metadata only.
 */

import fg from 'fast-glob';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, extname } from 'node:path';
import type { CodebaseSnapshot, FileRef } from '../types.ts';

const EXT_TO_LANG: Record<string, string> = {
  '.kt': 'kotlin',
  '.java': 'java',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
};

export type LoaderOptions = {
  include?: string[];      // glob (relative to root)
  exclude?: string[];
  maxFiles?: number;
};

const DEFAULT_INCLUDE = ['**/*.kt', '**/*.java', '**/*.ts', '**/*.sql'];
const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/build/**',
  '**/.gradle/**',
  '**/.git/**',
  '**/dist/**',
  '**/.next/**',
  '**/test/**',
  '**/tests/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.go',
  '**/testdata/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
  '**/__tests__/**',
  '**/__pycache__/**',
];

export async function loadCodebase(
  rootPath: string,
  opts: LoaderOptions = {},
): Promise<CodebaseSnapshot> {
  const include = opts.include ?? DEFAULT_INCLUDE;
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;

  const matches = await fg(include, {
    cwd: rootPath,
    absolute: true,
    ignore: exclude,
    dot: false,
    onlyFiles: true,
  });

  const limited = opts.maxFiles ? matches.slice(0, opts.maxFiles) : matches;

  const files: FileRef[] = [];
  let totalBytes = 0;

  for (const abs of limited) {
    const st = await stat(abs);
    const content = await readFile(abs);
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 16);
    const ext = extname(abs);
    const rel = relative(rootPath, abs);
    files.push({
      path: abs,
      relativePath: rel,
      language: EXT_TO_LANG[ext] ?? 'unknown',
      bytes: st.size,
      hash,
    });
    totalBytes += st.size;
  }

  return {
    rootPath,
    takenAt: new Date().toISOString(),
    files,
    totalBytes,
    totalFiles: files.length,
  };
}
