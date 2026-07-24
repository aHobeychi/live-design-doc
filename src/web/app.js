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
  const doneCount = boxes.filter((b) => snap.progress[b.id] === 'done' || b.checkbox === 'done').length;
  const pc = $('#progress-count');
  pc.hidden = !['executing', 'done'].includes(status) || boxes.length === 0;
  pc.textContent = `${doneCount}/${boxes.length} done`;
}

function renderDoc(blocks, notes) {
  const doc = $('#doc');
  doc.innerHTML = blocks.map((b) => b.html).join('');

  for (const b of blocks) {
    const el = doc.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
    if (!el) continue;
    if (prevText.size > 0 && prevText.get(b.id) !== b.normalized) el.classList.add('flash');
    if (snap.progress[b.id] === 'done') el.classList.add('done');
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
    el.dataset.target = n.resolved.blockId || '';
    const badge =
      n.resolved.fidelity === 'moved' ? '<span class="badge moved">moved</span>' :
      n.resolved.fidelity === 'approximate' ? '<span class="badge approximate">moved?</span>' :
      n.resolved.fidelity === 'orphan' ? '<span class="badge orphan">text is gone</span>' : '';
    el.innerHTML =
      (n.state === 'new'
        ? '<button class="del" title="Delete unsent note">×</button>' +
          '<button class="edit" title="Edit unsent note">✎</button>'
        : '') +
      badge +
      `<span class="quote"></span><span class="body"></span>`;
    el.querySelector('.quote').textContent = `“${n.quote}”`;
    el.querySelector('.body').textContent = n.body;
    if (n.state === 'new') {
      el.querySelector('.del').onclick = () =>
        api('DELETE', `/api/comments/${n.id}`).then(load).catch(oops);
      el.querySelector('.edit').onclick = () => startEdit(el, n);
      el.querySelector('.body').ondblclick = () => startEdit(el, n);
    }
    el.onmouseenter = () => highlight(n.resolved.blockId, true);
    el.onmouseleave = () => highlight(n.resolved.blockId, false);
    box.appendChild(el);
  }
  requestAnimationFrame(layoutMargin);
}

function startEdit(el, n) {
  if (el.querySelector('textarea')) return;
  const body = el.querySelector('.body');
  const ta = document.createElement('textarea');
  ta.className = 'edit-ta';
  ta.value = n.body;
  const row = document.createElement('div');
  row.className = 'edit-row';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const commit = () => {
    const text = ta.value.trim();
    if (!text || text === n.body) return load();
    api('PATCH', `/api/comments/${n.id}`, { body: text }).then(load).catch(oops);
  };
  save.onclick = commit;
  cancel.onclick = () => load();
  ta.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commit();
    if (e.key === 'Escape') load();
  };
  row.append(cancel, save);
  body.replaceWith(ta, row);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  requestAnimationFrame(layoutMargin);
}

function highlight(blockId, on) {
  if (!blockId) return;
  const el = $('#doc')?.querySelector(`[data-id="${CSS.escape(blockId)}"]`);
  if (el) el.classList.toggle('note-target', on);
}

// ---- clarify phase ----------------------------------------------------------

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

$('#addnote').onclick = () => {
  if (!pendingSelection) return;
  $('#addnote').hidden = true;
  $('#composer-quote').textContent = `“${pendingSelection.quote}”`;
  $('#composer-text').value = '';
  $('#composer').hidden = false;
  $('#composer-text').focus();
};

$('#composer-cancel').onclick = () => ($('#composer').hidden = true);
$('#composer-save').onclick = () => {
  const body = $('#composer-text').value.trim();
  if (!body || !pendingSelection) return;
  api('POST', '/api/comments', { ...pendingSelection, body })
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
