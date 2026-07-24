import { layoutMargin } from './margin.js';

const $ = (s) => document.querySelector(s);
const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let snap = null;
let prevText = new Map(); // block id -> normalized text, for change flashes
let pendingSelection = null;
let historyView = null; // revision number when viewing history, else null
let lastDocHtml = null; // last HTML committed to #doc, to skip no-op rebuilds

// ---- dialog & toast ----------------------------------------------------------

function confirmDialog({ title, body, okLabel = 'OK' }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').textContent = body;
  $('#dialog-ok').textContent = okLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}
$('#dialog-ok').onclick = () => $('#dialog').close('ok');
$('#dialog-cancel').onclick = () => $('#dialog').close('cancel');
$('#dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close('cancel'); // backdrop click
});

/** Modal with only a Close button; `build` fills the body element. */
function infoDialog(title, build) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  const body = $('#dialog-body');
  body.textContent = '';
  build(body);
  $('#dialog-ok').textContent = 'Close';
  $('#dialog-cancel').hidden = true;
  dlg.showModal();
  dlg.addEventListener('close', () => ($('#dialog-cancel').hidden = false), { once: true });
}

let toastTimer = null;
function toast(message, kind = 'error') {
  const el = $('#toast');
  el.textContent = message;
  el.className = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
const oops = (e) => toast(e.message || String(e));

// ---- @file mentions ----------------------------------------------------------

let fileListPromise = null;
function projectFiles() {
  fileListPromise ??= api('GET', '/api/files').then((d) => d.files, () => []);
  return fileListPromise;
}

const MENTION_TOKEN = /@([\w./-]*)$/;

/** Wire @-autocomplete over project files into a textarea. */
function attachMentions(ta) {
  const menu = $('#mention');
  let items = [];
  let active = 0;

  const close = () => {
    menu.hidden = true;
    items = [];
  };
  const tokenAt = () => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = MENTION_TOKEN.exec(upto);
    return m ? { start: upto.length - m[0].length, query: m[1] } : null;
  };
  const renderMenu = () => {
    if (items.length === 0) return close();
    menu.innerHTML = '';
    items.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'mention-item' + (i === active ? ' active' : '');
      d.textContent = f;
      d.onmousedown = (e) => {
        e.preventDefault();
        pick(i);
      };
      menu.appendChild(d);
    });
    const r = ta.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    menu.style.minWidth = r.width + 'px';
    menu.style.maxWidth = Math.max(r.width, 360) + 'px';
    menu.hidden = false;
  };
  const pick = (i) => {
    const tok = tokenAt();
    if (!tok || !items[i]) return close();
    const before = ta.value.slice(0, tok.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}@${items[i]} ${after}`;
    const pos = before.length + items[i].length + 2;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    close();
  };

  ta.addEventListener('input', async () => {
    const tok = tokenAt();
    if (!tok) return close();
    const files = await projectFiles();
    const q = tok.query.toLowerCase();
    items = files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
    active = 0;
    renderMenu();
  });
  ta.addEventListener('keydown', (e) => {
    if (menu.hidden || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % items.length;
      renderMenu();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      renderMenu();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  ta.addEventListener('blur', () => setTimeout(close, 120));
}

/** Set note text with @file references rendered as code chips. */
function setBodyWithRefs(el, text) {
  el.textContent = '';
  const re = /@[\w./-]*[\w/]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    el.append(text.slice(last, m.index));
    const chip = document.createElement('code');
    chip.className = 'fileref';
    chip.dataset.path = m[0].slice(1);
    chip.textContent = m[0];
    el.append(chip);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

// ---- load & render ----------------------------------------------------------

async function load() {
  snap = await api('GET', '/api/doc');
  render();
}

let loadTimer = null;
function scheduleLoad() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => load().catch(() => {}), 80);
}

function render() {
  if (historyView !== null) return; // frozen on a past revision; Back reloads
  const { status, revision, blocks, notes, questions } = snap;
  $('#file').textContent = snap.file.split('/').pop();
  $('#rev').textContent = revision > 0 ? `rev ${String(revision).padStart(3, '0')}` : '';
  const chip = $('#status-chip');
  chip.textContent = status;
  chip.dataset.status = status;

  const clarifying = status === 'clarifying' && questions;
  const waiting = !clarifying && blocks.length === 0;
  $('#clarify').hidden = !clarifying;
  $('#layout').hidden = clarifying || waiting;
  $('#waiting').hidden = !waiting;
  if (waiting) $('#waiting').textContent = 'Waiting for the agent to draft…';
  if (clarifying) renderClarify(questions);
  else if (!waiting) renderDoc(blocks, notes);

  renderChrome(status, notes);
}

function renderChrome(status, notes) {
  const unsent = notes.filter((n) => n.state === 'new').length;
  $('#unsent').textContent = unsent ? `${unsent} unsent` : '';
  $('#send').disabled = unsent === 0;
  $('#approve').hidden = status !== 'review';
  $('#send').hidden = !['review', 'approved', 'executing'].includes(status);
  $('#hint').textContent =
    status === 'review' ? 'Select text to add a note' :
    status === 'clarifying' ? 'Answer or skip — silence is an answer' : '';

  const banner = $('#banner');
  if (status === 'approved') {
    banner.hidden = false;
    banner.textContent = 'Approved — the plan is frozen. The agent is starting the build.';
  } else if (status === 'done') {
    banner.hidden = false;
    banner.textContent = 'Build complete.';
  } else banner.hidden = true;

  const boxes = snap.blocks.filter((b) => b.checkbox);
  const doneCount = boxes.filter((b) => snap.progress[b.id] || b.checkbox === 'done').length;
  const pc = $('#progress-count');
  pc.hidden = !['executing', 'done'].includes(status) || boxes.length === 0;
  pc.textContent = `${doneCount}/${boxes.length} done`;
}

function renderDoc(blocks, notes) {
  const doc = $('#doc');
  // Rebuilding #doc on every poll — even ones triggered by an unrelated
  // note/progress/status event — tears down live DOM nodes and silently
  // kills any in-progress text selection (the SSE reconnect right after
  // page load is the classic case: it lands while the reviewer is still
  // selecting the first paragraph). Skip the rebuild when the markup is
  // unchanged so a selection survives no-op reloads.
  const html = blocks.map((b) => b.html).join('');
  if (html !== lastDocHtml) {
    doc.innerHTML = html;
    lastDocHtml = html;
  }

  const changed = new Set(snap.lastChanged?.changed ?? []);
  const added = new Set(snap.lastChanged?.added ?? []);
  for (const b of blocks) {
    const el = doc.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
    if (!el) continue;
    if (prevText.size > 0 && prevText.get(b.id) !== b.normalized) el.classList.add('flash');
    // Persistent gentle-diff badge: what the last push touched.
    // (`dataset.revtag = ''` would still leave the attribute present and
    // match the `[data-revtag]` CSS selector — must remove it outright.)
    if (snap.status === 'review' && snap.revision > 1 && (changed.has(b.id) || added.has(b.id))) {
      el.dataset.revtag = changed.has(b.id) ? 'edited' : 'new';
    } else {
      delete el.dataset.revtag;
    }
    const entry = snap.progress[b.id];
    el.classList.toggle('done', !!entry);
    el.querySelector('.evidence')?.remove();
    if (entry) {
      const ev = document.createElement('div');
      ev.className = 'evidence';
      setBodyWithRefs(ev, entry.did + (entry.files.length ? ' — ' + entry.files.map((f) => '@' + f).join(' ') : ''));
      (el.querySelector('.li-body') ?? el).appendChild(ev);
    }
  }
  prevText = new Map(blocks.map((b) => [b.id, b.normalized]));

  renderToc(blocks);
  renderNotes(notes);
}

// ---- table of contents -------------------------------------------------------

function renderToc(blocks) {
  const toc = $('#toc');
  const headings = blocks.filter((b) => b.type === 'heading' && (b.level ?? 1) <= 3);
  if (headings.length < 2) {
    toc.innerHTML = '';
    return;
  }
  toc.innerHTML = '<div class="toc-title">Contents</div>';
  // Indent relative to the shallowest heading so a doc of all-h2s starts flush.
  const minLevel = Math.min(...headings.map((h) => h.level ?? 1));
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.target = h.id;
    a.dataset.level = String(Math.min((h.level ?? 1) - minLevel + 1, 3));
    a.textContent = h.text
      .replace(/^#{1,6}\s+/, '')
      .replace(/[`*_]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    a.title = a.textContent;
    a.onclick = (e) => {
      e.preventDefault();
      $('#doc')
        ?.querySelector(`[data-id="${CSS.escape(h.id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    toc.appendChild(a);
  }
  updateTocActive();
}

/** Scrollspy: highlight the last heading at or above the reading line. */
function updateTocActive() {
  const links = document.querySelectorAll('#toc a[data-target]');
  if (links.length === 0) return;
  let current = links[0];
  for (const a of links) {
    const el = $('#doc')?.querySelector(`[data-id="${CSS.escape(a.dataset.target)}"]`);
    if (el && el.getBoundingClientRect().top <= 90) current = a;
  }
  for (const a of links) a.classList.toggle('active', a === current);
  current.scrollIntoView({ block: 'nearest' });
}

let spyTick = false;
window.addEventListener(
  'scroll',
  () => {
    if (spyTick) return;
    spyTick = true;
    requestAnimationFrame(() => {
      spyTick = false;
      updateTocActive();
    });
  },
  { passive: true }
);

function renderNotes(notes) {
  const box = $('#notes');
  box.innerHTML = '';
  for (const n of notes) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.state = n.state;
    // In history mode the original anchor is the truth for that revision.
    el.dataset.target = (historyView !== null ? n.blockId : n.resolved.blockId) || '';
    const badge =
      `<span class="badge intent-${n.intent}">${n.intent}</span>` +
      (n.resolved.fidelity === 'moved' ? '<span class="badge moved">moved</span>' :
       n.resolved.fidelity === 'approximate' ? '<span class="badge approximate">moved?</span>' :
       n.resolved.fidelity === 'orphan' ? '<span class="badge orphan">text is gone</span>' : '');
    el.innerHTML =
      (n.state === 'new' && !historyView
        ? '<button class="del" title="Delete unsent note">×</button>' +
          '<button class="edit" title="Edit unsent note">✎</button>'
        : '') +
      badge +
      `<span class="quote"></span><span class="body"></span>`;
    el.querySelector('.quote').textContent = `“${n.quote}”`;
    setBodyWithRefs(el.querySelector('.body'), n.body);
    if (n.suggestion) {
      const s = document.createElement('div');
      s.className = 'suggestion';
      s.innerHTML = '<span class="label">suggested wording</span>';
      s.append(n.suggestion);
      el.appendChild(s);
    }
    // "Did my note land?" — before/after of just this note's block.
    const currentBlock = snap.blocks.find((b) => b.id === n.resolved.blockId);
    if (
      n.state === 'sent' &&
      !historyView &&
      currentBlock &&
      currentBlock.text.trim() !== n.blockTextAtCreation.trim()
    ) {
      const cmp = document.createElement('button');
      cmp.className = 'linkish compare';
      cmp.textContent = 'view change';
      cmp.onclick = () =>
        infoDialog('What changed here', (body) => {
          body.className = 'beforeafter';
          const mk = (label, text, cls) => {
            const l = document.createElement('div');
            l.className = 'ba-label';
            l.textContent = label;
            const t = document.createElement('div');
            t.className = 'ba-text ' + cls;
            t.textContent = text;
            body.append(l, t);
          };
          mk(`when you wrote this note (rev ${n.createdAgainstRevision})`, n.blockTextAtCreation, 'before');
          mk(`now (rev ${snap.revision})`, currentBlock.text, 'after');
        });
      el.appendChild(cmp);
    }
    if (n.state === 'new' && !historyView) {
      el.querySelector('.del').onclick = () =>
        api('DELETE', `/api/comments/${n.id}`).then(load).catch(oops);
      el.querySelector('.edit').onclick = () => startEdit(el, n);
      el.querySelector('.body').ondblclick = () => startEdit(el, n);
    }
    el.onmouseenter = () => highlight(el.dataset.target, true);
    el.onmouseleave = () => highlight(el.dataset.target, false);
    box.appendChild(el);
  }
  requestAnimationFrame(layoutMargin);
}

function startEdit(el, n) {
  if (el.querySelector('textarea')) return;
  const body = el.querySelector('.body');
  el.querySelector('.suggestion')?.remove();
  const ta = document.createElement('textarea');
  ta.className = 'edit-ta';
  ta.value = n.body;
  const sa = document.createElement('textarea');
  sa.className = 'edit-ta';
  sa.placeholder = 'Suggested wording (optional)';
  sa.value = n.suggestion ?? '';
  const row = document.createElement('div');
  row.className = 'edit-row';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const commit = () => {
    const text = ta.value.trim();
    if (!text) return load();
    api('PATCH', `/api/comments/${n.id}`, { body: text, suggestion: sa.value.trim() })
      .then(load)
      .catch(oops);
  };
  save.onclick = commit;
  cancel.onclick = () => load();
  for (const t of [ta, sa]) {
    t.onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commit();
      if (e.key === 'Escape') load();
    };
    attachMentions(t);
  }
  row.append(cancel, save);
  body.replaceWith(ta, sa, row);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  requestAnimationFrame(layoutMargin);
}

function highlight(blockId, on) {
  if (!blockId) return;
  const el = $('#doc')?.querySelector(`[data-id="${CSS.escape(blockId)}"]`);
  if (el) el.classList.toggle('note-target', on);
}

// ---- history ----------------------------------------------------------------

$('#history-btn').onclick = async () => {
  const panel = $('#history-panel');
  if (!panel.hidden) return void (panel.hidden = true);
  const { revisions } = await api('GET', '/api/history').catch(() => ({ revisions: [] }));
  panel.innerHTML = '';
  for (const r of [...revisions].reverse()) {
    const b = document.createElement('button');
    b.className = 'hist-rev';
    const label = document.createElement('div');
    label.textContent = `rev ${String(r.revision).padStart(3, '0')}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      (r.current ? 'current · ' : '') +
      (r.notes.length ? `${r.notes.length} note${r.notes.length > 1 ? 's' : ''}` : 'no notes');
    b.append(label, meta);
    b.onclick = () => {
      panel.hidden = true;
      if (r.current) backToLive();
      else openRevision(r.revision);
    };
    panel.appendChild(b);
  }
  panel.hidden = revisions.length === 0;
};

