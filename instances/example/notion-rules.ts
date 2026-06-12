/**
 * Example — map a Notion task DB → mindcairn chunker kind + canonical doc metadata.
 *
 * Hypothetical Notion columns (rename to match YOUR DB):
 *   - Type:   spec / design / qa / ops / data / infra
 *   - Role:   backend / frontend / app / data / infra / pm / qa
 *   - Status: done / in-progress / ...
 *
 * Copy this to instances/<tag>/notion-rules.ts and edit it for your own Notion columns/values.
 * Non-English column names work too — just read the keys your frontmatter actually has
 * (e.g. fm['유형'], fm['種別']). Which keys reach frontmatter is decided by the
 * PROPERTY_KEYS_KEEP whitelist in scripts/normalize-notion-export.ts.
 *
 * Spec: docs/ingestion-spec.md
 */

import type { DocMeta } from '../../src/mcp/handlers/ingest-doc.ts';

export type ClassifyKind = (frontmatter: Record<string, string>) => string;
export type ExtractDocMeta = (frontmatter: Record<string, string>) => DocMeta;

/** Map a row to a chunker kind (doc_spec / doc_design / ...). */
export const classifyKind: ClassifyKind = (fm) => {
  const docType = (fm['Type'] ?? '').trim().toLowerCase();
  const job = (fm['Role'] ?? '').trim().toLowerCase();
  if (docType === 'spec') return 'doc_spec';
  if (docType === 'design') return 'doc_design';
  if (docType === 'qa') return 'doc_qa';
  if (docType === 'ops') return 'doc_ops';
  if (docType === 'data' || job === 'data') return 'doc_data';
  if (docType === 'infra' || job === 'infra') return 'doc_infra';
  return 'doc_misc';
};

/** Map your Notion columns to mindcairn's canonical, source-agnostic metadata fields. */
export const extractDocMeta: ExtractDocMeta = (fm) => ({
  docType: fm['Type'],
  job: fm['Role'],
  status: fm['Status'],
  owners: fm['Owners'],
  plannedAt: fm['Planned'],
  executedAt: fm['Executed'],
  taskId: fm['Task ID'],
});
