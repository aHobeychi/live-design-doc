// Margin layout: each note sits at its anchor's vertical position, colliding
// notes stack downward, and a hairline curve connects each note to its anchor.

const GAP = 8;

/**
 * Position note cards inside #margin and draw leader curves in #leaders.
 * cards: [{ el, targetId }] — targetId null for orphans (pinned to the top).
 */
export function layoutMargin() {
  const layout = document.getElementById('layout');
  const doc = document.getElementById('doc');
  const margin = document.getElementById('margin');
  const svg = document.getElementById('leaders');
  if (layout.hidden || window.matchMedia('(max-width: 1040px)').matches) return;

  const layoutRect = layout.getBoundingClientRect();
  const marginRect = margin.getBoundingClientRect();
  const cards = [...margin.querySelectorAll('.note')];

  const entries = cards.map((el) => {
    const targetId = el.dataset.target || null;
    const anchor = targetId ? doc.querySelector(`[data-id="${CSS.escape(targetId)}"]`) : null;
    const idealY = anchor
      ? anchor.getBoundingClientRect().top - marginRect.top
      : 0;
    return { el, anchor, idealY };
  });

  entries.sort((a, b) => a.idealY - b.idealY);

  let cursor = 0;
  for (const e of entries) {
    const y = Math.max(e.idealY, cursor);
    e.el.style.top = y + 'px';
    e.y = y;
    cursor = y + e.el.offsetHeight + GAP;
  }

  // Leader curves, drawn in layout-space so they can cross the gutter.
  svg.style.left = -(marginRect.left - layoutRect.left) + 'px';
  svg.style.top = '0';
  svg.setAttribute('width', layoutRect.width);
  svg.setAttribute('height', layout.scrollHeight);
  svg.innerHTML = entries
    .filter((e) => e.anchor)
    .map((e) => {
      const a = e.anchor.getBoundingClientRect();
      const x1 = a.right - layoutRect.left + 4;
      const y1 = a.top - layoutRect.top + Math.min(14, a.height / 2);
      const x2 = marginRect.left - layoutRect.left - 6;
      const y2 = e.y + (marginRect.top - layoutRect.top) + 14;
      const mx = (x1 + x2) / 2;
      return `<path class="leader" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`;
    })
    .join('');
}