async function openRevision(n) {
  const { blocks } = await api('GET', `/api/revision?n=${n}`).catch((e) => (oops(e), { blocks: null }));
  if (!blocks) return;
  historyView = n;
  document.body.classList.add('history-mode');
  $('#clarify').hidden = true;
  $('#waiting').hidden = true;
  $('#layout').hidden = false;
  $('#doc').innerHTML = blocks.map((b) => b.html).join('');
  $('#rev').textContent = `rev ${String(n).padStart(3, '0')}`;
  renderToc(blocks);
  renderNotes(snap.notes.filter((x) => x.createdAgainstRevision === n));
  const banner = $('#banner');
  banner.hidden = false;
  banner.textContent = `Viewing revision ${n} — read-only. `;
  const back = document.createElement('button');
  back.className = 'linkish';
  back.textContent = 'back to live';
  back.onclick = backToLive;
  banner.appendChild(back);
}

function backToLive() {
  historyView = null;
  document.body.classList.remove('history-mode');
  prevText = new Map(); // no change-flashes against a historical render
  lastDocHtml = null; // #doc currently holds a historical revision's markup
  load().catch(oops);
}

function renderClarify(questions) {
  const root = $('#clarify');
  root.innerHTML = '<h1>Before I draft</h1><div class="sub">Every question is skippable</div>';
  for (const q of questions) {
    const div = document.createElement('div');
    div.className = 'question';
    div.dataset.qid = q.id;
    div.dataset.kind = q.kind;
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = q.prompt;
    div.appendChild(prompt);
    if (q.kind === 'text') {
      const input = document.createElement('input');
      input.type = 'text';
      div.appendChild(input);
    } else {
      for (const o of q.options || []) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = q.kind === 'multi' ? 'checkbox' : 'radio';
        input.name = 'q-' + q.id;
        input.value = o.value;
        label.append(input, o.label);
        div.appendChild(label);
      }
    }
    root.appendChild(div);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  const submit = document.createElement('button');
  submit.className = 'primary';
  submit.textContent = 'Send answers';
  submit.onclick = () => submitAnswers(false);
  const skip = document.createElement('button');
  skip.textContent = 'Just draft it';
  skip.onclick = () => submitAnswers(true);
  actions.append(submit, skip);
  root.appendChild(actions);
}

