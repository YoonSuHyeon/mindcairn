/**
 * Weekly/monthly retrospective — accumulated summary of mindcairn captured_decision.
 *
 *   bun run scripts/mindcairn-retrospect.ts [tag] [--days 7] [--out path.md]
 *
 * Output: a markdown report grouped by domain × kind.
 * Automatically saved to .mindcairn/<tag>/retro/<date>.md.
 */

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ChunkStore } from '../src/builder/sqlite-store.ts';
import { config } from '../src/config.ts';

const args = parseArgs(process.argv.slice(2));
const TAG = args.positional[0] ?? 'my-project';
const DAYS = Number(args.flags.days ?? 7);

async function main() {
  const sqlitePath = join(process.cwd(), config.output.dir, TAG, 'chunks.sqlite');
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  const store = new ChunkStore(sqlitePath);
  const items = store.listCaptured({ since, limit: 1000 });
  store.close();

  if (items.length === 0) {
    console.error(`(${TAG}) nothing captured in the last ${DAYS} days`);
    return;
  }

  // domain × kind grouping
  type Item = (typeof items)[number];
  const byDomain: Record<string, Record<string, Item[]>> = {};
  for (const c of items) {
    const d = (c.metadata.domain as string) || '(no-domain)';
    const k = (c.metadata.kind as string) || 'decision';
    byDomain[d] ??= {};
    byDomain[d][k] ??= [];
    byDomain[d][k].push(c);
  }

  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  sections.push(`# mindcairn retrospective — ${TAG}  (last ${DAYS} days)`);
  sections.push(`period: ~${today}  /  ${items.length} total`);
  sections.push('');

  // Summary statistics
  const kindTotals: Record<string, number> = {};
  for (const dMap of Object.values(byDomain)) {
    for (const [k, list] of Object.entries(dMap)) {
      kindTotals[k] = (kindTotals[k] ?? 0) + list.length;
    }
  }
  sections.push(`## Statistics`);
  for (const [k, n] of Object.entries(kindTotals).sort((a, b) => b[1] - a[1])) {
    sections.push(`- ${k}: ${n}`);
  }
  sections.push('');

  // domain × kind
  for (const [domain, dMap] of Object.entries(byDomain).sort(
    (a, b) => Object.values(b[1]).reduce((s, l) => s + l.length, 0)
      - Object.values(a[1]).reduce((s, l) => s + l.length, 0),
  )) {
    sections.push(`## domain: ${domain}`);
    for (const [kind, list] of Object.entries(dMap)) {
      sections.push(`### ${kind} (${list.length})`);
      for (const c of list) {
        const title = (c.metadata.title as string) || '?';
        const at = ((c.metadata.capturedAt as string) ?? '').slice(0, 10);
        const label = c.enrichedLabel ?? '';
        sections.push(`- **${title}** _(${at})_`);
        if (label) sections.push(`    ${label}`);
      }
      sections.push('');
    }
  }

  // Rule promotion candidates — same (domain, kind) accumulated 3 or more times
  const promotion: Array<{ domain: string; kind: string; count: number }> = [];
  for (const [domain, dMap] of Object.entries(byDomain)) {
    for (const [kind, list] of Object.entries(dMap)) {
      if (list.length >= 3) promotion.push({ domain, kind, count: list.length });
    }
  }
  if (promotion.length > 0) {
    sections.push(`## ⚡ Rule promotion candidates (accumulated 3+ times)`);
    for (const p of promotion.sort((a, b) => b.count - a.count)) {
      sections.push(`- ${p.domain} / ${p.kind} — ${p.count}  → consider reinforcing \`.claude/rules/${p.domain}.md\``);
    }
    sections.push('');
  }

  const out = sections.join('\n');

  const outPath = (args.flags.out as string | undefined)
    ?? join(process.cwd(), config.output.dir, TAG, 'retro', `${today}.md`);
  await mkdir(join(outPath, '..'), { recursive: true });
  await writeFile(outPath, out, 'utf-8');
  console.error(`✓ ${outPath}`);
  console.log(out);
}

function parseArgs(arr: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = arr[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
