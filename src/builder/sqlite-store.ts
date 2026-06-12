/**
 * SQLite chunk store.
 *
 * The real primary store in 2-stage retrieval:
 *   - Qdrant holds only label embeddings (for semantic search)
 *   - SQLite holds the actual body/metadata (precise lookup after a search result)
 *
 * Flow: query → Qdrant search → chunk IDs → SQLite fetch → rich context
 */

import { Database } from 'bun:sqlite';
import type { Chunk } from '../types.ts';

export class ChunkStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        file TEXT,
        class_name TEXT,
        method_name TEXT,
        enriched_label TEXT,
        embedding_text TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_class ON chunks(class_name)`);
  }

  clear() {
    this.db.run(`DELETE FROM chunks`);
  }

  upsertMany(chunks: Array<Chunk & { enrichedLabel?: string }>) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, type, file, class_name, method_name, enriched_label, embedding_text, raw_content, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insert = this.db.transaction((rows: typeof chunks) => {
      for (const c of rows) {
        const meta = c.metadata ?? {};
        stmt.run(
          c.id,
          c.type,
          (meta.file as string) ?? null,
          (meta.className as string) ?? null,
          (meta.methodName as string) ?? null,
          c.enrichedLabel ?? (meta.enrichedLabel as string) ?? null,
          c.embeddingText,
          c.rawContent,
          JSON.stringify(meta),
        );
      }
    });
    insert(chunks);
  }

  get(id: string): StoredChunk | undefined {
    const row = this.db.query(`SELECT * FROM chunks WHERE id = ?`).get(id) as
      | RawRow
      | undefined;
    return row ? toChunk(row) : undefined;
  }

  getMany(ids: string[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as RawRow[];
    const map = new Map(rows.map((r) => [r.id, toChunk(r)]));
    return ids.map((id) => map.get(id)).filter((c): c is StoredChunk => !!c);
  }

  countByType(): Record<string, number> {
    const rows = this.db
      .query(`SELECT type, COUNT(*) as n FROM chunks GROUP BY type`)
      .all() as Array<{ type: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  /** Delete all chunks where metadata JSON has key=value. Returns: number of deleted rows. */
  deleteByMetadata(key: string, value: string): number {
    const path = `$.${key}`;
    const rows = this.db
      .query(`SELECT id FROM chunks WHERE json_extract(metadata_json, ?) = ?`)
      .all(path, value) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(`DELETE FROM chunks WHERE id IN (${placeholders})`, ids);
    return ids.length;
  }

  /** captured_decision items — search by period + filter conditions (for retros). */
  listCaptured(opts: {
    since?: string;
    until?: string;
    kind?: string;
    domain?: string;
    limit?: number;
  }): StoredChunk[] {
    const where: string[] = [`type = 'captured_decision'`];
    const params: unknown[] = [];
    if (opts.since) {
      where.push(`json_extract(metadata_json, '$.capturedAt') >= ?`);
      params.push(opts.since);
    }
    if (opts.until) {
      where.push(`json_extract(metadata_json, '$.capturedAt') <= ?`);
      params.push(opts.until);
    }
    if (opts.kind) {
      where.push(`json_extract(metadata_json, '$.kind') = ?`);
      params.push(opts.kind);
    }
    if (opts.domain) {
      where.push(`json_extract(metadata_json, '$.domain') = ?`);
      params.push(opts.domain);
    }
    const limit = opts.limit ?? 100;
    const bindings = [...params, limit] as Array<string | number | null>;
    const rows = this.db
      .query(
        `SELECT * FROM chunks WHERE ${where.join(' AND ')} ORDER BY json_extract(metadata_json, '$.capturedAt') DESC LIMIT ?`,
      )
      .all(...bindings) as RawRow[];
    return rows.map(toChunk);
  }

  close() {
    this.db.close();
  }
}

export type StoredChunk = {
  id: string;
  type: string;
  file: string | null;
  className: string | null;
  methodName: string | null;
  enrichedLabel: string | null;
  embeddingText: string;
  rawContent: string;
  metadata: Record<string, unknown>;
};

type RawRow = {
  id: string;
  type: string;
  file: string | null;
  class_name: string | null;
  method_name: string | null;
  enriched_label: string | null;
  embedding_text: string;
  raw_content: string;
  metadata_json: string;
};

function toChunk(r: RawRow): StoredChunk {
  return {
    id: r.id,
    type: r.type,
    file: r.file,
    className: r.class_name,
    methodName: r.method_name,
    enrichedLabel: r.enriched_label,
    embeddingText: r.embedding_text,
    rawContent: r.raw_content,
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
  };
}
