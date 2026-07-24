import type { BlockType } from '../types.js';

export interface RawBlock {
  type: BlockType;
  text: string;
  level?: number;
  listGroup?: number;
  marker?: string;
  checkbox?: 'todo' | 'done';
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function matchListItem(line: string): { indent: number; marker: string; content: string } | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  return { indent: m[1].length, marker: m[2], content: m[3] };
}

function isFence(line: string): string | null {
  const t = line.trimStart();
  if (t.startsWith('```')) return '```';
  if (t.startsWith('~~~')) return '~~~';
  return null;
}

/** Would this line start a non-paragraph block? Used to terminate paragraphs. */
function isBlockStart(line: string): boolean {
  return (
    isFence(line) !== null ||
    /^#{1,6}\s/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*>/.test(line) ||
    matchListItem(line) !== null
  );
}

/**
 * Split markdown into blocks: heading, paragraph, code fence, table, blockquote,
 * or a single list item. Blocks are the unit of addressing, anchoring, and progress.
 * Deliberate subset (see design §9.3): nested list items fold into their parent's
 * block, setext headings and reference links are unsupported.
 */
export function splitBlocks(markdown: string): RawBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let listGroup = 0;

  const push = (b: RawBlock) => {
    if (b.type === 'listItem') {
      const prev = blocks[blocks.length - 1];
      if (!prev || prev.type !== 'listItem') listGroup++;
      b.listGroup = listGroup;
    }
    blocks.push(b);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = isFence(line);
    if (fence) {
      const start = i;
      i++;
      while (i < lines.length && !(lines[i].trimStart().startsWith(fence) && lines[i].trim().length >= 3)) i++;
      if (i < lines.length) i++; // consume closing fence
      push({ type: 'code', text: lines.slice(start, i).join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      push({ type: 'heading', text: line, level: heading[1].length });
      i++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      push({ type: 'table', text: lines.slice(start, i).join('\n') });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*>/.test(lines[i])) i++;
      push({ type: 'blockquote', text: lines.slice(start, i).join('\n') });
      continue;
    }

    const item = matchListItem(line);
    if (item) {
      const start = i;
      const baseIndent = item.indent;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) break;
        const m = matchListItem(l);
        if (m && m.indent <= baseIndent) break; // next sibling or shallower item
        if (m || /^\s/.test(l)) {
          i++; // nested item or continuation line folds into this block
          continue;
        }
        break;
      }
      const cb = /^\[([ xX])\]\s/.exec(item.content);
      push({
        type: 'listItem',
        text: lines.slice(start, i).join('\n'),
        marker: item.marker,
        ...(cb ? { checkbox: cb[1] === ' ' ? ('todo' as const) : ('done' as const) } : {}),
      });
      continue;
    }

    const start = i;
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) i++;
    push({ type: 'paragraph', text: lines.slice(start, i).join('\n') });
  }

  return blocks;
}
