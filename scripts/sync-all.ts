#!/usr/bin/env bun
/**
 * sync-all — incrementally sync every ref-anchored mindcairn instance.
 *
 *   bun run scripts/sync-all.ts [--fetch]
 *
 * Finds all instances that have a .mindcairn/<tag>/state.json and runs `mindcairn sync <tag>`.
 * If the sha hasn't changed it's an immediate no-op → cheap to run frequently via cron.
 *
 * fetch: mindcairn by default does not fetch (read-only). The local origin ref is refreshed by the user's regular pulls.
 *        Passing --fetch makes sync attempt a fetch itself (auth must be configured).
 *
 * cron example (every 15 min): one line in crontab (first 5 fields = "every 15 min")
 *   [min=0,15,30,45] [hour=*] [day=*] [month=*] [weekday=*]
 *   cd <mindcairn-repo> && bun run scripts/sync-all.ts >> .mindcairn/sync-all.log 2>&1
 * See README/docs for the actual crontab line (writing it here would close the block comment).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MINDCAIRN_DIR = join(import.meta.dir, '..');
const OUT_DIR = join(MINDCAIRN_DIR, process.env.MINDCAIRN_OUTPUT_DIR ?? '.mindcairn');
const fetchFlag = process.argv.includes('--fetch');

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // process.execPath = absolute path of the currently running bun → safe even under cron's minimal PATH.
    const p = spawn(process.execPath, ['run', 'src/cli/index.ts', ...args], {
      cwd: MINDCAIRN_DIR,
      stdio: 'inherit',
      env: { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}` },
    });
    p.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const stamp = new Date().toISOString();
  const entries = await readdir(OUT_DIR, { withFileTypes: true });
  const tags: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await readFile(join(OUT_DIR, e.name, 'state.json'), 'utf-8');
      tags.push(e.name);
    } catch {
      /* no state.json = instance not ref-anchored → skip */
    }
  }

  console.log(`\n[${stamp}] sync-all — ${tags.length} target(s): ${tags.join(', ')}`);
  for (const tag of tags) {
    console.log(`\n──── sync ${tag} ────`);
    const code = await run(['sync', tag, ...(fetchFlag ? ['--fetch'] : [])]);
    if (code !== 0) console.error(`  ⚠ ${tag} sync failed (exit ${code})`);
  }
  console.log(`\n[${stamp}] sync-all done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
