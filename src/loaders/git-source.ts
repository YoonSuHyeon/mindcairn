/**
 * GitSource — pins mindcairn indexing's "source of truth" to a **stable ref** (staging/main),
 * not the working tree.
 *
 * Why: if an in-progress feature branch / dirty edits bleed into the index, the "system knowledge"
 *      gets polluted. Only merged refs are searchable code; in-flight work is covered by Notion/decisions.
 *
 * How: detached-checkout the ref into a separate git worktree → use that path as rootPath.
 *      The working tree (original repo) is left untouched. Sharing the object store is disk/speed efficient.
 *
 * Incremental (Step 2): reindex only changed files via changedFiles(fromSha, toSha).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

export function resolveSha(repo: string, ref: string): string {
  return git(repo, ['rev-parse', ref]);
}

export type RefSnapshot = {
  /** Indexing target path (= worktree). Passed as rootPath to loadCodebase/build. */
  root: string;
  ref: string;
  sha: string;
};

/**
 * Check out a stable ref into a worktree and return that path.
 *
 * - worktree location: <repo>/../<repo-name>-worktrees/mindcairn-<ref>
 * - if it already exists, fetch then hard-checkout the ref (refresh)
 * - if fetch fails (offline), proceed with the local ref
 */
export function materializeRef(
  repo: string,
  ref: string,
  opts?: { fetch?: boolean; worktreeRoot?: string },
): RefSnapshot {
  const wtRoot = opts?.worktreeRoot ?? join(repo, '..', `${basename(repo)}-worktrees`);
  const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, '_');
  const wt = join(wtRoot, `mindcairn-${safeRef}`);

  if (opts?.fetch !== false) {
    try {
      git(repo, ['fetch', '--quiet', 'origin']);
    } catch {
      /* offline etc. — proceed with the local ref */
    }
  }

  if (!existsSync(join(wt, '.git'))) {
    // create a new worktree (detached), after cleaning up leftovers.
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      /* noop */
    }
    git(repo, ['worktree', 'add', '--detach', wt, ref]);
  } else {
    // refresh: force-checkout the ref
    git(wt, ['checkout', '--detach', '--force', ref]);
  }

  const sha = resolveSha(wt, 'HEAD');
  return { root: wt, ref, sha };
}

/**
 * Repo-relative paths of files changed between fromSha..toSha. For incremental reindexing.
 * If fromSha is absent, returns [] (= signal that a full build is needed).
 */
export function changedFiles(repo: string, fromSha: string | undefined, toSha: string): string[] {
  if (!fromSha) return [];
  const out = git(repo, ['diff', '--name-only', `${fromSha}..${toSha}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}
