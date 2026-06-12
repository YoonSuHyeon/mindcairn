/**
 * Notion Markdown export → mindcairn inputs normalization.
 *
 *   bun run scripts/normalize-notion-export.ts <export-dir> [out-subdir]
 *
 * Input: a directory exported by Notion (containing *.md files and subpage folders)
 * Output: mindcairn/inputs/notion/{out-subdir|tasks}/TASK-{id}-{slug}.md
 *   - out-subdir example: team-a → inputs/notion/team-a/ (per-instance separation)
 *   - YAML frontmatter (title, pageId, taskId, status, type, owner, date ...)
 *   - body with <aside> tags removed + Notion-specific markup cleaned up
 *
 * The first part of a Notion export has properties in `key: value` form. Parse them and convert into frontmatter.
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

// Which Notion property columns to keep as frontmatter.
// Zero-config default: keep every parsed property (the parser already drops keys >30 chars and URLs).
// To restrict to specific columns, set MINDCAIRN_NOTION_KEEP_KEYS to a comma-separated list
// of your Notion DB column names, e.g. MINDCAIRN_NOTION_KEEP_KEYS="Status,Type,Owner,Due".
const KEEP_KEYS = (process.env.MINDCAIRN_NOTION_KEEP_KEYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const keepKey = (k: string): boolean => KEEP_KEYS.length === 0 || KEEP_KEYS.includes(k);

// Candidate columns to use as the task id, in priority order. Override for your own schema, e.g.
// MINDCAIRN_NOTION_ID_KEYS="Task ID,ID".
const ID_KEYS = (process.env.MINDCAIRN_NOTION_ID_KEYS ?? 'Task ID,ID')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type NotionMd = {
  pageId: string;
  taskId: string;
  title: string;
  properties: Record<string, string>;
  body: string;
};

async function main() {
  const exportDir = process.argv[2];
  if (!exportDir) {
    console.error('Usage: bun run scripts/normalize-notion-export.ts <export-dir>');
    process.exit(1);
  }
  const outSubdir = process.argv[3] ?? 'tasks';
  const outDir = join(process.cwd(), 'inputs', 'notion', outSubdir);
  await mkdir(outDir, { recursive: true });

  const files = await collectMarkdownFiles(exportDir);
  console.error(`▶ Notion export normalize`);
  console.error(`  source:  ${exportDir}`);
  console.error(`  out:     ${outDir}`);
  console.error(`  files:   ${files.length}`);

  let saved = 0;
  let skipped = 0;
  for (const file of files) {
    try {
      const raw = await readFile(file, 'utf-8');
      const doc = parseNotionMarkdown(raw, file);
      if (!doc.title) {
        skipped++;
        continue;
      }
      const filename = makeFilename(doc);
      const content = buildOutput(doc);
      await writeFile(join(outDir, filename), content, 'utf-8');
      saved++;
    } catch (e) {
      console.error(`  ! ${basename(file)}: ${(e as Error).message}`);
      skipped++;
    }
  }

  console.error(`✓ saved=${saved}  skipped=${skipped}`);
  console.error(`▶ next:  bun run scripts/ingest-notion.ts <tag> ${outSubdir}`);
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(p);
      }
    }
  }
  await walk(dir);
  return out;
}

function parseNotionMarkdown(raw: string, filepath: string): NotionMd {
  // 1) pageId — the 32-char hex at the end of the filename
  const fname = basename(filepath, '.md');
  const idMatch = fname.match(/([a-f0-9]{32})$/i);
  const pageId = idMatch ? idMatch[1] : '';

  // 2) first H1 → title
  const lines = raw.split('\n');
  let title = '';
  let propStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!title && ln.startsWith('# ')) {
      title = ln.slice(2).trim();
      propStart = i + 1;
      break;
    }
  }
  if (!title) {
    return { pageId, taskId: '', title: '', properties: {}, body: '' };
  }

  // 3) properties — from after the first H1 up to the first <aside>, first `---`, or empty line after the first blank line
  const properties: Record<string, string> = {};
  let bodyStart = lines.length;
  for (let i = propStart; i < lines.length; i++) {
    const ln = lines[i];
    const trimmed = ln.trim();
    if (!trimmed) continue; // skip blank lines but do NOT update bodyStart
    if (trimmed.startsWith('<aside>') || trimmed.startsWith('# ') || trimmed.startsWith('## ') || trimmed === '---') {
      bodyStart = i;
      break;
    }
    const m = ln.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      const key = m[1].trim();
      const value = m[2].trim();
      if (key.length < 30 && !key.includes('http')) {
        properties[key] = value;
        continue;
      }
    }
    // end of the properties block
    bodyStart = i;
    break;
  }

  // 4) extract taskId — first matching column from ID_KEYS, else a stable fallback from pageId
  let taskId = '';
  for (const k of ID_KEYS) {
    if (properties[k]) {
      taskId = properties[k];
      break;
    }
  }
  if (!taskId) taskId = `NO-ID-${pageId.slice(0, 8)}`;

  // 5) body — clean up <aside> tags + Notion-specific markup
  const bodyRaw = lines.slice(bodyStart).join('\n');
  const body = cleanNotionBody(bodyRaw);

  return { pageId, taskId, title, properties, body };
}

function cleanNotionBody(text: string): string {
  return text
    // <aside>...</aside> tags → keep only the inner emoji + the following ##
    .replace(/<aside>\s*[💡🚧🔥📌🎯⚠️ℹ️✅❌📝🔗]*\s*/g, '')
    .replace(/<\/aside>/g, '')
    // shorten the long S3 url line of an attached image/file
    .replace(/^\s*!\[.*?\]\(https:\/\/prod-files-secure[^\s)]+\).*$/gm, '![image]')
    // collapse consecutive dividers/blank lines
    .replace(/\n{3,}/g, '\n\n')
    // trim leading/trailing whitespace
    .trim();
}

function makeFilename(doc: NotionMd): string {
  const slug = doc.title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[-]{2,}/g, '-')
    .slice(0, 60);
  return `${doc.taskId}-${slug}.md`;
}

function buildOutput(doc: NotionMd): string {
  // frontmatter — whitelist keys only + always-included meta
  const fm: Record<string, string> = {
    title: doc.title,
    pageId: doc.pageId,
    taskId: doc.taskId,
    url: `https://www.notion.so/${doc.pageId}`,
  };
  for (const [key, value] of Object.entries(doc.properties)) {
    if (value && keepKey(key)) fm[key] = value;
  }

  const fmLines = Object.entries(fm)
    .filter(([, v]) => v && v.length > 0)
    .map(([k, v]) => `${k}: ${v.replace(/\n/g, ' ')}`)
    .join('\n');

  return `---\n${fmLines}\n---\n\n# ${doc.taskId} — ${doc.title}\n\n${doc.body}\n`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
