import { createHash } from 'node:crypto';
import type { Block } from '../types.js';
import { normalize, splitBlocks, type RawBlock } from './blocks.js';

const EXPLICIT_ID_RE = /\s*\{#([a-zA-Z0-9][\w-]*)\}\s*$/;

/**
 * Extract a trailing {#id} marker from the block's last content line.
 * Code blocks never carry explicit ids — a {#x} inside a fence is code.
 */
function extractExplicitId(raw: RawBlock): { id: string | null; text: string } {
  if (raw.type === 'code') return { id: null, text: raw.text };
  const lines = raw.text.split('\n');
  const last = lines[lines.length - 1];
  const m = EXPLICIT_ID_RE.exec(last);
  if (!m) return { id: null, text: raw.text };
  lines[lines.length - 1] = last.slice(0, m.index).replace(/\s+$/, '');
  return { id: m[1], text: lines.join('\n') };
}

/**
 * Assign ids: explicit {#id} when present, otherwise `b-` + 8 hex chars of the
 * SHA-256 of the normalized text — stable across revisions iff the text is
 * unchanged. Duplicate ids get deterministic -2, -3 suffixes in document order.
 */
export function assignIds(raws: RawBlock[]): Block[] {
  const used = new Map<string, number>();
  return raws.map((raw) => {
    const { id: explicit, text } = extractExplicitId(raw);
    const normalized = normalize(text);
    let id = explicit ?? 'b-' + createHash('sha256').update(normalized).digest('hex').slice(0, 8);
    const count = used.get(id) ?? 0;
    used.set(id, count + 1);
    if (count > 0) id = `${id}-${count + 1}`;
    const { text: _raw, ...rest } = raw;
    return { ...rest, id, text, normalized };
  });
}

export function parseDocument(markdown: string): Block[] {
  return assignIds(splitBlocks(markdown));
}
