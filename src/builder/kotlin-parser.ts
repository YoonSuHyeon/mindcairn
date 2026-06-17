/**
 * Regex-based Kotlin file parser — extracts class/data class/enum/fun + annotation/superType/KDoc.
 *
 * No AST (PoC). Covers common patterns:
 *  - package
 *  - imports
 *  - annotations: @Foo / @Foo(...) / @Foo("...")
 *  - class header: (data )?class Name(params) : SuperType { ... }
 *  - enum class Name(...) : Interface { VAL("01"), ... }
 *  - fun (suspend )?name(params): ReturnType { ... }
 *  - KDoc: doc comment block
 */

export type ParsedAnnotation = {
  name: string;          // @Table
  argsRaw: string;       // (name = "member_order", schema = "app")
};

export type ParsedField = {
  name: string;
  type: string;
  annotations: ParsedAnnotation[];
};

export type ParsedFunction = {
  name: string;
  signature: string;     // full sig line
  parameters: string;    // inside the parentheses
  returnType: string;
  isSuspend: boolean;
  kdoc?: string;
  annotations: ParsedAnnotation[];
  bodyText?: string;     // part of the method body (optional)
};

export type ParsedClass = {
  kind: 'class' | 'data class' | 'object' | 'interface' | 'enum';
  name: string;
  superTypes: string[];  // the A,B in ": A, B"
  annotations: ParsedAnnotation[];
  kdoc?: string;
  fields: ParsedField[];     // primary constructor params (mainly for data class)
  methods: ParsedFunction[]; // member fun
  enumEntries?: Array<{ name: string; argsRaw: string }>;
};

export type ParsedFile = {
  pkg: string;
  imports: string[];
  classes: ParsedClass[];
  topLevelFunctions: ParsedFunction[];
};

const PACKAGE_RE = /(?:^|\n)\s*package\s+([\w.]+)/;
const IMPORT_RE = /(?:^|\n)\s*import\s+([\w.*]+)/g;
// (data |open |sealed |inner |abstract )* (class|interface|object|enum class) Name (<T>)? (...)?  (:  ...)? { ... }
const CLASS_RE =
  /(?:\n|^)((?:\/\*\*[\s\S]*?\*\/\s*\n)?)((?:^|\n)\s*(?:@[\w.]+(?:\([^)]*\))?\s*\n?)*)\s*(?:(?:public|internal|private|open|sealed|abstract|inner|final)\s+)*(data\s+class|enum\s+class|class|interface|object)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(\([\s\S]*?\))?\s*(?::\s*([^{]+))?\s*\{/g;
const ANNOTATION_RE = /@([\w.]+)(\([^)]*\))?/g;
// fun (suspend)? name(params): Type { ... }
const FUN_RE =
  /(?:\n|^)((?:\/\*\*[\s\S]*?\*\/\s*\n)?)((?:^|\n)\s*(?:@[\w.]+(?:\([^)]*\))?\s*\n?)*)\s*(suspend\s+)?(?:public|internal|private|protected|override|open|abstract|final)*\s*fun\s+([A-Za-z_]\w*)\s*(\([\s\S]*?\))\s*(?::\s*([\w<>?,. \[\]]+))?\s*(?=[\{=])/g;

const MAX_BODY_BYTES = 4000;

export function parseKotlin(content: string): ParsedFile {
  const pkg = content.match(PACKAGE_RE)?.[1]?.trim() ?? '';
  const imports: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    imports.push(m[1]);
  }
  const classes = parseClasses(content);
  // Mask class bodies before scanning for top-level funs, otherwise member functions get extracted
  // twice (once here, once via parseMembers) → duplicate chunks / noise / cost.
  const topLevelFunctions = parseTopLevelFuns(maskClassBodies(content));
  return { pkg, imports, classes, topLevelFunctions };
}

/** Replace each class body (the `{...}` after a class/object/interface header) with spaces, preserving
 *  length so byte offsets stay valid. Leaves top-level declarations intact for top-level fun scanning. */
function maskClassBodies(content: string): string {
  const chars = content.split('');
  for (const m of content.matchAll(CLASS_RE)) {
    const bodyStart = (m.index ?? 0) + m[0].length - 1; // position of '{'
    const bodyEnd = findMatchingBrace(content, bodyStart);
    if (bodyEnd > bodyStart) {
      for (let i = bodyStart + 1; i < bodyEnd; i++) {
        if (chars[i] !== '\n') chars[i] = ' '; // keep newlines so line-based context is unaffected
      }
    }
  }
  return chars.join('');
}

function parseClasses(content: string): ParsedClass[] {
  const out: ParsedClass[] = [];
  for (const m of content.matchAll(CLASS_RE)) {
    const kdocBlock = m[1] ?? '';
    const annoBlock = m[2] ?? '';
    const kind = normalizeKind(m[3]);
    const name = m[4];
    const paramsRaw = m[5] ?? '';
    const superList = m[6]?.trim() ?? '';

    const headerStart = m.index ?? 0;
    const bodyStart = (m.index ?? 0) + m[0].length - 1; // position of '{'
    const bodyEnd = findMatchingBrace(content, bodyStart);
    const body = bodyEnd > bodyStart ? content.slice(bodyStart + 1, bodyEnd) : '';

    const annotations = parseAnnotations(annoBlock);
    const kdoc = parseKdoc(kdocBlock);
    const fields = parseFields(paramsRaw);
    const superTypes = parseSuperTypes(superList);

    let enumEntries: ParsedClass['enumEntries'];
    if (kind === 'enum') {
      enumEntries = parseEnumEntries(body);
    }

    const methods = parseMembers(body);
    out.push({ kind, name, superTypes, annotations, kdoc, fields, methods, enumEntries });
  }
  return out;
}