function submitAnswers(skipAll) {
  const answers = [];
  if (!skipAll) {
    for (const div of document.querySelectorAll('.question')) {
      const id = div.dataset.qid;
      if (div.dataset.kind === 'text') {
        const v = div.querySelector('input[type="text"]').value.trim();
        if (v) answers.push({ id, value: v });
      } else if (div.dataset.kind === 'multi') {
        const vs = [...div.querySelectorAll('input:checked')].map((i) => i.value);
        if (vs.length) answers.push({ id, value: vs });
      } else {
        const v = div.querySelector('input:checked');
        if (v) answers.push({ id, value: v.value });
      }
    }
  }
  api('POST', '/api/answers', { answers }).then(load).catch(oops);
}

// ---- selection → note -------------------------------------------------------

document.addEventListener('pointerup', (e) => {
  if (e.target.closest?.('#addnote, #composer')) return;
  setTimeout(maybeShowAddNote, 1);
});
// Keep the selection alive when the button itself is pressed.
document.getElementById('addnote').addEventListener('mousedown', (e) => e.preventDefault());
// Word/paragraph selections land on dblclick, after the last pointerup.
document.addEventListener('dblclick', () => setTimeout(maybeShowAddNote, 1));
document.addEventListener('keyup', (e) => {
  if (e.key === 'Escape') {
    $('#composer').hidden = true;
    $('#addnote').hidden = true;
  }
});

