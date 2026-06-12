/**
 * embeddingText template variable substitution. {{var}} pattern.
 */

export function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}