function parseTopLevelFuns(content: string): ParsedFunction[] {
  // Caller passes content with class bodies masked, so only genuine top-level funs remain.
  return parseFunsIn(content);
}

function parseMembers(body: string): ParsedFunction[] {
  return parseFunsIn(body);
}

function parseFunsIn(text: string): ParsedFunction[] {
  const out: ParsedFunction[] = [];
  for (const m of text.matchAll(FUN_RE)) {
    const kdocBlock = m[1] ?? '';
    const annoBlock = m[2] ?? '';
    const isSuspend = !!m[3];
    const name = m[4];
    const params = m[5] ?? '';
    const returnType = (m[6] ?? '').trim();
    const signature = m[0].replace(kdocBlock, '').replace(annoBlock, '').trim();

    // extract the method body (from the end of the signature, match { ... } or = ...)
    const sigEndAbs = (m.index ?? 0) + m[0].length;
    let bodyText: string | undefined;
    // expression body: fun foo() = expr
    if (text[sigEndAbs] === '=' || text[sigEndAbs - 1] === '=') {
      // up to the end of the next line, or up to the next fun/class
      const slice = text.slice(sigEndAbs).slice(0, MAX_BODY_BYTES);
      const stop = slice.search(/\n\s*(?:fun |class |object |interface |enum )/);
      bodyText = stop > 0 ? slice.slice(0, stop).trim() : slice.trim();
    } else {
      // block body: fun foo() { ... }
      const openIdx = text.indexOf('{', sigEndAbs);
      if (openIdx >= 0 && openIdx - sigEndAbs < 10) {
        const closeIdx = findMatchingBrace(text, openIdx);
        if (closeIdx > openIdx) {
          const raw = text.slice(openIdx + 1, closeIdx);
          bodyText = raw.length > MAX_BODY_BYTES
            ? raw.slice(0, MAX_BODY_BYTES) + '\n/* ...truncated... */'
            : raw;
        }
      }
    }

    out.push({
      name,
      signature,
      parameters: params.slice(1, -1),
      returnType,
      isSuspend,
      kdoc: parseKdoc(kdocBlock),
      annotations: parseAnnotations(annoBlock),
      bodyText: bodyText?.trim(),
    });
  }
  return out;
}

function parseEnumEntries(body: string): Array<{ name: string; argsRaw: string }> {
  // VALUE("01", "label"),  or  VALUE(code = "01", description = "label"),
  // only the region up to ; is an enum entry. companion etc. are skipped.
  const valuesArea = body.split(';')[0].split('companion ')[0];
  const RE = /(?:^|\n)\s*([A-Z][A-Z0-9_]*)\s*(\([^)]*\))?\s*[,;]?/gm;
  const out: Array<{ name: string; argsRaw: string }> = [];
  for (const m of valuesArea.matchAll(RE)) {
    out.push({ name: m[1], argsRaw: (m[2] ?? '').slice(1, -1) });
  }
  return out;
}

function parseFields(paramsRaw: string): ParsedField[] {
  if (!paramsRaw) return [];
  const inner = paramsRaw.replace(/^\(|\)$/g, '').trim();
  if (!inner) return [];
  // split on commas — ignore commas inside generics <T,U>
  const tokens = splitTopLevel(inner, ',');
  const out: ParsedField[] = [];
  for (const t of tokens) {
    const piece = t.trim();
    if (!piece) continue;
    // annotations
    const annos = parseAnnotations(piece);
    // val/var name: Type = default
    const m = piece.match(/(?:val|var)\s+(\w+)\s*:\s*([^=,)]+)/);
    if (!m) continue;
    out.push({ name: m[1].trim(), type: m[2].trim(), annotations: annos });
  }
  return out;
}

function parseSuperTypes(s: string): string[] {
  if (!s) return [];
  return splitTopLevel(s, ',')
    .map((x) => x.replace(/\([^)]*\)/g, '').trim())
    .filter((x) => x.length > 0);
}

function parseAnnotations(text: string): ParsedAnnotation[] {
  const out: ParsedAnnotation[] = [];
  for (const m of text.matchAll(ANNOTATION_RE)) {
    out.push({ name: '@' + m[1], argsRaw: m[2] ?? '' });
  }
  return out;
}

function parseKdoc(block: string): string | undefined {
  const m = block.match(/\/\*\*([\s\S]*?)\*\//);
  if (!m) return undefined;
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
}

function normalizeKind(s: string): ParsedClass['kind'] {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t === 'data class') return 'data class';
  if (t === 'enum class') return 'enum';
  if (t === 'interface') return 'interface';
  if (t === 'object') return 'object';
  return 'class';
}

function findMatchingBrace(s: string, openIdx: number): number {
  if (s[openIdx] !== '{') {
    const next = s.indexOf('{', openIdx);
    if (next < 0) return -1;
    openIdx = next;
  }
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}