function maybeShowAddNote() {
  const btn = $('#addnote');
  if (historyView !== null) return void (btn.hidden = true); // past revisions are read-only
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    btn.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  // Anchor on the block where the selection STARTS: double/triple-click
  // selections extend to offset 0 of the next block, so the range's common
  // ancestor is useless. The substring check below still enforces the
  // one-block rule for genuine cross-block selections.
  const start = range.startContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
  const blockEl = el?.closest('.block[data-id]');
  if (!blockEl || !$('#doc').contains(blockEl)) {
    btn.hidden = true;
    return;
  }
  const quote = sel.toString().trim();
  const blockText = blockEl.textContent;
  const at = blockText.indexOf(quote);
  if (at < 0) {
    btn.hidden = true;
    return;
  }
  pendingSelection = {
    blockId: blockEl.dataset.id,
    quote,
    contextBefore: blockText.slice(Math.max(0, at - 40), at),
    contextAfter: blockText.slice(at + quote.length, at + quote.length + 40),
  };
  // Position against the block, not the range: a spilled-over range's rect
  // can extend past the paragraph.
  const r = blockEl.getBoundingClientRect();
  btn.style.left = window.scrollX + r.right + 8 + 'px';
  btn.style.top = window.scrollY + r.top - 4 + 'px';
  btn.hidden = false;
}

