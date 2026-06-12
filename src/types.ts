/**
 * Mindcairn core types — shared by all agents.
 */

export type FileRef = {
  path: string;           // absolute path
  relativePath: string;   // path relative to the analysis root
  language: string;       // .kt → kotlin / .ts → typescript / ...
  bytes: number;
  hash: string;
};

export type CodebaseSnapshot = {
  rootPath: string;
  takenAt: string;        // ISO timestamp
  files: FileRef[];
  totalBytes: number;
  totalFiles: number;
};

/**
 * Output of the Discovery stage.
 * Human-readable, and also consumed as input by the next agent.
 */
export type Discovery = {
  language: string[];          // ["kotlin", "java"]
  frameworks: string[];        // ["spring-boot", "jooq", "r2dbc"]
  buildSystem: string;         // "gradle" / "maven" / "npm"
  architecturePattern: string; // "ddd-hexagonal" / "mvc" / ...
  modules: Array<{
    name: string;
    path: string;
    purpose: string;           // module purpose inferred by the LLM
  }>;
  conventions: {
    naming: string;            // "camelCase / *Status suffix for enums"
    codeEnumPattern: string;   // "CodeValueEnum" / null
    entityPattern: string;     // @Table + @Column / @Entity / ...
    [key: string]: string;
  };
  domainHints: string[];       // ["order", "member", "delivery", ...]
  rawSummary: string;          // the LLM's natural-language summary (for human review)
};

/**
 * Output of the Strategy stage.
 * The chunking strategy the Builder follows.
 */
export type IndexingStrategy = {
  version: 1;
  chunkers: ChunkerSpec[];
  storage: StorageSpec;
  embedding: EmbeddingSpec;
  retrievalQuota: Record<string, number>;
};

export type ChunkerSpec = {
  name: string;                // "entity" / "method" / "enum" / ...
  matcher: {                   // which files/symbols it applies to
    pathGlob?: string[];
    annotation?: string;       // e.g. "@Table"
    superType?: string;        // e.g. "CodeValueEnum"
  };
  unit: 'file' | 'class' | 'method' | 'enum' | 'custom';
  embeddingTextTemplate: string; // a template like {{className}} {{tableName}} ...
  metadataKeys: string[];
};

export type StorageSpec = {
  vector: 'sqlite-vec' | 'qdrant' | 'pgvector';
  structured?: 'sqlite' | 'es';
  graph?: 'sqlite-graph' | 'neo4j';
};

export type EmbeddingSpec = {
  provider: 'ollama' | 'voyage' | 'openai';
  model: string;
  dimensions: number;
};

/**
 * An actual chunk (Builder output).
 */
export type Chunk = {
  id: string;
  type: string;                // chunker.name from strategy
  embeddingText: string;
  rawContent: string;
  metadata: Record<string, unknown>;
};

export type EmbeddedChunk = Chunk & {
  embedding: number[];
};

/**
 * A search result.
 */
export type ScoredChunk = Chunk & {
  score: number;
};

/**
 * Eval data.
 */
export type EvalCase = {
  id: string;
  question: string;
  expectedReferences: string[]; // the correct chunks/files/symbols
  expectedAnswer?: string;       // free-text expected answer (for the LLM judge)
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;              // "schema" / "business-rule" / "convention" / ...
};

export type EvalResult = {
  caseId: string;
  retrieved: ScoredChunk[];
  judge: {
    correct: boolean;
    score: number;     // 0..1
    reasoning: string;
  };
};

export type EvalReport = {
  totalCases: number;
  passed: number;
  averageScore: number;
  byCategory: Record<string, { total: number; passed: number; avgScore: number }>;
  failedSamples: EvalResult[];
};