let composerIntent = 'change';
for (const chip of document.querySelectorAll('#composer-intent .intent-chip')) {
  chip.onclick = () => {
    composerIntent = chip.dataset.intent;
    for (const c of document.querySelectorAll('#composer-intent .intent-chip')) {
      c.classList.toggle('active', c === chip);
    }
  };
}

$('#composer-suggest').onclick = () => {
  const ta = $('#composer-suggestion');
  ta.hidden = !ta.hidden;
  if (!ta.hidden) {
    if (!ta.value) ta.value = pendingSelection?.quote ?? '';
    ta.focus();
  }
};

$('#addnote').onclick = () => {
  if (!pendingSelection) return;
  $('#addnote').hidden = true;
  $('#composer-quote').textContent = `“${pendingSelection.quote}”`;
  $('#composer-text').value = '';
  $('#composer-suggestion').value = '';
  $('#composer-suggestion').hidden = true;
  document.querySelector('#composer-intent [data-intent="change"]').click();
  $('#composer').hidden = false;
  $('#composer-text').focus();
};

$('#composer-cancel').onclick = () => ($('#composer').hidden = true);
$('#composer-save').onclick = () => {
  const body = $('#composer-text').value.trim();
  if (!body || !pendingSelection) return;
  const suggestion = $('#composer-suggestion').hidden ? '' : $('#composer-suggestion').value.trim();
  api('POST', '/api/comments', { ...pendingSelection, body, intent: composerIntent, suggestion })
    .then(() => {
      $('#composer').hidden = true;
      window.getSelection()?.removeAllRanges();
      return load();
    })
    .catch(oops);
};
$('#composer-text').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#composer-save').click();
});
attachMentions($('#composer-text'));
attachMentions($('#composer-suggestion'));

// ---- @file hover previews ----------------------------------------------------

const previewCache = new Map();
let previewTimer = null;

document.addEventListener('mouseover', (e) => {
  const ref = e.target.closest?.('.fileref[data-path]');
  if (!ref) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const path = ref.dataset.path;
    let data = previewCache.get(path);
    if (data === undefined) {
      data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`).catch(() => null);
      previewCache.set(path, data);
    }
    const pv = $('#preview');
    pv.textContent = '';
    const head = document.createElement('div');
    head.className = 'pv-head';
    head.textContent = data
      ? path + (data.truncated ? ` — first 160 of ${data.lines} lines` : '')
      : `${path} — not found in project`;
    pv.appendChild(head);
    if (data) {
      const pre = document.createElement('pre');
      pre.textContent = data.content;
      pv.appendChild(pre);
    }
    const r = ref.getBoundingClientRect();
    pv.hidden = false;
    const below = r.bottom + 8 + pv.offsetHeight < window.innerHeight;
    pv.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - pv.offsetHeight - 8)) + 'px';
    pv.style.left = Math.min(r.left, window.innerWidth - pv.offsetWidth - 24) + 'px';
  }, 220);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.fileref[data-path]')) {
    clearTimeout(previewTimer);
    $('#preview').hidden = true;
  }
});

// ---- send & approve ---------------------------------------------------------

$('#send').onclick = () => api('POST', '/api/send').then(load).catch(oops);
$('#approve').onclick = async () => {
  const unsent = snap ? snap.notes.filter((n) => n.state === 'new').length : 0;
  const ok = await confirmDialog({
    title: 'Approve this plan',
    body:
      'The document will be frozen and the agent will build from it.' +
      (unsent ? ` You have ${unsent} unsent note${unsent > 1 ? 's' : ''} the agent will never see.` : ''),
    okLabel: 'Approve',
  });
  if (ok) api('POST', '/api/approve').then(load).catch(oops);
};

// ---- live updates -----------------------------------------------------------

const es = new EventSource('/api/events');
for (const ev of ['revision', 'note', 'status', 'progress', 'questions']) {
  es.addEventListener(ev, scheduleLoad);
}
es.onopen = scheduleLoad;

window.addEventListener('resize', () => requestAnimationFrame(layoutMargin));

load().catch((e) => {
  $('#waiting').hidden = false;
  $('#waiting').textContent = 'Cannot reach the livedoc daemon: ' + e.message;
});
