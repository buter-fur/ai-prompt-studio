/* ==========================================================================
   AI 文生图提示词工作台 —— 前端逻辑
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const svgIcon = (id, cls = 'ico ico-sm') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const ICON_EDIT = svgIcon('i-edit');
const ICON_TRASH = svgIcon('i-trash');

/* 主题：三档循环 跟随系统 → 浅色 → 深色 */
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_META = {
  system: { icon: '#i-monitor', label: '跟随系统' },
  light: { icon: '#i-sun', label: '浅色' },
  dark: { icon: '#i-moon', label: '深色' },
};

const LANG_LABEL = { zh: '中文', en: 'English', both: '中英对照' };

/* 分类图标键（对应 index.html 里的 #i-cat-* 符号） */
const CAT_ICON_KEYS = [
  'grid', 'scene', 'character', 'color', 'style', 'quality', 'camera', 'mood',
  'functional', 'negative', 'animal', 'plant', 'food', 'object', 'effect',
  'era', 'medium', 'typography', 'base', 'star', 'heart', 'music', 'game',
  'science', 'city', 'travel', 'magic',
];

const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 3;

const state = {
  categories: [],
  tagIndex: [],
  tagSource: 'builtin',
  settings: {},
  presets: [],
  history: [],
  parked: { pos: [], neg: [] },
  slots: [],
  templates: { negativeTemplates: [], inspiration: { themes: [] } },
  zhIndex: new Map(),
  lang: 'both',
  theme: 'system',
  activeCat: null,
  libActiveCat: null,
  image: null,
  drag: null,
  lastComboKey: '',
  debounceTimer: null,
  parkedTimer: null,
  inspireTheme: null,
  inspireCandidates: [],
  compareOpen: false,
  libDrag: null,
  polishWeightItems: [],
  polishWeightOriginal: [],
  polishBaseResult: '',
  appliedWeights: new Set(),
};

const DEFAULT_USER_PROMPT = '请解析这张图片，输出可用于文生图模型的提示词。';

/* ============================ 工具函数 ================================== */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(message, ms = 2000) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 220);
  }, ms);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try { data = await response.json(); } catch (_) { /* 忽略 */ }
  if (!response.ok) {
    const err = new Error(data.error || `请求失败 (${response.status})`);
    err.detail = data.detail;
    err.url = data.url;
    err.reasoning = data.reasoning;
    err.finishReason = data.finishReason;
    throw err;
  }
  return data;
}

/** 展开 / 收起推理模型的思考过程；没有内容就把整块隐藏 */
function showReasoning(boxId, text, expanded) {
  const box = $(`#${boxId}`);
  const body = $(`#${boxId}Body`);
  if (!box || !body) return;
  if (!text) {
    box.hidden = true;
    box.classList.remove('is-open');
    body.textContent = '';
    return;
  }
  box.hidden = false;
  body.textContent = text;
  box.classList.toggle('is-open', !!expanded);
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

const sideTextarea = (side) => $(side === 'neg' ? '#negText' : '#promptText');
const sideContainer = (side) => $(side === 'neg' ? '#chipsNeg' : '#chipsPos');

/* =========================== 分类图标 =================================== */

function catIcon(cat, cls = 'ico cat-svg') {
  const key = String((cat && cat.icon) || '').trim();
  if (CAT_ICON_KEYS.includes(key)) {
    return `<svg class="${cls}"><use href="#i-cat-${key}"/></svg>`;
  }
  return `<span class="cat-char">${esc(key || '•')}</span>`;
}

/* ============================ 主题引擎 ================================== */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  if (state.theme === 'system') return darkQuery.matches ? 'dark' : 'light';
  return state.theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
  const meta = THEME_META[state.theme] || THEME_META.system;
  const use = $('#themeIcon').querySelector('use');
  if (use) use.setAttribute('href', meta.icon);
  $('#themeLabel').textContent = meta.label;
  $('#btnTheme').title = `主题：${meta.label} · 点击切换`;
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
  state.theme = next;
  state.settings.theme = next;
  applyTheme();
  api('/api/settings', { method: 'POST', body: JSON.stringify({ theme: next }) }).catch(() => {});
  toast(`主题：${THEME_META[next].label}`);
}

darkQuery.addEventListener?.('change', () => { if (state.theme === 'system') applyTheme(); });

/* ========================= 提示词分段模型 =============================== */

const clampWeight = (value) => {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, rounded));
};

/**
 * 解析一个逗号片段。支持 A1111 / ComfyUI 常见写法：
 *   masterpiece        → 无权重
 *   (masterpiece)      → 1.10
 *   ((masterpiece))    → 1.21
 *   [masterpiece]      → 0.90
 *   (masterpiece:1.4)  → 1.40
 */
function parseSegment(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  let m = text.match(/^\(+\s*([\s\S]*?)\s*:\s*([0-9]*\.?[0-9]+)\s*\)+$/);
  if (m) {
    const base = m[1].replace(/^\(+/, '').replace(/\)+$/, '').trim();
    if (base) return { base, weight: clampWeight(parseFloat(m[2])) };
  }

  m = text.match(/^(\(+)([\s\S]+?)(\)+)$/);
  if (m && m[1].length === m[3].length) {
    const base = m[2].trim();
    if (base && !/[:()]/.test(base)) {
      return { base, weight: clampWeight(Math.pow(1.1, m[1].length)) };
    }
  }

  m = text.match(/^(\[+)([\s\S]+?)(\]+)$/);
  if (m && m[1].length === m[3].length) {
    const base = m[2].trim();
    if (base && !/[\[\]]/.test(base)) {
      return { base, weight: clampWeight(Math.pow(0.9, m[1].length)) };
    }
  }

  return { base: text, weight: null };
}

function formatSegment(item) {
  const w = item.weight;
  if (w === null || w === undefined || Math.abs(w - 1) < 0.005) return item.base;
  return `(${item.base}:${Number(w.toFixed(2))})`;
}

function parseSegments(text) {
  return String(text || '')
    .split(/[,，]/)
    .map(parseSegment)
    .filter(Boolean);
}

const serializeSegments = (items) => items.map(formatSegment).join(', ');

const hasWeight = (item) => item.weight !== null && item.weight !== undefined
  && Math.abs(item.weight - 1) > 0.005;

function writeSide(side, items) {
  sideTextarea(side).value = serializeSegments(items);
  commitUndo();
  onPromptChanged();
  renderTags();
}

/* ============================ 标签索引 ================================== */

function buildIndex() {
  const index = [];
  for (const cat of state.categories) {
    for (const group of cat.groups || []) {
      for (const tag of group.tags || []) {
        index.push({
          zh: tag.zh,
          en: tag.en,
          catId: cat.id,
          catName: cat.name,
          catNameEn: cat.nameEn,
          groupId: group.id,
          groupName: group.name,
          groupNameEn: group.nameEn,
          negative: !!cat.negative,
        });
      }
    }
  }
  state.tagIndex = index;

  state.zhIndex = new Map();
  for (const tag of index) {
    if (!state.zhIndex.has(tag.zh)) state.zhIndex.set(tag.zh, tag);
  }
}

const tagByEn = (en) => state.tagIndex.find((t) => t.en.toLowerCase() === String(en).toLowerCase());

function activeTagSet(negative) {
  const set = new Set();
  parseSegments(sideTextarea(negative ? 'neg' : 'pos').value)
    .forEach((item) => set.add(item.base.toLowerCase()));
  return set;
}

/* ============================ 渲染：分类 ================================ */

function catLabel(cat) {
  if (state.lang === 'en') return cat.nameEn || cat.name;
  return cat.name;
}

function tagCount(cat) {
  return (cat.groups || []).reduce((sum, g) => sum + (g.tags || []).length, 0);
}

function renderCategories() {
  const box = $('#catList');
  const all = [{
    id: '__all__', name: '全部标签', nameEn: 'All', icon: 'grid', fixed: true,
    groups: state.categories.flatMap((c) => c.groups || []),
  }, ...state.categories];

  box.innerHTML = all.map((cat) => {
    const active = (state.activeCat || '__all__') === cat.id ? ' is-active' : '';
    const sub = state.lang === 'both' ? (cat.nameEn || '') : '';
    const drag = cat.fixed
      ? ''
      : ' data-drag="cat" draggable="true" title="拖动可调整分类顺序"';
    return `
      <div class="cat-item${active}" data-cat="${esc(cat.id)}" role="button" tabindex="0"${drag}>
        <span class="cat-ico">${catIcon(cat)}</span>
        <span class="cat-name">${esc(catLabel(cat))}${sub ? `<br><small class="cat-sub">${esc(sub)}</small>` : ''}</span>
        <span class="cat-n">${tagCount(cat)}</span>
      </div>`;
  }).join('');

  $('#catCount').textContent =
    `共 ${state.categories.length} 个分类 · ${state.tagIndex.length} 个标签`
    + (state.tagSource === 'user' ? ' · 自定义库' : '');

  box.querySelectorAll('.cat-item').forEach((row) => {
    const open = () => {
      state.activeCat = row.dataset.cat === '__all__' ? null : row.dataset.cat;
      $('#tagSearch').value = '';
      $('#searchClear').hidden = true;
      renderCategories();
      renderTags();
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
  });
}

/* ------------------- 左侧分类栏：拖动排序（主界面） ---------------------- */

let sideDragIndex = null;

function clearSideDropMarks() {
  $$('#catList .drop-before, #catList .drop-after, #catList .is-dragging')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'is-dragging'));
}

function bindSidebarDrag() {
  const list = $('#catList');

  list.addEventListener('dragstart', (event) => {
    const el = event.target.closest('.cat-item[data-drag="cat"]');
    if (!el) return;
    sideDragIndex = state.categories.findIndex((c) => c.id === el.dataset.cat);
    if (sideDragIndex < 0) { event.preventDefault(); return; }
    el.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', el.dataset.cat); } catch (_) { /* 忽略 */ }
    }
  });

  list.addEventListener('dragend', () => {
    sideDragIndex = null;
    clearSideDropMarks();
  });

  list.addEventListener('dragover', (event) => {
    if (sideDragIndex === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearSideDropMarks();
    const el = event.target.closest('.cat-item');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
  });

  list.addEventListener('dragleave', (event) => {
    if (event.target === list) clearSideDropMarks();
  });

  list.addEventListener('drop', (event) => {
    if (sideDragIndex === null) return;
    event.preventDefault();

    const el = event.target.closest('.cat-item');
    const from = sideDragIndex;
    sideDragIndex = null;
    if (!el) { clearSideDropMarks(); return; }

    const after = el.classList.contains('drop-after');
    const toId = el.dataset.cat;
    const fromId = state.categories[from] ? state.categories[from].id : null;
    clearSideDropMarks();
    if (!fromId) return;

    // 落在「全部标签」上 = 移到第一位
    const toIndex = toId === '__all__'
      ? 0
      : state.categories.findIndex((c) => c.id === toId) + (after ? 1 : 0);

    if (fromId === toId) return;
    // 目标位置没变（拖到自己紧邻的下方）就不折腾了
    if (toIndex === from || toIndex === from + 1) return;

    mutateTags(() => libMoveCategory(fromId, toIndex), '分类顺序已更新');
  });
}

/* ============================ 渲染：标签 ================================ */

function tagButtonHtml(tag, activeSet) {
  const isOn = activeSet.has(tag.en.toLowerCase());
  const cls = `tag${tag.negative ? ' negative' : ''}${isOn ? ' is-on' : ''}`;
  let label;
  if (state.lang === 'zh') label = `<span>${esc(tag.zh)}</span>`;
  else if (state.lang === 'en') label = `<span>${esc(tag.en)}</span>`;
  else label = `<span>${esc(tag.zh)}</span><span class="tag-en">${esc(tag.en)}</span>`;
  return `<button class="${cls}" data-en="${esc(tag.en)}" data-neg="${tag.negative ? 1 : 0}">${label}</button>`;
}

function renderTags() {
  const scroll = $('#tagScroll');
  const query = $('#tagSearch').value.trim().toLowerCase();

  const source = state.activeCat
    ? state.categories.filter((c) => c.id === state.activeCat)
    : state.categories;

  const groups = [];
  for (const cat of source) {
    for (const group of cat.groups || []) {
      const tags = (group.tags || []).filter((tag) => !query
        || tag.zh.toLowerCase().includes(query)
        || tag.en.toLowerCase().includes(query));
      if (tags.length) groups.push({ cat, group, tags });
    }
  }

  $('#libTitle').textContent = state.activeCat && source[0]
    ? `${catLabel(source[0])} · ${source[0].nameEn || ''}`
    : '全部标签';

  if (!groups.length) {
    scroll.innerHTML = state.tagIndex.length
      ? '<div class="empty-tip">没有找到匹配的标签<br><small>换个关键词，或到「标签管理」里添加</small></div>'
      : '<div class="empty-tip">标签库是空的<br><small>点右上角「标签管理」新建分类和标签，或点「恢复内置库」</small></div>';
    return;
  }

  const activePos = activeTagSet(false);
  const activeNeg = activeTagSet(true);

  scroll.innerHTML = groups.map(({ cat, group, tags }) => `
    <div class="tag-group">
      <div class="tag-group-title">
        ${catIcon(cat)}
        <span>${esc(state.lang === 'en' ? (group.nameEn || group.name) : group.name)}</span>
        <small class="tag-group-en">${esc(state.lang === 'both' ? (group.nameEn || '') : '')}</small>
      </div>
      <div class="tag-grid">${tags.map((tag) => tagButtonHtml({
        ...tag, negative: !!cat.negative, catId: cat.id, groupId: group.id,
      }, cat.negative ? activeNeg : activePos)).join('')}</div>
    </div>`).join('');

  scroll.querySelectorAll('.tag').forEach((btn) => {
    btn.addEventListener('click', () => toggleTag(btn.dataset.en, btn.dataset.neg === '1'));
  });
}

/* ============================ 标签增删 ================================== */

function toggleTag(en, negative) {
  const side = negative ? 'neg' : 'pos';
  const items = parseSegments(sideTextarea(side).value);
  const key = en.toLowerCase();
  const at = items.findIndex((item) => item.base.toLowerCase() === key);
  if (at === -1) items.push({ base: en, weight: null });
  else items.splice(at, 1);
  writeSide(side, items);
}

/* ============================ 芯片渲染 ================================== */

function chipHtml(item, index, side) {
  const negative = side === 'neg';
  const tag = tagByEn(item.base);
  const label = tag ? tag.en : item.base;
  return `<span class="chip${negative ? ' negative' : ''}${tag ? '' : ' unknown'}"
      draggable="true" data-index="${index}" data-side="${side}"
      title="${esc(tag ? `${tag.zh} · ${tag.en}` : item.base)}">
    ${svgIcon('i-grip', 'ico chip-grip')}
    ${tag && state.lang !== 'en' ? `<span class="chip-zh">${esc(tag.zh)}</span>` : ''}
    <span class="chip-en">${esc(label)}</span>
    ${hasWeight(item) ? `<span class="chip-weight" data-act="weight" title="点击调整权重">×${item.weight}</span>` : ''}
    <span class="chip-acts">
      <button data-act="weight" title="设置权重">${svgIcon('i-scale')}</button>
      <button data-act="park" title="停用（先放一边，不删掉）">${svgIcon('i-pause')}</button>
      <button data-act="remove" title="移除">${svgIcon('i-x')}</button>
    </span>
  </span>`;
}

function renderParked(side) {
  const negative = side === 'neg';
  const wrap = $(negative ? '#parkedNeg' : '#parkedPos');
  const box = $(negative ? '#parkedNegChips' : '#parkedPosChips');
  const list = state.parked[side] || [];

  wrap.hidden = list.length === 0;
  if (!list.length) { box.innerHTML = ''; return; }

  box.innerHTML = list.map((base, index) => {
    const tag = tagByEn(base);
    return `<button class="parked-chip" data-index="${index}" title="点击恢复到提示词">
      ${svgIcon('i-play')}
      ${tag && state.lang !== 'en' ? `<span>${esc(tag.zh)}</span>` : ''}
      <span class="chip-en">${esc(tag ? tag.en : base)}</span>
    </button>`;
  }).join('');

  box.querySelectorAll('.parked-chip').forEach((btn) => {
    btn.addEventListener('click', () => unpark(side, Number(btn.dataset.index)));
  });
}

function renderChips() {
  ['pos', 'neg'].forEach((side) => {
    const negative = side === 'neg';
    const container = sideContainer(side);
    const items = parseSegments(sideTextarea(side).value);

    container.dataset.side = side;
    container.innerHTML = items.map((item, index) => chipHtml(item, index, side)).join('');
    container.querySelectorAll('.chip').forEach((chip) => bindChip(chip, container, side));

    const counter = $(negative ? '#countNeg' : '#countPos');
    if (counter) counter.textContent = items.length ? `${items.length} 个标签` : '';

    renderParked(side);
  });
}

function bindChip(chip, container, side) {
  const index = Number(chip.dataset.index);

  chip.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'remove') removeChip(side, index);
      else if (act === 'weight') editWeight(side, index);
      else if (act === 'park') parkChip(side, index);
    });
  });

  chip.addEventListener('dragstart', (event) => {
    state.drag = { side, index };
    chip.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', String(index)); } catch (_) { /* 忽略 */ }
    }
  });

  chip.addEventListener('dragend', () => {
    state.drag = null;
    clearDropMarks(container);
  });

  chip.addEventListener('dragover', (event) => {
    if (!state.drag || state.drag.side !== side) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = chip.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    container.querySelectorAll('.chip').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    chip.classList.add(after ? 'drop-after' : 'drop-before');
  });

  chip.addEventListener('dragleave', () => chip.classList.remove('drop-before', 'drop-after'));

  chip.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const after = chip.classList.contains('drop-after');
    clearDropMarks(container);
    if (state.drag && state.drag.side === side) moveItem(side, state.drag.index, index + (after ? 1 : 0));
    state.drag = null;
  });
}

function clearDropMarks(container) {
  container.classList.remove('is-drop-active');
  container.querySelectorAll('.chip').forEach((c) => {
    c.classList.remove('is-dragging', 'drop-before', 'drop-after');
  });
}

function moveItem(side, from, to) {
  const items = parseSegments(sideTextarea(side).value);
  if (from < 0 || from >= items.length) return;
  const [item] = items.splice(from, 1);

  let insert = to;
  if (from < to) insert -= 1;
  insert = Math.max(0, Math.min(items.length, insert));
  items.splice(insert, 0, item);

  state.drag = null;
  writeSide(side, items);
}

/* ============================ 芯片操作 ================================== */

function removeChip(side, index) {
  const items = parseSegments(sideTextarea(side).value);
  if (index < 0 || index >= items.length) return;
  items.splice(index, 1);
  writeSide(side, items);
}

function parkChip(side, index) {
  const items = parseSegments(sideTextarea(side).value);
  if (index < 0 || index >= items.length) return;
  const [moved] = items.splice(index, 1);
  if (!moved) return;
  state.parked[side] = (state.parked[side] || []).concat(moved.base);
  saveParked();
  writeSide(side, items);
  toast('已停用，可在下方「已停用」区恢复');
}

async function editWeight(side, index) {
  const textarea = sideTextarea(side);
  const item = parseSegments(textarea.value)[index];
  if (!item) return;

  const tag = tagByEn(item.base);
  const values = await openForm({
    title: `权重 · ${tag ? tag.zh : item.base}`,
    fields: [{
      key: 'weight',
      label: '权重值（0.1 – 3.0）',
      type: 'number',
      value: String(hasWeight(item) ? item.weight : 1),
      step: '0.05',
      tip: '1.0 等于不加权；大于 1 强调，小于 1 弱化。会写成 (关键词:权重) 语法。',
    }],
    validate: (v) => {
      const n = Number(v.weight);
      if (!Number.isFinite(n)) return '请输入数字';
      if (n < WEIGHT_MIN || n > WEIGHT_MAX) return `权重需要在 ${WEIGHT_MIN} – ${WEIGHT_MAX} 之间`;
      return null;
    },
  });
  if (!values) return;

  const w = clampWeight(Number(values.weight));
  const fresh = parseSegments(textarea.value);
  if (!fresh[index]) return;
  fresh[index].weight = Math.abs(w - 1) < 0.005 ? null : w;
  writeSide(side, fresh);
  toast(Math.abs(w - 1) < 0.005 ? '已去掉权重' : `权重设为 ${w}`);
}

function shuffleSide(side) {
  const items = parseSegments(sideTextarea(side).value);
  if (items.length < 2) { toast('至少要有两个标签才能打乱'); return; }
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  writeSide(side, items);
  toast('已打乱顺序');
}

function normalizeSide(side) {
  const items = parseSegments(sideTextarea(side).value);
  if (!items.some(hasWeight)) { toast('当前没有权重需要清除'); return; }
  items.forEach((item) => { item.weight = null; });
  writeSide(side, items);
  toast('已清除所有权重');
}

function unpark(side, index) {
  const list = state.parked[side] || [];
  const base = list[index];
  if (base === undefined) return;
  list.splice(index, 1);
  saveParked();

  const items = parseSegments(sideTextarea(side).value);
  items.push({ base, weight: null });
  writeSide(side, items);
  toast('已恢复');
}

function saveParked() {
  clearTimeout(state.parkedTimer);
  state.parkedTimer = setTimeout(() => {
    api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ parked: state.parked }),
    }).catch(() => {});
  }, 250);
}

/* ============================ 智能推荐 ================================== */

function currentTags(negative) {
  const out = [];
  parseSegments(sideTextarea(negative ? 'neg' : 'pos').value).forEach((item) => {
    const tag = tagByEn(item.base);
    if (tag) out.push(tag.en);
  });
  return out;
}

/** 1) 按正在输入的内容预测 */
function predictByInput() {
  const raw = $('#promptText').value.split(/[,，]/).pop().trim();
  if (!raw) return { reason: '', items: [] };

  const base = raw.replace(/^[([\s]+/, '').replace(/[)\]\s]+$/, '').split(':')[0].trim().toLowerCase();
  if (!base || tagByEn(base)) return { reason: '', items: [] };

  const chosen = new Set(currentTags(false));
  const items = state.tagIndex
    .filter((t) => !t.negative && !chosen.has(t.en))
    .filter((t) => t.en.toLowerCase().includes(base) || t.zh.includes(base))
    .map((t) => {
      const en = t.en.toLowerCase();
      let score = 0;
      if (en.startsWith(base)) score += 60;
      if (t.zh.startsWith(base)) score += 60;
      if (en.includes(base)) score += 25;
      if (t.zh.includes(base)) score += 25;
      score -= Math.min(20, en.length / 3);
      return { tag: t, score: Math.round(score) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);

  return { reason: `匹配「${base}」`, items };
}

/** 2) 按历史常用组合预测 */
function predictByHistory() {
  const chosen = currentTags(false);
  const chosenSet = new Set(chosen);

  if (!chosen.length) {
    if (!state.history.length) return { reason: '', items: [] };
    const counter = {};
    state.history.slice(0, 60).forEach((combo) => combo.forEach((en) => {
      counter[en] = (counter[en] || 0) + 1;
    }));
    const items = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([en, n]) => ({ tag: tagByEn(en), score: n })).filter((x) => x.tag);
    return { reason: '历史高频标签', items };
  }

  const counter = {};
  const add = (en, weight) => { counter[en] = (counter[en] || 0) + weight; };

  state.history.slice(0, 120).forEach((combo) => {
    const set = new Set(combo);
    const overlap = chosen.filter((en) => set.has(en)).length;
    if (!overlap) return;
    combo.forEach((en) => { if (!chosenSet.has(en)) add(en, overlap); });
  });
  state.presets.forEach((preset) => {
    const set = new Set(preset.tags || []);
    const overlap = chosen.filter((en) => set.has(en)).length;
    if (!overlap) return;
    set.forEach((en) => { if (!chosenSet.has(en)) add(en, overlap * 2); });
  });

  const items = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([en, n]) => ({ tag: tagByEn(en), score: n })).filter((x) => x.tag);

  return { reason: items.length ? `与已选 ${chosen.length} 个标签常一起出现` : '', items };
}

/** 3) 与最近点选的标签同组推荐 */
function predictByGroup() {
  const chosen = currentTags(false);
  if (!chosen.length) return { reason: '', items: [] };
  const anchor = tagByEn(chosen[chosen.length - 1]);
  if (!anchor) return { reason: '', items: [] };

  const chosenSet = new Set(chosen);
  const items = state.tagIndex
    .filter((t) => t.groupId === anchor.groupId && !chosenSet.has(t.en) && !t.negative)
    .map((t) => ({ tag: t, score: 1, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 12);

  return { reason: `和「${anchor.zh}」同属「${anchor.groupName}」`, items };
}

function recSection(title, badge, block) {
  if (!block.items.length) return '';
  return `
    <div class="rec-block">
      <div class="rec-section-title">
        <span>${esc(title)}</span>
        ${badge ? `<span class="rec-badge">${esc(badge)}</span>` : ''}
      </div>
      <div class="rec-row">
        ${block.items.map(({ tag, score }) => `
          <button class="rec-chip" data-en="${esc(tag.en)}" title="${esc(tag.zh)}">
            ${state.lang === 'en' ? '' : `<span>${esc(tag.zh)}</span>`}
            <span class="tag-en">${esc(tag.en)}</span>
            ${score > 1 ? `<span class="rec-score">×${score}</span>` : ''}
          </button>`).join('')}
      </div>
    </div>`;
}

function renderRecommendations() {
  const byInput = predictByInput();
  const byHistory = predictByHistory();
  const byGroup = predictByGroup();

  const html = [
    recSection('按输入预测', byInput.reason, byInput),
    recSection('常用搭配', byHistory.reason, byHistory),
    recSection('同类推荐', byGroup.reason, byGroup),
  ].filter(Boolean).join('');

  $('#recList').innerHTML = html
    || '<div class="empty-tip" style="padding:26px 10px">推荐为空<br><small>先在左侧点几个标签，或直接在提示词框里打字</small></div>';

  $('#recList').querySelectorAll('.rec-chip').forEach((btn) => {
    btn.addEventListener('click', () => toggleTag(btn.dataset.en, false));
  });
}

/* ============================ 变更联动 ================================== */

function onPromptChanged() {
  renderChips();
  renderRecommendations();
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(recordCombo, 9000);
}

async function recordCombo() {
  const tags = currentTags(false);
  if (tags.length < 3) return;
  const key = tags.slice().sort().join('|');
  if (key === state.lastComboKey) return;
  state.lastComboKey = key;
  try {
    await api('/api/history', { method: 'POST', body: JSON.stringify({ combo: tags }) });
    state.history.unshift(tags.slice().sort());
    state.history = state.history.slice(0, 300);
  } catch (_) { /* 静默 */ }
}

function refreshAll() {
  buildIndex();
  renderCategories();
  renderTags();
  renderChips();
  renderRecommendations();
}

/* ============================ 通用表单弹窗 ============================== */

let activeForm = null;

function renderFormField(field) {
  const value = field.value ?? '';

  if (field.type === 'checkbox') {
    return `<label class="form-check" style="margin-bottom:12px">
      <input type="checkbox" data-key="${esc(field.key)}" ${value ? 'checked' : ''}>
      <span>${esc(field.label)}</span></label>`;
  }

  if (field.type === 'icon') {
    const active = CAT_ICON_KEYS.includes(String(value)) ? value : '';
    return `<div class="form-field"><span>${esc(field.label)}</span>
      <div class="icon-picker" data-picker="${esc(field.key)}">
        ${CAT_ICON_KEYS.map((key) => `<button type="button" class="icon-opt${key === active ? ' is-active' : ''}" data-value="${key}" title="${key}">
          <svg class="ico"><use href="#i-cat-${key}"/></svg></button>`).join('')}
      </div>
      <input type="text" data-key="${esc(field.key)}" value="${esc(value)}" placeholder="或直接填一个字符（emoji / 符号）">
      <span class="tip">${esc(field.tip || '点上方图标选择，或在下方填任意字符')}</span></div>`;
  }

  if (field.type === 'select') {
    return `<label class="form-field"><span>${esc(field.label)}</span>
      <select data-key="${esc(field.key)}">
        ${(field.options || []).map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>${field.tip ? `<span class="tip">${esc(field.tip)}</span>` : ''}</label>`;
  }

  const type = field.type === 'number' ? 'number' : 'text';
  const extra = field.type === 'number'
    ? ` step="${esc(field.step || '1')}" min="${esc(field.min ?? '')}" max="${esc(field.max ?? '')}"`
    : '';
  return `<label class="form-field"><span>${esc(field.label)}</span>
    <input type="${type}" data-key="${esc(field.key)}" value="${esc(value)}"${extra} placeholder="${esc(field.placeholder || '')}">
    ${field.tip ? `<span class="tip">${esc(field.tip)}</span>` : ''}</label>`;
}

function collectFormValues(fields) {
  const out = {};
  for (const field of fields) {
    const el = $(`#formBody [data-key="${field.key}"]`);
    if (!el) continue;
    out[field.key] = field.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return out;
}

function openForm(spec) {
  return new Promise((resolve) => {
    activeForm = { spec, resolve };
    $('#formTitle').textContent = spec.title || '编辑';
    $('#formError').textContent = '';
    $('#formBody').innerHTML = (spec.fields || []).map(renderFormField).join('');
    $('#modalForm').hidden = false;
    setTimeout(() => {
      const el = $('#formBody input, #formBody select');
      if (el) { el.focus(); if (el.select) el.select(); }
    }, 40);
  });
}

function settleForm(result) {
  if (!activeForm) return;
  const { resolve } = activeForm;
  activeForm = null;
  $('#modalForm').hidden = true;
  resolve(result);
}

function submitForm() {
  if (!activeForm) return;
  const { spec } = activeForm;
  const values = collectFormValues(spec.fields || []);
  const error = spec.validate ? spec.validate(values) : null;
  if (error) { $('#formError').textContent = error; return; }
  settleForm(values);
}

/* ============================ 标签管理 ================================== */

function renderLibrary() {
  if (!state.categories.some((c) => c.id === state.libActiveCat)) {
    state.libActiveCat = state.categories[0] ? state.categories[0].id : null;
  }
  const filter = ($('#libCatSearch').value || '').trim().toLowerCase();
  const cats = state.categories.filter((c) => !filter
    || c.name.toLowerCase().includes(filter)
    || (c.nameEn || '').toLowerCase().includes(filter)
    || c.id.includes(filter));

  $('#libCatList').innerHTML = cats.length
    ? cats.map((cat) => `
      <div class="lib-cat-row${cat.id === state.libActiveCat ? ' is-active' : ''}"
           data-cat="${esc(cat.id)}" data-drag="cat" draggable="true"
           role="button" tabindex="0" title="拖动可调整分类顺序">
        ${catIcon(cat)}
        <span>${esc(cat.name)}</span>
        <span class="n">${tagCount(cat)}</span>
      </div>`).join('')
    : '<div class="lib-empty">没有匹配的分类</div>';

  $('#libCatList').querySelectorAll('.lib-cat-row').forEach((row) => {
    const open = () => {
      state.libActiveCat = row.dataset.cat;
      renderLibrary();
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
  });

  const cat = state.categories.find((c) => c.id === state.libActiveCat);
  const detail = $('#libDetail');

  if (!cat) {
    detail.innerHTML = '<div class="lib-empty">还没有任何分类<br><small>点右上角「新建分类」开始，或点「恢复内置库」</small></div>';
    return;
  }

  detail.innerHTML = `
    <div class="lib-drag-hint">
      ${svgIcon('i-grip')}
      <span>拖动 <strong>分类</strong> 调顺序 · 拖动 <strong>分组</strong> 可换分类 · 拖动 <strong>标签</strong> 可跨分组 / 跨分类归类</span>
    </div>
    <div class="lib-bar">
      <h4>${catIcon(cat, 'ico cat-svg-lg')} ${esc(cat.name)}
        <span class="en">${esc(cat.nameEn || '')}</span>
        ${cat.negative ? '<span class="rec-badge" style="color:var(--neg)">负面</span>' : ''}
      </h4>
      <span class="spacer"></span>
      <button class="mini" data-act="edit-cat">改名 / 图标</button>
      <button class="mini" data-act="add-group">${svgIcon('i-plus')} 分组</button>
      <button class="mini danger" data-act="del-cat">删除分类</button>
    </div>
    ${(cat.groups || []).map((group) => `
      <div class="lib-group" data-group="${esc(group.id)}" data-cat="${esc(cat.id)}">
        <div class="lib-group-head" data-drag="group" data-cat="${esc(cat.id)}"
             data-group="${esc(group.id)}" draggable="true" title="拖动可调整顺序，或拖到左侧分类上换分类">
          <strong>${esc(group.name)}</strong>
          <span class="en">${esc(group.nameEn || '')}</span>
          <span class="spacer"></span>
          <span class="hint">${(group.tags || []).length} 个</span>
          <button class="mini" data-act="add-tag" data-group="${esc(group.id)}">${svgIcon('i-plus')} 标签</button>
          <button class="mini" data-act="edit-group" data-group="${esc(group.id)}">改名</button>
          <button class="mini danger" data-act="del-group" data-group="${esc(group.id)}">删除</button>
        </div>
        <div class="lib-group-body">
          ${(group.tags || []).map((tag) => `
            <span class="lib-tag" data-drag="tag" data-cat="${esc(cat.id)}" data-group="${esc(group.id)}"
                  data-en="${esc(tag.en)}" draggable="true" title="拖动可调整位置，或拖到别的分组里">
              <span>${esc(tag.zh)}</span>
              <span class="en">${esc(tag.en)}</span>
              <span class="acts">
                <button data-act="edit-tag" data-group="${esc(group.id)}" data-en="${esc(tag.en)}" title="编辑">${ICON_EDIT}</button>
                <button class="del" data-act="del-tag" data-group="${esc(group.id)}" data-en="${esc(tag.en)}" title="删除">${ICON_TRASH}</button>
              </span>
            </span>`).join('') || '<span class="hint">这个分组还没有标签，点上面「＋ 标签」添加，或把别的标签拖进来</span>'}
        </div>
      </div>`).join('')}
  `;
}

async function mutateTags(mutator, message) {
  const backup = clone(state.categories);
  mutator();
  let ok = true;
  try {
    const data = await api('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ categories: state.categories }),
    });
    state.categories = data.categories;
    state.tagSource = 'user';
  } catch (err) {
    state.categories = backup;
    ok = false;
    toast(`保存失败：${err.message}`, 3600);
  }
  refreshAll();
  renderLibrary();
  if (ok && message) toast(message);
}

const findCat = (id) => state.categories.find((c) => c.id === id);

function uniqueCatId(base) {
  let id = base || 'cat';
  let n = 2;
  while (state.categories.some((c) => c.id === id)) id = `${base}-${n++}`;
  return id;
}

function uniqueGroupId(catId, base) {
  const used = (findCat(catId)?.groups || []).map((g) => g.id);
  let id = `${catId}.${base}`;
  let n = 2;
  while (used.includes(id)) id = `${catId}.${base}-${n++}`;
  return id;
}

async function libAddCategory() {
  const values = await openForm({
    title: '新建分类',
    fields: [
      { key: 'name', label: '中文名称', placeholder: '例如：材质' },
      { key: 'nameEn', label: '英文名称', placeholder: 'Material' },
      { key: 'icon', label: '图标', type: 'icon', value: 'star' },
      { key: 'negative', label: '这是负面提示词分类（标签会进入负面框）', type: 'checkbox' },
    ],
    validate: (v) => (v.name ? null : '请填写中文名称'),
  });
  if (!values) return;

  const id = uniqueCatId(slugify(values.nameEn) || 'cat');
  await mutateTags(() => {
    const entry = { id, name: values.name, nameEn: values.nameEn, icon: values.icon || 'star', groups: [] };
    if (values.negative) entry.negative = true;
    state.categories.push(entry);
  }, '分类已创建');
  state.libActiveCat = id;
  renderLibrary();
}

async function libEditCategory(cat) {
  const values = await openForm({
    title: `编辑分类「${cat.name}」`,
    fields: [
      { key: 'name', label: '中文名称', value: cat.name },
      { key: 'nameEn', label: '英文名称', value: cat.nameEn || '' },
      { key: 'icon', label: '图标', type: 'icon', value: cat.icon || 'star' },
      { key: 'negative', label: '这是负面提示词分类', type: 'checkbox', value: !!cat.negative },
    ],
    validate: (v) => (v.name ? null : '请填写中文名称'),
  });
  if (!values) return;
  await mutateTags(() => {
    const target = findCat(cat.id);
    target.name = values.name;
    target.nameEn = values.nameEn;
    target.icon = values.icon || 'star';
    if (values.negative) target.negative = true; else delete target.negative;
  }, '分类已更新');
}

async function libDeleteCategory(cat) {
  const ok = window.confirm(`确定删除分类「${cat.name}」吗？\n它下面的 ${tagCount(cat)} 个标签会一起删除，无法撤销。`);
  if (!ok) return;
  await mutateTags(() => {
    state.categories = state.categories.filter((c) => c.id !== cat.id);
  }, '分类已删除');
}

async function libAddGroup(cat) {
  const values = await openForm({
    title: `在「${cat.name}」下新建分组`,
    fields: [
      { key: 'name', label: '分组中文名', placeholder: '例如：金属材质' },
      { key: 'nameEn', label: '分组英文名', placeholder: 'Metal' },
    ],
    validate: (v) => (v.name ? null : '请填写分组中文名'),
  });
  if (!values) return;
  const base = slugify(values.nameEn) || 'group';
  await mutateTags(() => {
    findCat(cat.id).groups.push({
      id: uniqueGroupId(cat.id, base), name: values.name, nameEn: values.nameEn, tags: [],
    });
  }, '分组已创建');
}

async function libEditGroup(cat, group) {
  const values = await openForm({
    title: '编辑分组',
    fields: [
      { key: 'name', label: '分组中文名', value: group.name },
      { key: 'nameEn', label: '分组英文名', value: group.nameEn || '' },
    ],
    validate: (v) => (v.name ? null : '请填写分组中文名'),
  });
  if (!values) return;
  await mutateTags(() => {
    const target = findCat(cat.id).groups.find((g) => g.id === group.id);
    target.name = values.name;
    target.nameEn = values.nameEn;
  }, '分组已更新');
}

async function libDeleteGroup(cat, group) {
  const ok = window.confirm(`确定删除分组「${group.name}」吗？\n其中 ${(group.tags || []).length} 个标签会一起删除。`);
  if (!ok) return;
  await mutateTags(() => {
    const target = findCat(cat.id);
    target.groups = target.groups.filter((g) => g.id !== group.id);
  }, '分组已删除');
}

function duplicateTagError(en, ignoreGroup, ignoreEn) {
  const key = en.toLowerCase();
  const hit = state.tagIndex.find((t) => t.en.toLowerCase() === key
    && !(t.groupId === ignoreGroup && t.en === ignoreEn));
  return hit ? `「${en}」已经存在于「${hit.catName} / ${hit.groupName}」中` : null;
}

async function libAddTag(cat, group) {
  const values = await openForm({
    title: `在「${cat.name} / ${group.name}」添加标签`,
    fields: [
      { key: 'zh', label: '中文', placeholder: '例如：金属' },
      { key: 'en', label: '英文提示词', placeholder: 'metal', tip: '全小写，不要逗号；一次一个词' },
    ],
    validate: (v) => {
      if (!v.zh || !v.en) return '中文和英文都要填';
      if (/[,，]/.test(v.en)) return '英文里不能有逗号，请拆成多个标签';
      return duplicateTagError(v.en);
    },
  });
  if (!values) return;
  await mutateTags(() => {
    findCat(cat.id).groups.find((g) => g.id === group.id).tags.push({ zh: values.zh, en: values.en });
  }, '标签已添加');
}

async function libEditTag(cat, group, tag) {
  const values = await openForm({
    title: '编辑标签',
    fields: [
      { key: 'zh', label: '中文', value: tag.zh },
      { key: 'en', label: '英文提示词', value: tag.en },
    ],
    validate: (v) => {
      if (!v.zh || !v.en) return '中文和英文都要填';
      if (/[,，]/.test(v.en)) return '英文里不能有逗号';
      return duplicateTagError(v.en, group.id, tag.en);
    },
  });
  if (!values) return;
  await mutateTags(() => {
    const item = findCat(cat.id).groups.find((g) => g.id === group.id).tags.find((t) => t.en === tag.en);
    item.zh = values.zh;
    item.en = values.en;
  }, '标签已更新');
}

async function libDeleteTag(cat, group, tag) {
  await mutateTags(() => {
    const target = findCat(cat.id).groups.find((g) => g.id === group.id);
    target.tags = target.tags.filter((t) => t.en !== tag.en);
  }, `已删除「${tag.zh}」`);
}

/* ------------------------- 拖拽归类（标签管理） -------------------------- */

function clearLibDropMarks() {
  $$('#modalLibrary .drop-before, #modalLibrary .drop-after, #modalLibrary .drop-into')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function clearLibDragState() {
  clearLibDropMarks();
  $$('#modalLibrary .is-dragging').forEach((el) => el.classList.remove('is-dragging'));
}

const dropIsAfter = (el, event) => {
  const rect = el.getBoundingClientRect();
  const horizontal = el.classList.contains('lib-tag');
  return horizontal
    ? event.clientX > rect.left + rect.width / 2
    : event.clientY > rect.top + rect.height / 2;
};

function markLibDropTarget(event) {
  clearLibDropMarks();
  const drag = state.libDrag;
  if (!drag) return;

  const target = event.target;
  const catRow = target.closest('.lib-cat-row');
  const tagEl = target.closest('.lib-tag');
  const groupHead = target.closest('.lib-group-head');
  const groupEl = target.closest('.lib-group');

  if (drag.kind === 'cat') {
    if (catRow && catRow.dataset.cat !== drag.catId) {
      const rect = catRow.getBoundingClientRect();
      catRow.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
    }
    return;
  }

  if (drag.kind === 'tag') {
    const isSelf = tagEl && tagEl.dataset.cat === drag.catId
      && tagEl.dataset.group === drag.groupId && tagEl.dataset.en === drag.en;
    if (tagEl && !isSelf) { tagEl.classList.add(dropIsAfter(tagEl, event) ? 'drop-after' : 'drop-before'); return; }
    if (groupEl) {
      const toGroup = groupEl.dataset.group;
      if (toGroup !== drag.groupId) groupEl.classList.add('drop-into');
      return;
    }
    if (catRow) catRow.classList.add('drop-into');
    return;
  }

  if (drag.kind === 'group') {
    const isSelf = groupHead && groupHead.dataset.cat === drag.catId && groupHead.dataset.group === drag.groupId;
    if (groupHead && !isSelf) { groupHead.classList.add(dropIsAfter(groupHead, event) ? 'drop-after' : 'drop-before'); return; }
    if (groupEl) { groupEl.classList.add('drop-into'); return; }
    if (catRow) catRow.classList.add('drop-into');
  }
}

/** 分类排序 */
function libMoveCategory(fromId, toIndex) {
  const fromIndex = state.categories.findIndex((c) => c.id === fromId);
  if (fromIndex < 0) return;
  const [cat] = state.categories.splice(fromIndex, 1);
  let insert = toIndex;
  if (fromIndex < toIndex) insert -= 1;
  insert = Math.max(0, Math.min(state.categories.length, insert));
  state.categories.splice(insert, 0, cat);
}

/** 分组在分类内排序，或整个搬到别的分类 */
function libMoveGroup(fromCatId, groupId, toCatId, toIndex) {
  const fromCat = findCat(fromCatId);
  const toCat = findCat(toCatId);
  if (!fromCat || !toCat) return;

  const fromIndex = fromCat.groups.findIndex((g) => g.id === groupId);
  if (fromIndex < 0) return;

  const sameCat = fromCat === toCat;
  const [group] = fromCat.groups.splice(fromIndex, 1);

  let insert = toIndex;
  if (sameCat && fromIndex < toIndex) insert -= 1;
  insert = Math.max(0, Math.min(toCat.groups.length, insert));

  if (!sameCat) {
    // 换了分类，同步重写 group id 的 <分类id>. 前缀
    const suffix = String(group.id).split('.').slice(1).join('.') || slugify(group.nameEn) || 'group';
    const used = toCat.groups.map((g) => g.id);
    let id = `${toCatId}.${suffix}`;
    let n = 2;
    while (used.includes(id)) id = `${toCatId}.${suffix}-${n++}`;
    group.id = id;
  }

  toCat.groups.splice(insert, 0, group);
}

/** 标签在分组内排序，或跨分组 / 跨分类搬运 */
function libMoveTag(fromCatId, fromGroupId, en, toCatId, toGroupId, toIndex) {
  const fromGroup = ((findCat(fromCatId) || {}).groups || []).find((g) => g.id === fromGroupId);
  const toGroup = ((findCat(toCatId) || {}).groups || []).find((g) => g.id === toGroupId);
  if (!fromGroup || !toGroup) return false;

  const fromIndex = fromGroup.tags.findIndex((t) => t.en === en);
  if (fromIndex < 0) return false;

  if (fromGroup !== toGroup
    && toGroup.tags.some((t) => t.en.toLowerCase() === String(en).toLowerCase())) {
    return false;
  }

  const [tag] = fromGroup.tags.splice(fromIndex, 1);
  let insert = toIndex;
  if (fromGroup === toGroup && fromIndex < toIndex) insert -= 1;
  insert = Math.max(0, Math.min(toGroup.tags.length, insert));
  toGroup.tags.splice(insert, 0, tag);
  return true;
}

function handleLibDrop(event) {
  const drag = state.libDrag;
  if (!drag) return;
  state.libDrag = null;

  const target = event.target;
  const catRow = target.closest('.lib-cat-row');
  const tagEl = target.closest('.lib-tag');
  const groupHead = target.closest('.lib-group-head');
  const groupEl = target.closest('.lib-group');

  try {
    if (drag.kind === 'cat') {
      if (!catRow || catRow.dataset.cat === drag.catId) return;
      const toIndex = state.categories.findIndex((c) => c.id === catRow.dataset.cat)
        + (catRow.classList.contains('drop-after') ? 1 : 0);
      mutateTags(() => libMoveCategory(drag.catId, toIndex), '分类顺序已更新');
      return;
    }

    if (drag.kind === 'tag') {
      if (tagEl) {
        const toCat = tagEl.dataset.cat;
        const toGroup = tagEl.dataset.group;
        const isSelf = toCat === drag.catId && toGroup === drag.groupId && tagEl.dataset.en === drag.en;
        if (isSelf) return;
        const group = findCat(toCat).groups.find((g) => g.id === toGroup);
        const toIndex = group.tags.findIndex((t) => t.en === tagEl.dataset.en)
          + (tagEl.classList.contains('drop-after') ? 1 : 0);
        mutateTags(() => {
          if (!libMoveTag(drag.catId, drag.groupId, drag.en, toCat, toGroup, toIndex)) {
            toast('目标分组里已经有同名词了');
          }
        }, '标签位置已更新');
        return;
      }
      if (groupEl) {
        const toCat = groupEl.dataset.cat;
        const toGroup = groupEl.dataset.group;
        if (toCat === drag.catId && toGroup === drag.groupId) return;
        mutateTags(
          () => libMoveTag(drag.catId, drag.groupId, drag.en, toCat, toGroup, 1e9),
          `标签已移到「${(findCat(toCat).groups.find((g) => g.id === toGroup) || {}).name || ''}」`,
        );
        return;
      }
      if (catRow) {
        const toCat = catRow.dataset.cat;
        const first = (findCat(toCat).groups || [])[0];
        if (!first) { toast('该分类下还没有分组，请先新建一个分组'); return; }
        mutateTags(
          () => libMoveTag(drag.catId, drag.groupId, drag.en, toCat, first.id, 1e9),
          `标签已移到「${findCat(toCat).name} / ${first.name}」`,
        );
      }
      return;
    }

    if (drag.kind === 'group') {
      if (groupHead) {
        const toCat = groupHead.dataset.cat;
        const toGroupId = groupHead.dataset.group;
        if (toCat === drag.catId && toGroupId === drag.groupId) return;
        const toIndex = findCat(toCat).groups.findIndex((g) => g.id === toGroupId)
          + (groupHead.classList.contains('drop-after') ? 1 : 0);
        mutateTags(() => libMoveGroup(drag.catId, drag.groupId, toCat, toIndex), '分组顺序已更新');
        return;
      }
      if (catRow) {
        const toCat = catRow.dataset.cat;
        if (toCat === drag.catId) return;
        mutateTags(
          () => libMoveGroup(drag.catId, drag.groupId, toCat, 1e9),
          `分组已移到「${findCat(toCat).name}」`,
        );
      }
    }
  } finally {
    clearLibDragState();
  }
}

function bindLibraryEvents() {
  // ---- 拖拽归类：整块委托，只绑一次 ----
  const libModal = $('#modalLibrary');

  libModal.addEventListener('dragstart', (event) => {
    if (event.target.closest('.acts') || event.target.closest('button.mini')) {
      event.preventDefault();
      return;
    }
    const el = event.target.closest('[data-drag]');
    if (!el) return;

    state.libDrag = {
      kind: el.dataset.drag,
      catId: el.dataset.cat || null,
      groupId: el.dataset.group || null,
      en: el.dataset.en || null,
    };
    el.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', el.dataset.drag); } catch (_) { /* 忽略 */ }
    }
  });

  libModal.addEventListener('dragend', () => {
    state.libDrag = null;
    clearLibDragState();
  });

  libModal.addEventListener('dragover', (event) => {
    if (!state.libDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    markLibDropTarget(event);
  });

  libModal.addEventListener('dragleave', (event) => {
    if (event.target === libModal) clearLibDropMarks();
  });

  libModal.addEventListener('drop', (event) => {
    if (!state.libDrag) return;
    event.preventDefault();
    event.stopPropagation();
    handleLibDrop(event);
  });

  $('#libDetail').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const cat = findCat(state.libActiveCat);
    if (!cat) return;
    const group = (cat.groups || []).find((g) => g.id === btn.dataset.group);
    const tag = group ? (group.tags || []).find((t) => t.en === btn.dataset.en) : null;

    const actions = {
      'edit-cat': () => libEditCategory(cat),
      'del-cat': () => libDeleteCategory(cat),
      'add-group': () => libAddGroup(cat),
      'edit-group': () => group && libEditGroup(cat, group),
      'del-group': () => group && libDeleteGroup(cat, group),
      'add-tag': () => group && libAddTag(cat, group),
      'edit-tag': () => tag && libEditTag(cat, group, tag),
      'del-tag': () => tag && libDeleteTag(cat, group, tag),
    };
    const fn = actions[btn.dataset.act];
    if (fn) fn();
  });

  $('#libCatSearch').addEventListener('input', renderLibrary);
  $('#btnAddCategory').addEventListener('click', libAddCategory);

  $('#btnExportTags').addEventListener('click', async () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), categories: state.categories };
    await download('tags-export.json', JSON.stringify(payload, null, 2));
  });

  $('#btnImportTags').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const categories = Array.isArray(parsed) ? parsed : parsed.categories;
        if (!Array.isArray(categories)) throw new Error('文件里没有 categories 数组');
        const data = await api('/api/tags', { method: 'POST', body: JSON.stringify({ categories }) });
        state.categories = data.categories;
        state.tagSource = 'user';
        refreshAll();
        renderLibrary();
        toast(`导入成功：${data.stats.categories} 个分类 / ${data.stats.tags} 个标签`);
      } catch (err) {
        toast(`导入失败：${err.message}`, 3600);
      }
    });
    input.click();
  });

  $('#btnResetTags').addEventListener('click', async () => {
    const ok = window.confirm('确定恢复内置标签库吗？\n你自定义的分类和标签会被移除（原文件会备份为 tags.user.json.bak）。');
    if (!ok) return;
    try {
      await api('/api/tags/reset', { method: 'POST', body: '{}' });
      const data = await api('/api/tags');
      state.categories = data.categories || [];
      state.tagSource = data.source || 'builtin';
      state.libActiveCat = null;
      refreshAll();
      renderLibrary();
      toast('已恢复内置标签库');
    } catch (err) {
      toast(`恢复失败：${err.message}`, 3600);
    }
  });
}

/* ========================= 服务商预设 + 连接测试 ======================== */

const LLM_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    note: '文本：deepseek-chat（快、便宜）／deepseek-reasoner（会推理，慢且费额度）。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '文本：gpt-4o-mini（便宜快）／gpt-4o（更强）。图片反推用 gpt-4o 或 gpt-4o-mini。',
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: '文本：qwen-plus／qwen-max。图片反推用 qwen-vl-max。',
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    note: '文本：glm-4-flash（有免费额度）／glm-4-plus。图片反推用 glm-4v-plus。',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    note: '图片反推用 moonshot-v1-8k-vision-preview。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    note: '这家的模型名带斜杠。图片反推用 Qwen/Qwen2.5-VL-72B-Instruct。',
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
    note: '先在终端执行 ollama pull llama3.1。API Key 随便填一个非空值即可。',
  },
  { id: 'custom', name: '自定义 / 其他兼容服务', baseUrl: '', model: '', note: '' },
];

const normUrl = (url) => String(url || '').trim().replace(/\/+$/, '').toLowerCase();

function matchProvider(baseUrl) {
  const hit = LLM_PROVIDERS.find((p) => p.baseUrl && normUrl(p.baseUrl) === normUrl(baseUrl));
  return hit ? hit.id : 'custom';
}

function renderProviderOptions() {
  $('#setProvider').innerHTML = LLM_PROVIDERS
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}

function updateProviderNote() {
  const provider = LLM_PROVIDERS.find((p) => p.id === $('#setProvider').value);
  const box = $('#providerNote');
  if (!provider || !provider.note) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = provider.note;
}

function applyProvider(id) {
  const provider = LLM_PROVIDERS.find((p) => p.id === id);
  if (!provider || provider.id === 'custom') {
    updateProviderNote();
    updateModelOptions();
    return;
  }
  $('#setBaseUrl').value = provider.baseUrl;
  $('#setModel').value = provider.model;
  $('#connResult').hidden = true;
  updateProviderNote();
  updateModelOptions();
  toast(`已填入「${provider.name}」的地址和推荐模型，可自行修改`);
}

/** 各服务商的常用模型清单，只用于下拉提示；输入框仍可任意手填 */
const PROVIDER_MODELS = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'deepseek-v4-pro'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  dashscope: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-max', 'qwen-vl-plus'],
  zhipu: ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4v-plus', 'glm-4v-flash'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
             'moonshot-v1-8k-vision-preview'],
  siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-VL-72B-Instruct',
                'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-8B'],
  ollama: ['llama3.1', 'llava', 'qwen2.5vl', 'gemma3', 'mistral'],
};

const currentProviderId = () => ($('#setProvider') ? $('#setProvider').value : 'custom');

/** 模型下拉菜单随服务商变化 */
function updateModelOptions() {
  const menu = $('#modelMenu');
  if (!menu) return;
  const models = PROVIDER_MODELS[currentProviderId()] || [];
  if (!models.length) {
    menu.innerHTML = '<div class="combo-empty">当前是自定义服务商，直接手填模型名即可</div>';
    return;
  }
  const picked = $('#setModel').value.trim();
  menu.innerHTML = models.map((m) => `
    <button type="button" class="combo-item${m === picked ? ' is-active' : ''}" data-model="${esc(m)}">
      <span>${esc(m)}</span>
      ${m === picked ? '<svg class="ico ico-sm"><use href="#i-check"/></svg>' : ''}
    </button>`).join('');
  menu.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => {
    pickModel(b.dataset.model);
  }));
}

/** 从下拉里选中一个模型 */
function pickModel(name) {
  if (!name) return;
  $('#setModel').value = name;
  closeModelMenu();
  $('#connResult').hidden = true;
  toast(`已选择模型 ${name}`);
}

function openModelMenu() {
  const menu = $('#modelMenu');
  if (!menu) return;
  updateModelOptions();
  menu.hidden = false;
  $('#modelCombo').classList.add('is-open');
}

function closeModelMenu() {
  const menu = $('#modelMenu');
  if (!menu) return;
  menu.hidden = true;
  const combo = $('#modelCombo');
  if (combo) combo.classList.remove('is-open');
}

function toggleModelMenu() {
  const menu = $('#modelMenu');
  if (!menu) return;
  if (menu.hidden) openModelMenu();
  else closeModelMenu();
}

async function testConnection() {
  const btn = $('#btnTestConnection');
  const box = $('#connResult');
  const baseUrl = $('#setBaseUrl').value.trim();
  const model = $('#setModel').value.trim();

  if (!baseUrl) { toast('请先填写接口地址'); return; }

  btn.disabled = true;
  box.hidden = false;
  box.className = 'conn-result loading';
  box.textContent = '正在测试…（先用免费的 GET /models，不消耗额度）';

  try {
    const data = await api('/api/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: $('#setApiKey').value.trim(),
        model,
        timeout: Number($('#setTimeout').value) || 90,
      }),
    });

    const lines = [`✓ ${data.message}`, `请求地址：${data.url}`];
    if (data.method === 'models') {
      lines.push(`该地址返回 ${data.modelCount} 个可用模型`);
      if (data.modelFound === true) lines.push(`✓ 模型名「${model}」在列表里`);
      else if (data.modelFound === false) lines.push(`⚠ 模型名「${model}」不在返回的列表里，请核对拼写`);
      if ((data.sample || []).length) lines.push(`例如：${data.sample.slice(0, 6).join('、')}`);
    }
    box.className = 'conn-result ok';
    box.textContent = lines.join('\n');
  } catch (err) {
    box.className = 'conn-result err';
    box.textContent = [
      `✗ ${err.message}`,
      '',
      '常见原因：',
      '· 接口地址和服务商不匹配（例如把 DeepSeek 的 Key 配到了 api.openai.com）',
      '· API Key 复制时缺了字符，或者前面多了空格',
      '· 模型名在该服务商那里不存在',
      '· 网络需要代理，或者本地服务没启动（Ollama）',
      err.detail ? `\n服务端返回：${String(err.detail).slice(0, 300)}` : '',
    ].filter((x) => x !== '').join('\n');
  } finally {
    btn.disabled = false;
  }
}

/* ============================ 设置弹窗 ================================== */

function fillSettingsForm() {
  const s = state.settings;
  renderProviderOptions();
  $('#setProvider').value = matchProvider(s.base_url);
  updateProviderNote();
  updateModelOptions();
  closeModelMenu();
  $('#setBaseUrl').value = s.base_url || '';
  $('#setApiKey').value = s.api_key || '';
  $('#setModel').value = s.model || '';
  $('#setTimeout').value = s.timeout || 90;
  $('#setMaxTokens').value = s.max_tokens || 8192;
  $('#connResult').hidden = true;
  $('#connResult').textContent = '';
  $('#setCopyMode').value = s.copy_prefix_mode || 'negative';
  $('#setCopyPosPrefix').value = s.copy_positive_prefix ?? DEFAULT_COPY_POS_PREFIX;
  $('#setCopyNegPrefix').value = s.copy_negative_prefix ?? DEFAULT_COPY_NEG_PREFIX;
  $('#setSysPrompt').value = s.vision_system_prompt || '';
  $('#setUserPrompt').value = s.vision_user_prompt || '';
  $('#setPolishPrompt').value = s.polish_system_prompt || DEFAULT_POLISH_PROMPT;
  updateCopyPreview();
  $('#saveHint').textContent = '';
}

async function saveSettings() {
  const data = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({
      base_url: $('#setBaseUrl').value.trim(),
      api_key: $('#setApiKey').value.trim(),
      model: $('#setModel').value.trim(),
      timeout: Number($('#setTimeout').value) || 90,
      max_tokens: Number($('#setMaxTokens').value) || 8192,
      copy_prefix_mode: $('#setCopyMode').value,
      copy_positive_prefix: $('#setCopyPosPrefix').value,
      copy_negative_prefix: $('#setCopyNegPrefix').value,
      vision_system_prompt: $('#setSysPrompt').value,
      vision_user_prompt: $('#setUserPrompt').value,
      polish_system_prompt: $('#setPolishPrompt').value,
    }),
  });
  state.settings = data.settings;
  $('#saveHint').textContent = '✓ 已保存';
  toast('设置已保存');
  setTimeout(() => closeModal('#modalSettings'), 450);
}

/* ============================ 图片反推 ================================== */

function setImage(dataUrl, name) {
  state.image = dataUrl;
  const preview = $('#preview');
  preview.src = dataUrl;
  preview.hidden = false;
  $('#dzEmpty').hidden = true;
  $('#imgMeta').textContent = name || '';
}

function clearImage() {
  state.image = null;
  $('#preview').hidden = true;
  $('#preview').src = '';
  $('#dzEmpty').hidden = false;
  $('#imgMeta').textContent = '';
  $('#fileInput').value = '';
  $('#visionStatus').textContent = '';
  $('#visionStatus').className = 'status';
  showReasoning('visionReasoning', '', false);
}

function readFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result, `${file.name} · ${(file.size / 1024).toFixed(0)} KB`);
  reader.readAsDataURL(file);
}

async function analyzeImage() {
  if (!state.image) { toast('请先选择一张图片'); return; }
  const status = $('#visionStatus');
  const btn = $('#btnAnalyze');
  status.className = 'status loading';
  status.textContent = '正在请求大模型解析，请稍候…';
  btn.disabled = true;

  try {
    const data = await api('/api/vision', {
      method: 'POST',
      body: JSON.stringify({
        image: state.image,
        user_prompt: $('#visionUserPrompt').value.trim() || undefined,
      }),
    });
    $('#visionResult').value = data.content;
    showReasoning('visionReasoning', data.reasoning, false);
    status.className = 'status ok';
    status.textContent = `✓ 解析完成（模型：${data.model}）`;
  } catch (err) {
    status.className = 'status err';
    status.textContent = `✗ ${err.message}${err.detail ? `\n${err.detail}` : ''}`;
    showReasoning('visionReasoning', err.reasoning, true);
  } finally {
    btn.disabled = false;
  }
}

/** 从模型返回的文本里抽出 "标签: 内容" 的块，兼容 Markdown 修饰。 */
function grabBlock(text, label) {
  const deco = '[\\s>*#\\-_`]*';
  const re = new RegExp(
    `^${deco}${label}${deco}[:：]\\s*([\\s\\S]*?)`
    + `(?=^${deco}(?:PROMPT|NEGATIVE|WEIGHTS|说明|权重建议|中文|正向提示词|负面提示词)${deco}[:：]|$)`,
    'im',
  );
  const m = String(text || '').match(re);
  return m ? m[1].trim().replace(/^[*`>\s]+|[*`\s]+$/g, '') : '';
}

function parseVisionResult() {
  const text = $('#visionResult').value;
  const positive = grabBlock(text, 'PROMPT') || grabBlock(text, '正向提示词');
  const negative = grabBlock(text, 'NEGATIVE') || grabBlock(text, '负面提示词');

  if (positive) {
    $('#promptText').value = positive;
    if (negative) $('#negText').value = negative;
    toast('已应用到工作区');
  } else {
    $('#promptText').value = text.trim();
    toast('未识别到标准格式，已整段填入正向提示词');
  }
  commitUndo();
  onPromptChanged();
  renderTags();
  closeModal('#modalVision');
}

/* ============================ 我的组合 ================================== */

function renderPresets() {
  const box = $('#presetList');
  if (!state.presets.length) {
    box.innerHTML = '<div class="empty-tip">还没有收藏的组合<br><small>在工作区点「收藏当前组合」即可保存</small></div>';
    return;
  }
  box.innerHTML = state.presets.map((preset) => `
    <div class="preset-card">
      <div class="preset-card-head">
        <strong>${esc(preset.name)}</strong>
        <time>${esc(preset.updatedAt || '')}</time>
      </div>
      <p>${esc(preset.prompt || '')}</p>
      <div class="row-inline">
        <button class="mini" data-load="${esc(preset.id)}">载入</button>
        <button class="mini" data-copy="${esc(preset.id)}">复制</button>
        <button class="mini danger" data-del="${esc(preset.id)}">删除</button>
        <span class="hint">${(preset.tags || []).length} 个标签</span>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => {
    const preset = state.presets.find((p) => p.id === b.dataset.load);
    $('#promptText').value = preset.prompt || '';
    $('#negText').value = preset.negative || '';
    onPromptChanged();
    renderTags();
    closeModal('#modalPresets');
    toast('已载入组合');
  }));

  box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const preset = state.presets.find((p) => p.id === b.dataset.copy);
    await copyText(formatPromptText(preset.prompt, preset.negative), `已复制「${preset.name}」`);
  }));

  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const data = await api('/api/presets', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id: b.dataset.del }),
    });
    state.presets = data.presets;
    renderPresets();
    toast('已删除');
  }));
}

async function savePreset() {
  const values = await openForm({
    title: '收藏当前组合',
    fields: [{
      key: 'name',
      label: '给这个组合起个名字',
      value: `组合 ${new Date().toLocaleDateString('zh-CN')}`,
    }],
    validate: (v) => (v.name ? null : '请填写名字'),
  });
  if (!values) return;

  const data = await api('/api/presets', {
    method: 'POST',
    body: JSON.stringify({
      action: 'save',
      name: values.name,
      prompt: $('#promptText').value,
      negative: $('#negText').value,
      tags: currentTags(false),
    }),
  });
  state.presets = data.presets;
  await recordCombo();
  renderPresets();
  renderRecommendations();
  toast('已收藏');
}

/* ============================ 撤销 / 重做 =============================== */

const undo = { stack: [], redo: [], limit: 80, last: { pos: '', neg: '' }, timer: null };

const snapshot = () => ({ pos: $('#promptText').value, neg: $('#negText').value });

function updateUndoButtons() {
  const u = $('#btnUndo');
  const r = $('#btnRedo');
  if (u) u.disabled = undo.stack.length === 0;
  if (r) r.disabled = undo.redo.length === 0;
}

function commitUndo() {
  const now = snapshot();
  if (now.pos === undo.last.pos && now.neg === undo.last.neg) return;
  undo.stack.push({ ...undo.last });
  if (undo.stack.length > undo.limit) undo.stack.shift();
  undo.redo.length = 0;
  undo.last = now;
  updateUndoButtons();
}

function applySnapshot(snap) {
  $('#promptText').value = snap.pos;
  $('#negText').value = snap.neg;
  undo.last = { ...snap };
  onPromptChanged();
  renderTags();
}

function undoStep() {
  const prev = undo.stack.pop();
  if (!prev) { toast('没有可撤销的操作'); return; }
  undo.redo.push(snapshot());
  applySnapshot(prev);
  updateUndoButtons();
  toast('已撤销');
}

function redoStep() {
  const next = undo.redo.pop();
  if (!next) { toast('没有可重做的操作'); return; }
  undo.stack.push(snapshot());
  applySnapshot(next);
  updateUndoButtons();
  toast('已重做');
}

/* ============================ 复制格式 ================================== */

const COPY_MODE_OPTIONS = [
  { value: 'none', label: '都不加（纯提示词）' },
  { value: 'negative', label: '只给负面提示词加' },
  { value: 'both', label: '正面和负面都加' },
];

const DEFAULT_COPY_POS_PREFIX = 'Positive prompt: ';
const DEFAULT_COPY_NEG_PREFIX = 'Negative prompt: ';

/** 当前设置下，正 / 负两边要不要带前缀 */
function copyPrefixFlags(settings) {
  const s = settings || state.settings;
  const mode = s.copy_prefix_mode || 'negative';
  return { pos: mode === 'both', neg: mode === 'both' || mode === 'negative' };
}

/** 按「设置 → 复制格式」把正负提示词拼成一段可直接粘贴的文本 */
function formatPromptText(positive, negative, settings) {
  const s = settings || state.settings;
  const add = copyPrefixFlags(s);
  const posLabel = s.copy_positive_prefix ?? DEFAULT_COPY_POS_PREFIX;
  const negLabel = s.copy_negative_prefix ?? DEFAULT_COPY_NEG_PREFIX;
  const pos = String(positive ?? '').trim();
  const neg = String(negative ?? '').trim();

  const blocks = [];
  if (pos) blocks.push(add.pos ? posLabel + pos : pos);
  if (neg) blocks.push(add.neg ? negLabel + neg : neg);
  return blocks.join('\n\n');
}

async function copyText(text, message) {
  const value = String(text || '');
  if (!value.trim()) { toast('没有可复制的内容'); return false; }

  // 1) 现代剪贴板 API
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      toast(message);
      return true;
    }
  } catch (_) { /* 落到下面的兜底 */ }

  // 2) textarea + execCommand 兜底（WKWebView / 老浏览器里 async clipboard 会被拒）
  try {
    const scratch = document.createElement('textarea');
    scratch.value = value;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-2000px';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    scratch.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    scratch.remove();
    if (ok) { toast(message); return true; }
  } catch (_) { /* 继续往下报错 */ }

  toast('复制失败：当前环境不允许访问剪贴板', 3200);
  return false;
}

function copyPositive() {
  return copyText(
    formatPromptText($('#promptText').value, ''),
    copyPrefixFlags().pos ? '已复制正向提示词（含前缀）' : '已复制正向提示词',
  );
}

function copyNegative() {
  return copyText(
    formatPromptText('', $('#negText').value),
    copyPrefixFlags().neg ? '已复制负面提示词（含前缀）' : '已复制负面提示词',
  );
}

function copyBoth() {
  const add = copyPrefixFlags();
  const suffix = add.pos && add.neg ? '（含正负前缀）' : (add.neg ? '（负面含前缀）' : '（纯提示词）');
  return copyText(
    formatPromptText($('#promptText').value, $('#negText').value),
    `已复制正向 + 负面${suffix}`,
  );
}

function updateCopyPreview() {
  const override = {
    copy_prefix_mode: $('#setCopyMode').value,
    copy_positive_prefix: $('#setCopyPosPrefix').value,
    copy_negative_prefix: $('#setCopyNegPrefix').value,
  };
  $('#copyPreview').textContent = formatPromptText(
    '1girl, forest, masterpiece', 'low quality, blurry', override,
  ) || '（没有内容）';
}

/* ====================== 本地标签库：中英互译 ============================ */

const HAS_CJK = /[\u4e00-\u9fff]/;

function lookupChinese(fragment) {
  const text = String(fragment || '').trim();
  if (!text) return null;
  if (state.zhIndex.has(text)) return state.zhIndex.get(text);

  const pool = state.tagIndex.filter((t) => t.zh.includes(text) || text.includes(t.zh));
  if (!pool.length) return null;
  pool.sort((a, b) => Math.abs(a.zh.length - text.length) - Math.abs(b.zh.length - text.length));
  return pool[0];
}

/** 把一段纯中文按词库拆成多个标签；只有整段被覆盖才认为成功。 */
function splitChinese(text) {
  const pool = state.tagIndex.slice().sort((a, b) => b.zh.length - a.zh.length);
  const taken = new Array(text.length).fill(false);
  const hits = [];

  for (const tag of pool) {
    if (!tag.zh) continue;
    let from = 0;
    while (from <= text.length - tag.zh.length) {
      const at = text.indexOf(tag.zh, from);
      if (at === -1) break;
      const end = at + tag.zh.length;
      if (!taken.slice(at, end).some(Boolean)) {
        for (let i = at; i < end; i += 1) taken[i] = true;
        hits.push({ tag, at });
        break;
      }
      from = at + 1;
    }
  }

  hits.sort((a, b) => a.at - b.at);
  // 必须覆盖整段（允许中间的空格和标点）才算拆分成功
  const covered = taken.filter(Boolean).length;
  const meaningful = text.replace(/[\s、，,。.·的]/g, '').length;
  if (!hits.length || covered < meaningful) return [];
  return hits.map((h) => h.tag);
}

function translateTextLocally(text) {
  const items = parseSegments(text);
  const out = [];
  let hit = 0;
  const missed = [];

  for (const item of items) {
    const base = item.base;
    if (!/[\u4e00-\u9fff]/.test(base)) { out.push(item); continue; }

    const tag = lookupChinese(base);
    if (tag) { out.push({ base: tag.en, weight: item.weight }); hit += 1; continue; }

    const parts = splitChinese(base);
    if (parts.length > 1) {
      parts.forEach((t) => out.push({ base: t.en, weight: null }));
      hit += 1;
      continue;
    }
    missed.push(base);
    out.push(item);
  }
  return { text: serializeSegments(out), hit, missed };
}

/**
 * 英 → 中：按标签整条匹配，不做逐词翻译。
 * 只把「整段就等于某个标签 en」的片段换掉，找不到的原样留着。
 */
function translateEnToZh(text) {
  const items = parseSegments(text);
  const out = [];
  let hit = 0;

  for (const item of items) {
    const tag = tagByEn(item.base);
    if (tag && tag.zh) {
      out.push({ base: tag.zh, weight: item.weight });
      hit += 1;
    } else {
      out.push(item);
    }
  }
  return { text: serializeSegments(out), hit, missed: [] };
}

/** 按这一侧的内容自动判方向：含中文就中译英，否则英译中 */
function translateSide(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, hit: 0, missed: [], dir: null };
  if (HAS_CJK.test(raw)) return { ...translateTextLocally(raw), dir: 'zh2en' };
  return { ...translateEnToZh(raw), dir: 'en2zh' };
}

function runLocalTranslate() {
  const posBefore = $('#promptText').value;
  const negBefore = $('#negText').value;
  const pos = translateSide(posBefore);
  const neg = translateSide(negBefore);

  const changed = pos.hit + neg.hit;
  if (!changed) {
    toast(
      HAS_CJK.test(posBefore + negBefore)
        ? '没有能整条匹配的中文标签，试试联网的「AI 翻译」'
        : '这些英文在标签库里没有对应标签，试试联网的「AI 翻译」',
      3200,
    );
    return;
  }

  if (pos.hit) $('#promptText').value = pos.text;
  if (neg.hit) $('#negText').value = neg.text;
  commitUndo();
  onPromptChanged();
  renderTags();

  const dirs = new Set([pos.dir, neg.dir].filter(Boolean));
  const label = dirs.size === 1
    ? (dirs.has('zh2en') ? '中文 → 英文' : '英文 → 中文')
    : '中英互译';
  const missed = pos.missed.concat(neg.missed);
  toast(
    missed.length
      ? `${label}：替换 ${changed} 个标签；词库里没有：${missed.slice(0, 3).join('、')}`
      : `${label}：已按标签替换 ${changed} 处`,
    missed.length ? 3600 : 2400,
  );
}

/* ============================= AI 翻译 ================================== */

let translateDir = 'zh2en';

function openTranslate() {
  $('#translateSource').value = $('#promptText').value;
  $('#translateResult').value = '';
  $('#translateStatus').textContent = '';
  $('#translateStatus').className = 'status';
  setTranslateDir(translateDir);
  openModal('#modalTranslate');
}

function setTranslateDir(dir) {
  translateDir = dir;
  $$('#translateDir .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.dir === dir));
}

async function runTranslate() {
  const text = $('#translateSource').value.trim();
  if (!text) { toast('请先填写原文'); return; }

  const status = $('#translateStatus');
  const btn = $('#btnTranslateRun');
  status.className = 'status loading';
  status.textContent = '正在请求大模型翻译，请稍候…';
  btn.disabled = true;

  try {
    const data = await api('/api/translate', {
      method: 'POST',
      body: JSON.stringify({ text, direction: translateDir }),
    });
    $('#translateResult').value = String(data.content || '').trim();
    status.className = 'status ok';
    status.textContent = `✓ 完成（模型：${data.model}）`;
  } catch (err) {
    status.className = 'status err';
    status.textContent = `✗ ${err.message}${err.detail ? `\n${err.detail}` : ''}`;
  } finally {
    btn.disabled = false;
  }
}

/* ============================ 负面词模板 ================================ */

function openNegativeTemplates() {
  const list = state.templates.negativeTemplates || [];
  const box = $('#negTplList');

  if (!list.length) {
    box.innerHTML = '<div class="empty-tip">没有读到模板<br><small>检查 app/data/templates.json 是否存在</small></div>';
    openModal('#modalNegTemplates');
    return;
  }

  box.innerHTML = list.map((tpl) => `
    <div class="tpl-card">
      <div class="tpl-head">
        <strong>${esc(tpl.name)}</strong>
        <span class="en">${esc(tpl.nameEn || '')}</span>
        <span class="n">${(tpl.tags || []).length} 个词</span>
      </div>
      <p class="tpl-desc">${esc(tpl.description || '')}</p>
      <div class="tpl-tags">${(tpl.tags || []).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      <div class="row-inline">
        <button class="mini" data-tpl-append="${esc(tpl.id)}">追加到负面词</button>
        <button class="mini" data-tpl-replace="${esc(tpl.id)}">替换负面词</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-tpl-append]').forEach((b) => b.addEventListener('click', () => {
    applyNegativeTemplate(b.dataset.tplAppend, false);
  }));
  box.querySelectorAll('[data-tpl-replace]').forEach((b) => b.addEventListener('click', () => {
    applyNegativeTemplate(b.dataset.tplReplace, true);
  }));

  openModal('#modalNegTemplates');
}

function applyNegativeTemplate(id, replace) {
  const tpl = (state.templates.negativeTemplates || []).find((t) => t.id === id);
  if (!tpl) return;

  const existing = replace ? [] : parseSegments($('#negText').value);
  const seen = new Set(existing.map((item) => item.base.toLowerCase()));
  let added = 0;
  const items = existing.slice();

  for (const en of tpl.tags || []) {
    const key = String(en).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ base: en, weight: null });
    added += 1;
  }

  writeSide('neg', items);
  toast(replace
    ? `已套用「${tpl.name}」：${items.length} 个负面词`
    : `已追加「${tpl.name}」：新增 ${added} 个负面词`);
}

/* ============================ 随机灵感 ================================== */

function poolForSlot(slot) {
  const cats = new Set(slot.categories || []);
  const groups = new Set(slot.groups || []);
  return state.tagIndex.filter((t) => {
    if (t.negative || !cats.has(t.catId)) return false;
    if (groups.size && !groups.has(t.groupId)) return false;
    return true;
  });
}

const pickRandom = (arr, n) => {
  const copy = arr.slice();
  const out = [];
  while (copy.length && out.length < n) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
};

function generateInspiration(themeId) {
  const theme = ((state.templates.inspiration || {}).themes || []).find((t) => t.id === themeId);
  if (!theme) return null;

  const tags = [];
  const seen = new Set();
  for (const slot of theme.slots || []) {
    const pool = poolForSlot(slot).filter((t) => !seen.has(t.en));
    pickRandom(pool, Math.max(1, Number(slot.count) || 1)).forEach((tag) => {
      seen.add(tag.en);
      tags.push(tag);
    });
  }
  if (!tags.length) return null;
  return { tags, prompt: tags.map((t) => t.en).join(', ') };
}

function renderInspireThemes() {
  const themes = ((state.templates.inspiration || {}).themes || []);
  $('#inspireThemes').innerHTML = themes.map((t) => `
    <button class="inspire-theme${t.id === state.inspireTheme ? ' is-active' : ''}" data-theme="${esc(t.id)}">
      ${esc(t.name)}
    </button>`).join('');

  $('#inspireThemes').querySelectorAll('.inspire-theme').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.inspireTheme = btn.dataset.theme;
      renderInspireThemes();
      rollInspiration();
    });
  });
}

function rollInspiration() {
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const result = generateInspiration(state.inspireTheme);
    if (result) out.push(result);
  }
  state.inspireCandidates = out;
  renderInspireList();
}

function renderInspireList() {
  const box = $('#inspireList');
  if (!state.inspireCandidates.length) {
    box.innerHTML = '<div class="empty-tip">没能生成灵感<br><small>检查 app/data/templates.json</small></div>';
    return;
  }

  box.innerHTML = state.inspireCandidates.map((cand, index) => `
    <div class="inspire-card">
      <div class="inspire-card-head">
        <span class="idx">方案 ${index + 1}</span>
        <span class="hint">${cand.tags.length} 个标签</span>
        <span class="spacer"></span>
        <button class="mini" data-inspire-append="${index}">追加到正向</button>
        <button class="mini" data-inspire-apply="${index}">替换正向</button>
        <button class="mini" data-inspire-copy="${index}">复制</button>
      </div>
      <p class="inspire-prompt">${cand.tags.map((t) => `<span class="ip-tag" title="${esc(t.zh)} · ${esc(t.catName)} / ${esc(t.groupName)}">${esc(t.en)}</span>`).join(', ')}</p>
    </div>`).join('');

  box.querySelectorAll('[data-inspire-apply]').forEach((b) => b.addEventListener('click', () => {
    const cand = state.inspireCandidates[Number(b.dataset.inspireApply)];
    $('#promptText').value = cand.prompt;
    commitUndo();
    onPromptChanged();
    renderTags();
    closeModal('#modalInspiration');
    toast(`已应用方案 ${Number(b.dataset.inspireApply) + 1}`);
  }));

  box.querySelectorAll('[data-inspire-append]').forEach((b) => b.addEventListener('click', () => {
    const cand = state.inspireCandidates[Number(b.dataset.inspireAppend)];
    const items = parseSegments($('#promptText').value);
    const seen = new Set(items.map((i) => i.base.toLowerCase()));
    let added = 0;
    cand.tags.forEach((t) => {
      if (seen.has(t.en.toLowerCase())) return;
      seen.add(t.en.toLowerCase());
      items.push({ base: t.en, weight: null });
      added += 1;
    });
    writeSide('pos', items);
    closeModal('#modalInspiration');
    toast(`已追加 ${added} 个标签`);
  }));

  box.querySelectorAll('[data-inspire-copy]').forEach((b) => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.inspireCandidates[Number(b.dataset.inspireCopy)].prompt);
    toast('已复制到剪贴板');
  }));
}

function openInspiration() {
  const themes = ((state.templates.inspiration || {}).themes || []);
  if (!themes.length) { toast('没有读到灵感主题数据', 2800); return; }
  if (!themes.some((t) => t.id === state.inspireTheme)) state.inspireTheme = themes[0].id;
  renderInspireThemes();
  rollInspiration();
  openModal('#modalInspiration');
}

/* ============================ 方案槽位 ================================== */

const SLOT_KEYS = ['A', 'B', 'C', 'D'];

function ensureSlots() {
  const raw = Array.isArray(state.slots) ? state.slots : [];
  state.slots = SLOT_KEYS.map((_, index) => ({
    prompt: String((raw[index] && raw[index].prompt) || ''),
    negative: String((raw[index] && raw[index].negative) || ''),
  }));
}

function saveSlots() {
  api('/api/settings', { method: 'POST', body: JSON.stringify({ slots: state.slots }) }).catch(() => {});
  updateSlotBadge();
}

function updateSlotBadge() {
  const badge = $('#slotBadge');
  if (!badge) return;
  const n = state.slots.filter((s) => s.prompt.trim() || s.negative.trim()).length;
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

/** 槽位是否算「有内容」 */
function slotFilled(slot) {
  return Boolean(slot && (String(slot.prompt || '').trim() || String(slot.negative || '').trim()));
}

/** 一句话描述槽位里有什么，用于确认框 */
function slotSummary(slot) {
  const pos = parseSegments(String(slot.prompt || '')).length;
  const neg = parseSegments(String(slot.negative || '')).length;
  const parts = [];
  parts.push(pos ? `${pos} 个正向标签` : '无正向');
  parts.push(neg ? `${neg} 个负面标签` : '无负面');
  return parts.join('，');
}

/** 槽位卡片正文：正向 + 负面都摊开显示，避免「以为没存负面」 */
function slotBody(slot) {
  const pos = String(slot.prompt || '').trim();
  const neg = String(slot.negative || '').trim();
  const rows = [];
  rows.push(`<div class="slot-line"><b class="slot-lbl pos">正</b><span>${pos ? esc(pos) : '<i class="dim">（无正向）</i>'}</span></div>`);
  if (neg) rows.push(`<div class="slot-line"><b class="slot-lbl neg">负</b><span>${esc(neg)}</span></div>`);
  return rows.join('');
}

/** 存入当前工作区内容 */
function saveToSlot(index) {
  const storeNeg = state.settings.slot_store_negative !== false;
  const prompt = $('#promptText').value.trim();
  const negative = storeNeg ? $('#negText').value.trim() : '';
  const existing = state.slots[index] || { prompt: '', negative: '' };
  const occupied = slotFilled(existing);

  // 空值绝不覆盖 —— 想清空只能用「清空」按钮
  if (!prompt && !negative) {
    toast(
      occupied
        ? `工作区是空的，没有内容可存入。想清空槽位 ${SLOT_KEYS[index]} 请点「清空」按钮。`
        : '工作区是空的，没有内容可以存入。',
      3600,
    );
    return;
  }

  if (occupied) {
    const ok = window.confirm(
      `槽位 ${SLOT_KEYS[index]} 里已经有内容了。\n\n` +
      `现在：${slotSummary(existing)}\n` +
      `即将变成：${slotSummary({ prompt, negative })}\n\n` +
      '确定覆盖吗？\n（只想清空的话，请用「清空」按钮）',
    );
    if (!ok) { toast('已取消，槽位内容未改动'); return; }
  }

  state.slots[index] = { prompt, negative };
  saveSlots();
  renderSlots();
  toast(
    negative
      ? `已存入槽位 ${SLOT_KEYS[index]}（正向 + 负面）`
      : `已存入槽位 ${SLOT_KEYS[index]}（仅正向）`,
  );
}

/** 同步「存负面」开关的界面状态 */
function syncSlotOption() {
  const on = state.settings.slot_store_negative !== false;
  const box = $('#slotStoreNeg');
  if (box) box.checked = on;
  const tip = $('#slotStoreNegTip');
  if (tip) {
    tip.textContent = on
      ? '当前：点「存入当前」会把正向和负面一起存进槽位。'
      : '当前：点「存入当前」只存正向。已存进槽位的负面不会被清掉，只是之后不再更新。';
  }
}

function renderSlots() {
  const box = $('#slotList');
  box.innerHTML = state.slots.map((slot, index) => {
    const empty = !slot.prompt.trim() && !slot.negative.trim();
    const count = parseSegments(slot.prompt).length;
    return `
      <div class="slot-card${empty ? ' is-empty' : ''}">
        <div class="slot-card-head">
          <span class="key">${SLOT_KEYS[index]}</span>
          <strong>${empty ? '空槽位' : `${count} 个正向标签`}</strong>
          <time>${empty ? '' : (slot.negative.trim() ? '含负面词' : '无负面词')}</time>
        </div>
        <div class="slot-body${empty ? ' empty' : ''}">${empty ? '还没有内容，点「存入当前」保存当前提示词' : slotBody(slot)}</div>
        <div class="row-inline">
          <button class="mini" data-slot-save="${index}">存入当前</button>
          <button class="mini" data-slot-load="${index}"${empty ? ' disabled' : ''}>载入</button>
          <button class="mini" data-slot-copy="${index}"${empty ? ' disabled' : ''}>复制</button>
          <button class="mini danger" data-slot-clear="${index}"${empty ? ' disabled' : ''}>清空</button>
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('[data-slot-save]').forEach((b) => b.addEventListener('click', () => {
    saveToSlot(Number(b.dataset.slotSave));
  }));

  box.querySelectorAll('[data-slot-load]').forEach((b) => b.addEventListener('click', () => {
    const slot = state.slots[Number(b.dataset.slotLoad)];
    $('#promptText').value = slot.prompt;
    $('#negText').value = slot.negative;
    commitUndo();
    onPromptChanged();
    renderTags();
    toast('已载入槽位');
  }));

  box.querySelectorAll('[data-slot-copy]').forEach((b) => b.addEventListener('click', async () => {
    const slot = state.slots[Number(b.dataset.slotCopy)];
    await copyText(
      formatPromptText(slot.prompt, slot.negative),
      `已复制槽位 ${SLOT_KEYS[Number(b.dataset.slotCopy)]}`,
    );
  }));

  box.querySelectorAll('[data-slot-clear]').forEach((b) => b.addEventListener('click', () => {
    const index = Number(b.dataset.slotClear);
    const slot = state.slots[index];
    const ok = window.confirm(
      `确定清空槽位 ${SLOT_KEYS[index]} 吗？\n\n` +
      `将丢弃：${slotSummary(slot)}\n\n` +
      '这一步无法撤销。',
    );
    if (!ok) { toast('已取消，槽位未改动'); return; }
    state.slots[index] = { prompt: '', negative: '' };
    saveSlots();
    renderSlots();
    toast(`已清空槽位 ${SLOT_KEYS[index]}`);
  }));

  updateSlotBadge();
  renderCompare();
}

function renderCompare() {
  const box = $('#slotCompare');
  if (!state.compareOpen) { box.hidden = true; box.innerHTML = ''; return; }

  const columns = state.slots
    .map((slot, index) => ({
      key: SLOT_KEYS[index],
      items: parseSegments(slot.prompt),
      negative: String(slot.negative || '').trim(),
    }))
    .filter((col) => col.items.length || col.negative);
  columns.push({
    key: '当前',
    items: parseSegments($('#promptText').value),
    negative: $('#negText').value.trim(),
    current: true,
  });

  if (columns.length < 2) {
    box.hidden = false;
    box.innerHTML = '<div class="empty-tip" style="padding:20px">至少要有两个有内容的槽位才能对比</div>';
    return;
  }

  const counter = new Map();
  columns.forEach((col) => col.items.forEach((item) => {
    const key = item.base.toLowerCase();
    if (!counter.has(key)) counter.set(key, { base: item.base, in: new Set(), known: !!tagByEn(item.base) });
    counter.get(key).in.add(col.key);
  }));

  const shared = Array.from(counter.values()).filter((v) => v.in.size === columns.length);
  const total = Array.from(counter.values()).flatMap((v) => Array.from(v.in)).length;

  box.hidden = false;
  box.innerHTML = `
    <h4>并排对比
      <span class="rec-badge">共 ${counter.size} 个不同标签</span>
      <span class="rec-badge" style="color:var(--pos)">${shared.length} 个共有</span>
    </h4>
    <div class="compare-grid">
      ${columns.map((col) => `
        <div class="compare-col">
          <div class="compare-col-head">
            <span>${esc(col.key)}</span>
            <span class="hint">${col.items.length} 个</span>
          </div>
          ${col.negative ? `<div class="compare-neg"><b>负面</b><span>${esc(col.negative)}</span></div>` : ''}
          <div class="compare-col-body">
            ${col.items.map((item) => {
              const info = counter.get(item.base.toLowerCase()) || { in: new Set(), known: true };
              const cls = info.in.size === columns.length ? ' in-all'
                : (info.in.size === 1 ? ' unique' : '');
              return `<span class="cmp-tag${cls}${info.known ? '' : ' unknown'}">${esc(item.base)}</span>`;
            }).join('')}
          </div>
        </div>`).join('')}
    </div>
    <p class="hint" style="margin-top:10px">
      绿色 = 所有方案共有；黄色 = 只有一个方案独有（共 ${total} 个标签位）。
    </p>`;
}

/* ============================ 工程 导入导出 ============================= */

/** 在原生窗口里调用系统保存对话框；不在原生窗口返回 null */
function nativeSaveFile(filename, text) {
  return new Promise((resolve) => {
    const handlers = window.webkit && window.webkit.messageHandlers;
    const handler = handlers && handlers.saveFile;
    if (!handler) { resolve(null); return; }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      delete window.__nativeSaveResult;
      resolve(result);
    };

    window.__nativeSaveResult = (ok, info) => finish({ ok, info });
    setTimeout(() => finish(null), 8000);   // 桥没响应就退回浏览器下载

    try { handler.postMessage({ filename, content: text }); }
    catch (_) { finish(null); }
  });
}

async function download(filename, text, mime = 'application/json') {
  // 打包成 App 时走原生保存对话框，浏览器里走普通下载
  if (window.__NATIVE_APP__) {
    const saved = await nativeSaveFile(filename, text);
    if (saved) {
      if (saved.ok) toast(`已保存到 ${saved.info}`, 3200);
      else if (saved.info === 'cancelled') toast('已取消保存');
      else toast(`保存失败：${saved.info}`, 3200);
      return;
    }
  }

  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

async function exportProject() {
  const s = state.settings;
  const payload = {
    app: 'ai-prompt-studio',
    version: 1,
    exportedAt: new Date().toISOString(),
    slots: state.slots,
    presets: state.presets,
    parked: state.parked,
    settings: {
      language: s.language,
      theme: s.theme,
      base_url: s.base_url,
      model: s.model,
      timeout: s.timeout,
      vision_system_prompt: s.vision_system_prompt,
      vision_user_prompt: s.vision_user_prompt,
    },
    tags: { version: 1, categories: state.categories },
  };
  await download(`prompt-studio-${stamp()}.json`, JSON.stringify(payload, null, 2));
  $('#projectHint').textContent = '✓ 已导出完整工程 JSON（含标签库，不含 API Key）';
}

async function exportPromptText() {
  const prompt = $('#promptText').value.trim();
  const negative = $('#negText').value.trim();
  if (!prompt && !negative) { toast('提示词是空的'); return; }
  const body = negative
    ? `${prompt}\n\nNegative prompt: ${negative}\n`
    : `${prompt}\n`;
  await download(`prompt-${stamp()}.txt`, body, 'text/plain');
  $('#projectHint').textContent = '✓ 已导出当前提示词 TXT';
}

function importProject() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const notes = [];

      if ($('#importWithSlots').checked && Array.isArray(data.slots)) {
        state.slots = data.slots;
        ensureSlots();
        await api('/api/settings', { method: 'POST', body: JSON.stringify({ slots: state.slots }) });
        notes.push('槽位');
      }

      if ($('#importWithSlots').checked && data.parked) {
        state.parked = {
          pos: Array.isArray(data.parked.pos) ? data.parked.pos : [],
          neg: Array.isArray(data.parked.neg) ? data.parked.neg : [],
        };
        await api('/api/settings', { method: 'POST', body: JSON.stringify({ parked: state.parked }) });
        notes.push('停用区');
      }

      if ($('#importWithPresets').checked && Array.isArray(data.presets)) {
        const result = await api('/api/presets', {
          method: 'POST',
          body: JSON.stringify({ action: 'replace', presets: data.presets }),
        });
        state.presets = result.presets;
        notes.push(`${state.presets.length} 个收藏`);
      }

      if (data.settings && typeof data.settings === 'object') {
        const result = await api('/api/settings', {
          method: 'POST',
          body: JSON.stringify(data.settings),
        });
        state.settings = result.settings;
        notes.push('界面偏好');
      }

      if ($('#importWithTags').checked && data.tags && Array.isArray(data.tags.categories)) {
        const result = await api('/api/tags', {
          method: 'POST',
          body: JSON.stringify({ categories: data.tags.categories }),
        });
        state.categories = result.categories;
        state.tagSource = 'user';
        notes.push(`${result.stats.tags} 个标签`);
      }

      refreshAll();
      renderSlots();
      renderPresets();
      $('#projectHint').textContent = notes.length ? `✓ 已导入：${notes.join('、')}` : '没有可导入的内容';
      toast(notes.length ? `导入完成：${notes.join('、')}` : '没有可导入的内容', 3000);
    } catch (err) {
      $('#projectHint').textContent = `✗ 导入失败：${err.message}`;
      toast(`导入失败：${err.message}`, 3600);
    }
  });
  input.click();
}

/* ============================ 快捷键 ==================================== */

const IS_MAC = /Mac|iPhone|iPad|iPod/i.test((navigator && navigator.userAgent) || '');
const MOD = IS_MAC ? 'Cmd' : 'Ctrl';

const SHORTCUTS = [
  { keys: [MOD, 'Z'], desc: '撤销上一步' },
  { keys: [MOD, 'Shift', 'Z'], desc: '重做' },
  { keys: [MOD, 'K'], desc: '聚焦标签搜索框' },
  { keys: [MOD, 'S'], desc: '收藏当前组合' },
  { keys: [MOD, 'Shift', 'C'], desc: '复制正向 + 负面提示词（格式见设置）' },
  { keys: ['Alt', 'G'], desc: '本地中英互译：按标签匹配，中文转英文、英文转中文（不联网）' },
  { keys: ['Alt', 'L'], desc: '打开 AI 翻译' },
  { keys: ['Alt', 'P'], desc: '打开 AI 润色' },
  { keys: ['Alt', 'T'], desc: '打开负面词模板' },
  { keys: ['Alt', 'R'], desc: '随机灵感' },
  { keys: ['Alt', '↑ / ↓'], desc: '上一个 / 下一个分类' },
  { keys: ['Alt', '1…9'], desc: '跳到第 N 个分类' },
  { keys: ['Alt', '0'], desc: '回到「全部标签」' },
  { keys: ['?'], desc: '打开这张快捷键表' },
  { keys: ['Esc'], desc: '关闭当前弹窗 / 收起语言菜单' },
];

function openShortcuts() {
  $('#kbdList').innerHTML = SHORTCUTS.map((item) => `
    <div class="kbd-row">
      <span class="keys">${item.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>
      <span class="desc">${esc(item.desc)}</span>
    </div>`).join('');
  openModal('#modalShortcuts');
}

/** index：0 = 全部标签，1…N = 第 index 个分类 */
function jumpCategory(index) {
  const list = [null, ...state.categories.map((c) => c.id)];
  if (index < 0 || index >= list.length) return;
  state.activeCat = list[index];
  $('#tagSearch').value = '';
  $('#searchClear').hidden = true;
  renderCategories();
  renderTags();
  const name = index === 0 ? '全部标签' : state.categories[index - 1].name;
  toast(`已跳到「${name}」`);
}

function cycleCategory(step) {
  const list = [null, ...state.categories.map((c) => c.id)];
  const current = list.indexOf(state.activeCat);
  const next = ((current < 0 ? 0 : current) + step + list.length) % list.length;
  jumpCategory(next);
}

function handleShortcut(event) {
  const mod = event.metaKey || event.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target && event.target.tagName) || '');
  const key = String(event.key || '').toLowerCase();

  if (mod && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoStep(); else undoStep();
    return;
  }
  if (mod && key === 'y') { event.preventDefault(); redoStep(); return; }
  if (mod && key === 'k') { event.preventDefault(); $('#tagSearch').focus(); return; }
  if (mod && key === 's') {
    event.preventDefault();
    if ($('#modalForm').hidden) savePreset();
    return;
  }
  if (mod && event.shiftKey && key === 'c') {
    event.preventDefault();
    copyBoth();
    return;
  }

  if (event.altKey && !mod) {
    if (key === 'r') { event.preventDefault(); openInspiration(); return; }
    if (key === 't') { event.preventDefault(); openNegativeTemplates(); return; }
    if (key === 'l') { event.preventDefault(); openTranslate(); return; }
    if (key === 'p') { event.preventDefault(); openPolish(); return; }
    if (key === 'g') { event.preventDefault(); runLocalTranslate(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      cycleCategory(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (/^[0-9]$/.test(key)) { event.preventDefault(); jumpCategory(Number(key)); return; }
  }

  if (typing) return;
  if (event.key === '?') { event.preventDefault(); openShortcuts(); }
}

/* ============================ 工具事件绑定 ============================== */

function bindEfficiencyEvents() {
  $('#btnUndo').addEventListener('click', undoStep);
  $('#btnRedo').addEventListener('click', redoStep);
  $('#btnLocalTranslate').addEventListener('click', runLocalTranslate);
  $('#btnAiTranslate').addEventListener('click', openTranslate);
  $('#btnAiPolish').addEventListener('click', openPolish);
  $('#btnNegativeTemplates').addEventListener('click', openNegativeTemplates);
  $('#btnInspiration').addEventListener('click', openInspiration);
  $('#btnSlots').addEventListener('click', () => {
    syncSlotOption();
    renderSlots();
    openModal('#modalSlots');
  });

  // 槽位：是否一并保存负面提示词
  $('#slotStoreNeg').addEventListener('change', async (event) => {
    state.settings.slot_store_negative = event.target.checked;
    syncSlotOption();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ slot_store_negative: event.target.checked }),
      });
      toast(event.target.checked ? '存入槽位时会一并保存负面提示词' : '存入槽位时只保存正向提示词');
    } catch (_) {
      toast('设置没能保存，请重试', 2800);
    }
  });
  $('#btnProject').addEventListener('click', () => {
    $('#projectHint').textContent = '';
    openModal('#modalProject');
  });
  $('#btnShortcuts').addEventListener('click', openShortcuts);

  // AI 翻译
  $$('#translateDir .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTranslateDir(btn.dataset.dir));
  });
  $('#btnTranslateRun').addEventListener('click', runTranslate);
  $('#btnTranslateLoadPos').addEventListener('click', () => {
    $('#translateSource').value = $('#promptText').value;
  });
  $('#btnTranslateSwap').addEventListener('click', () => {
    $('#translateSource').value = $('#translateResult').value;
    $('#translateResult').value = '';
    toast('已把译文放回原文框');
  });
  $('#btnTranslateApply').addEventListener('click', () => {
    const text = $('#translateResult').value.trim();
    if (!text) { toast('译文是空的'); return; }
    $('#promptText').value = text;
    commitUndo();
    onPromptChanged();
    renderTags();
    closeModal('#modalTranslate');
    toast('已应用到正向提示词');
  });
  $('#btnTranslateCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#translateResult').value);
    toast('已复制译文');
  });

  // AI 润色
  $$('#polishStyle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPolishStyle(btn.dataset.style));
  });
  $$('#polishTarget .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPolishTarget(btn.dataset.target));
  });
  $('#btnPolishRun').addEventListener('click', runPolish);
  $('#btnPolishApply').addEventListener('click', () => applyPolishResult(false));
  $('#btnPolishApplyNeg').addEventListener('click', () => applyPolishResult(true));
  $('#btnPolishReload').addEventListener('click', () => {
    $('#polishSource').value = $('#promptText').value;
    $('#polishSourceNeg').value = $('#negText').value;
    toast('已重新载入工作区内容');
  });
  $('#btnPolishIterate').addEventListener('click', () => {
    const pos = $('#polishResult').value;
    if (!pos.trim()) { toast('还没有润色结果'); return; }
    $('#polishSource').value = pos;
    $('#polishSourceNeg').value = $('#polishResultNeg').value;
    $('#polishResult').value = '';
    $('#polishResultNeg').value = '';
    $('#polishDiff').hidden = true;
    $('#polishNotes').hidden = true;
    $('#btnPolishApply').disabled = true;
    $('#btnPolishApplyNeg').disabled = true;
    toast('已把结果放回左侧，可以继续二次润色');
  });
  $('#btnPolishMergeNo').addEventListener('click', mergeNoParam);
  $('#btnPolishCopy').addEventListener('click', async () => {
    const pos = $('#polishResult').value.trim();
    const neg = $('#polishResultNeg').value.trim();
    if (!pos && !neg) { toast('还没有润色结果'); return; }
    await copyText(formatPromptText(pos, neg), '已复制润色结果');
  });

  // 权重建议
  $('#polishWeightList').addEventListener('change', (event) => {
    const el = event.target;
    const index = Number(el.dataset.wi);
    const item = (state.polishWeightItems || [])[index];
    if (!item) return;

    if (el.type === 'checkbox') {
      item.checked = el.checked;
      renderPolishWeights();
    } else if (el.classList.contains('w-input')) {
      const w = clampWeight(Number(el.value));
      if (w !== null) item.weight = w;
      el.value = item.weight.toFixed(1);
      el.classList.toggle('up', item.weight > 1);
      el.classList.toggle('down', item.weight < 1);
    }
    syncPolishWeights();
  });
  $('#btnWeightAll').addEventListener('click', () => setAllWeights(true));
  $('#btnWeightNone').addEventListener('click', () => setAllWeights(false));
  $('#btnWeightReset').addEventListener('click', resetWeightValues);

  // 随机灵感
  $('#btnInspireReroll').addEventListener('click', rollInspiration);

  // 方案槽位
  $('#btnCompareSlots').addEventListener('click', () => {
    state.compareOpen = !state.compareOpen;
    $('#btnCompareSlots').classList.toggle('accent', state.compareOpen);
    renderCompare();
  });

  // 工程
  $('#btnExportProject').addEventListener('click', exportProject);
  $('#btnExportPrompt').addEventListener('click', exportPromptText);
  $('#btnImportProject').addEventListener('click', importProject);

  // 快捷键
  document.addEventListener('keydown', handleShortcut);

  // 输入时防抖记录撤销点
  ['#promptText', '#negText'].forEach((sel) => {
    $(sel).addEventListener('input', () => {
      clearTimeout(undo.timer);
      undo.timer = setTimeout(commitUndo, 600);
    });
  });

  updateUndoButtons();
}

/* ============================ AI 润色 =================================== */

let polishStyle = 'balanced';
let polishTarget = 'tags';

const POLISH_STYLE_DESC = {
  balanced: '保持原意，补齐缺失的光线 / 构图 / 画质维度，并按标准顺序重排，不凭空添加新主体。',
  enrich: '主体不变，大幅补充材质、光影、环境、氛围、镜头等细节，让画面更饱满。',
  simplify: '删掉重复、冲突和低影响力的词，精简到最关键的 20–35 个。',
  reorder: '只调整顺序和格式，不新增、不删除、不替换任何关键词。',
  fix: '只修正拼写、语法、模型不认的写法和互相冲突的词，不新增关键词。',
};

const POLISH_TARGET_DESC = {
  tags: '全小写英文关键词，逗号分隔，支持 (关键词:权重) 语法。',
  midjourney: '英文自然短语 + 逗号分隔，末尾附 --ar / --stylize 参数，不用括号权重。',
  natural: '连贯的英文描述句，不用逗号堆砌关键词，也不用括号权重。',
};

function setPolishStyle(value) {
  polishStyle = value;
  $$('#polishStyle .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.style === value));
  updatePolishDesc();
}

function setPolishTarget(value) {
  polishTarget = value;
  $$('#polishTarget .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.target === value));
  updatePolishDesc();
  updateMergeNoButton();
}

function updatePolishDesc() {
  $('#polishDesc').innerHTML =
    `<b>润色方式</b>：${esc(POLISH_STYLE_DESC[polishStyle] || '')}<br>`
    + `<b>输出目标</b>：${esc(POLISH_TARGET_DESC[polishTarget] || '')}`;
}

function openPolish() {
  const prompt = $('#promptText').value.trim();
  const negative = $('#negText').value.trim();
  if (!prompt && !negative) {
    toast('先写点提示词再来润色吧');
    return;
  }
  $('#polishSource').value = $('#promptText').value;
  $('#polishSourceNeg').value = $('#negText').value;
  $('#polishResult').value = '';
  $('#polishResultNeg').value = '';
  $('#polishDiff').hidden = true;
  $('#polishNotes').hidden = true;
  $('#polishWeights').hidden = true;
  showReasoning('polishReasoning', '', false);
  $('#polishWeightList').innerHTML = '';
  state.polishWeightItems = [];
  state.polishWeightOriginal = [];
  state.appliedWeights = new Set();
  $('#polishStatus').textContent = '';
  $('#polishStatus').className = 'status';
  $('#btnPolishApply').disabled = true;
  $('#btnPolishApplyNeg').disabled = true;
  updatePolishDesc();
  updateMergeNoButton();
  openModal('#modalPolish');
}

/** 把 Midjourney 的 --no 参数从正向里拆出来，避免负面和正向糊在一起 */
function splitNoParam(text) {
  const source = String(text || '');
  const m = source.match(/(?:^|\s)--no\s+([\s\S]+?)(?=\s--[a-zA-Z]|$)/);
  if (!m) return { prompt: source.trim(), negative: '' };
  const positive = (source.slice(0, m.index) + source.slice(m.index + m[0].length))
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { prompt: positive, negative: m[1].trim() };
}

/** 模型没按格式输出时的兜底：至少把后面的「说明 / WEIGHTS / NEGATIVE」块切掉 */
function stripTrailingBlocks(text) {
  const deco = '[\\s>*#\\-_`]*';
  const re = new RegExp(
    `^${deco}(?:说明|修改说明|WEIGHTS|权重建议|NEGATIVE|负面提示词)${deco}[:：]`,
    'im',
  );
  const m = String(text || '').match(re);
  return (m ? String(text).slice(0, m.index) : String(text)).trim();
}

const isNoneWord = (value) => /^(无|none|n\/?a|—|-|没有)$/i.test(String(value || '').trim());

function parsePolishResult(text) {
  const raw = String(text || '').trim();

  let prompt = grabBlock(raw, 'PROMPT') || grabBlock(raw, '正向提示词');
  let negative = grabBlock(raw, 'NEGATIVE') || grabBlock(raw, '负面提示词');
  const notes = grabBlock(raw, '说明') || grabBlock(raw, '修改说明');
  const weights = grabBlock(raw, 'WEIGHTS') || grabBlock(raw, '权重建议');

  // 兜底：模型整段输出、没打标签时，至少别把「说明」也当成提示词
  if (!prompt) prompt = stripTrailingBlocks(raw);

  // 兜底：模型把 --no 写进正向时，拆出来并入负面
  const split = splitNoParam(prompt);
  if (split.negative) {
    prompt = split.prompt;
    const base = isNoneWord(negative) ? '' : negative.trim();
    negative = base ? `${base}, ${split.negative}` : split.negative;
  }

  if (isNoneWord(negative)) negative = '';

  return { prompt, negative, notes, weights, raw };
}

/** 把负面拼成 Midjourney 的 --no 追加到正向末尾 */
function mergeNoParam() {
  const positive = $('#polishResult').value.trim();
  const negative = $('#polishResultNeg').value.trim();
  if (!negative) { toast('负面提示词是空的，没有可合成的 --no'); return; }
  const clean = splitNoParam(positive).prompt;
  $('#polishResult').value = `${clean} --no ${negative}`;
  toast('已把负面合成 --no 追加到正向末尾（复制到 Midjourney 就能直接用）');
}

function updateMergeNoButton() {
  const btn = $('#btnPolishMergeNo');
  if (btn) btn.hidden = polishTarget !== 'midjourney';
}

/* ---------------------------- 权重建议 ---------------------------------- */

/** 解析 "rim light:1.3, forest:0.8" 形式的一行 */
function parseWeights(text) {
  const raw = String(text || '').trim();
  if (!raw || /^(无|none|n\/a|—|-|无建议)$/i.test(raw)) return [];

  const out = [];
  const seen = new Set();
  raw.split(/[,，;；\n]+/).forEach((chunk) => {
    const piece = chunk.trim().replace(/^[([{【]+|[)\]】}]+$/g, '').trim();
    if (!piece) return;
    const m = piece.match(/^(.*?)\s*[:：]\s*([0-9]*\.?[0-9]+)\s*$/);
    if (!m) return;
    const base = m[1].replace(/^[`*_"'「『]+|[`*_"'」』]+$/g, '').trim();
    const weight = clampWeight(parseFloat(m[2]));
    if (!base || weight === null) return;
    const key = base.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tag: base, weight, checked: true, missing: false });
  });
  return out;
}

function renderPolishWeights() {
  const box = $('#polishWeights');
  const list = $('#polishWeightList');
  const items = state.polishWeightItems || [];

  if (!items.length) {
    box.hidden = true;
    list.innerHTML = '';
    return;
  }
  box.hidden = false;

  list.innerHTML = items.map((item, index) => {
    const known = tagByEn(item.tag);
    const cls = item.missing ? ' is-missing' : (item.checked ? ' is-on' : '');
    const dir = item.weight > 1 ? ' up' : (item.weight < 1 ? ' down' : '');
    return `<label class="weight-row${cls}" title="${esc(item.tag)}">
      <input type="checkbox" data-wi="${index}" ${item.checked ? 'checked' : ''}${item.missing ? ' disabled' : ''}>
      <span class="w-tag">${esc(item.tag)}</span>
      <span class="w-zh">${esc(item.missing ? '未在提示词中' : (known ? known.zh : ''))}</span>
      <input type="number" class="w-input${dir}" data-wi="${index}" value="${item.weight.toFixed(1)}"
             min="0.1" max="3" step="0.05"${item.missing ? ' disabled' : ''}>
    </label>`;
  }).join('');

  const usable = items.filter((i) => !i.missing);
  const on = usable.filter((i) => i.checked).length;
  $('#polishWeightCount').textContent = `${on} / ${usable.length} 已选`;
}

/** 把勾选的权重实时写进「润色结果」 */
function syncPolishWeights() {
  const textarea = $('#polishResult');
  const text = textarea.value;
  if (!text.trim()) return;

  const want = new Map();
  (state.polishWeightItems || []).forEach((item) => {
    if (item.checked && !item.missing) want.set(item.tag.toLowerCase(), item.weight);
  });

  const items = parseSegments(text);
  const next = items.map((item) => {
    const key = item.base.toLowerCase();
    if (want.has(key)) return { base: item.base, weight: want.get(key) };
    if (state.appliedWeights.has(key)) return { base: item.base, weight: null };
    return item;
  });

  state.appliedWeights = new Set(want.keys());
  textarea.value = serializeSegments(next);
  renderPolishDiff(
    $('#polishSource').value,
    $('#polishSourceNeg').value,
    textarea.value,
    $('#polishResultNeg').value,
  );
}

function setAllWeights(checked) {
  (state.polishWeightItems || []).forEach((item) => {
    if (!item.missing) item.checked = checked;
  });
  renderPolishWeights();
  syncPolishWeights();
}

function resetWeightValues() {
  const original = state.polishWeightOriginal || [];
  (state.polishWeightItems || []).forEach((item) => {
    const hit = original.find((o) => o.tag.toLowerCase() === item.tag.toLowerCase());
    if (hit) item.weight = hit.weight;
  });
  renderPolishWeights();
  syncPolishWeights();
  toast('已恢复模型给的权重值');
}

async function runPolish() {
  const prompt = $('#polishSource').value.trim();
  const negative = $('#polishSourceNeg').value.trim();
  if (!prompt && !negative) { toast('没有可润色的内容'); return; }

  const status = $('#polishStatus');
  const btn = $('#btnPolishRun');
  status.className = 'status loading';
  status.textContent = '正在请求大模型润色，请稍候…';
  btn.disabled = true;

  try {
    const data = await api('/api/polish', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        negative,
        style: polishStyle,
        target: polishTarget,
        extra: $('#polishExtra').value.trim(),
        suggest_weights: $('#polishSuggestWeights').checked,
      }),
    });

    const parsed = parsePolishResult(data.content);
    const resultText = parsed.prompt || parsed.raw;
    $('#polishResult').value = resultText;
    $('#polishResultNeg').value = parsed.negative || '';
    state.polishBaseResult = resultText;
    state.appliedWeights = new Set();

    // 权重建议：只保留真正出现在润色结果里的关键词
    const pool = new Set(parseSegments(resultText).map((i) => i.base.toLowerCase()));
    const suggestions = parseWeights(parsed.weights);
    state.polishWeightItems = suggestions.map((s) => ({
      ...s,
      missing: !pool.has(s.tag.toLowerCase()),
    }));
    state.polishWeightOriginal = suggestions.map((s) => ({ tag: s.tag, weight: s.weight }));
    renderPolishWeights();

    renderPolishDiff(prompt, negative, $('#polishResult').value, $('#polishResultNeg').value);
    renderPolishNotes(parsed.notes);

    const usable = state.polishWeightItems.filter((i) => i.checked && !i.missing);
    if (usable.length) syncPolishWeights();

    showReasoning('polishReasoning', data.reasoning, false);
    updateMergeNoButton();

    $('#btnPolishApply').disabled = false;
    $('#btnPolishApplyNeg').disabled = false;
    status.className = 'status ok';
    status.textContent = `✓ 润色完成（模型：${data.model}）`
      + (usable.length ? `，已套用 ${usable.length} 条权重建议` : '');
  } catch (err) {
    status.className = 'status err';
    status.textContent = `✗ ${err.message}${err.detail ? `\n${err.detail}` : ''}`;
    showReasoning('polishReasoning', err.reasoning, true);
  } finally {
    btn.disabled = false;
  }
}

function tagDiff(beforeList, afterList) {
  const beforeSet = new Set(beforeList.map((i) => i.base.toLowerCase()));
  const afterSet = new Set(afterList.map((i) => i.base.toLowerCase()));
  const uniq = (arr) => Array.from(new Set(arr));
  return {
    added: uniq(afterList.filter((i) => !beforeSet.has(i.base.toLowerCase())).map((i) => i.base)),
    removed: uniq(beforeList.filter((i) => !afterSet.has(i.base.toLowerCase())).map((i) => i.base)),
    kept: afterList.filter((i) => beforeSet.has(i.base.toLowerCase())).length,
  };
}

function renderPolishDiff(beforePos, beforeNeg, afterPos, afterNeg) {
  const box = $('#polishDiff');
  const pairs = [
    { label: '正向提示词', before: parseSegments(beforePos), after: parseSegments(afterPos) },
    { label: '负面提示词', before: parseSegments(beforeNeg), after: parseSegments(afterNeg) },
  ].filter((p) => p.before.length || p.after.length);

  const block = (pair) => {
    const isProse = (pair.before.length <= 1 && pair.before.join('').length > 60)
      || (pair.after.length <= 1 && pair.after.join('').length > 60);
    if (isProse) {
      return `<div class="diff-group">
        <div class="diff-group-title">${esc(pair.label)} · 自然语言输出，已整体重写（${pair.before.length} 段 → ${pair.after.length} 段），请直接对比左右文本</div>
      </div>`;
    }
    const diff = tagDiff(pair.before, pair.after);
    return `<div class="diff-group">
      <div class="diff-group-title">
        ${esc(pair.label)} ·
        <span class="pill-add">+${diff.added.length} 新增</span>
        <span class="pill-del">−${diff.removed.length} 移除</span>
        <span class="pill-same">${diff.kept} 保留</span>
      </div>
      <div class="diff-tags">
        ${diff.added.map((t) => `<span class="diff-tag add">${esc(t)}</span>`).join('')}
        ${diff.removed.map((t) => `<span class="diff-tag del">${esc(t)}</span>`).join('')}
        ${(!diff.added.length && !diff.removed.length) ? '<span class="hint">标签集合完全一致</span>' : ''}
      </div>
    </div>`;
  };

  box.hidden = false;
  box.innerHTML = `<div class="polish-diff-head">
      <svg class="ico ico-sm"><use href="#i-chart"/></svg> 标签级变化
    </div>${pairs.map(block).join('')}`;
}

function renderPolishNotes(notes) {
  const box = $('#polishNotes');
  const items = String(notes || '')
    .split(/[;；\n]+|(?<=。)/)
    .map((s) => s.replace(/^[\s\-*·•\d.、]+/, '').trim())
    .filter((s) => s.length > 1);

  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<h4><svg class="ico ico-sm"><use href="#i-sparkle"/></svg> 模型说明</h4>
    <ul>${items.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
}

function applyPolishResult(onlyNegative) {
  const pos = $('#polishResult').value.trim();
  const neg = $('#polishResultNeg').value.trim();

  if (onlyNegative) {
    if (!neg) { toast('负面结果是空的'); return; }
    $('#negText').value = neg;
  } else {
    if (!pos) { toast('润色结果是空的'); return; }
    $('#promptText').value = pos;
    if (neg) $('#negText').value = neg;
  }

  commitUndo();
  onPromptChanged();
  renderTags();
  closeModal('#modalPolish');
  toast(onlyNegative ? '已应用负面提示词' : '已应用到工作区');
}

/* ============================ 事件绑定 ================================== */

function bindEvents() {
  $('#btnTheme').addEventListener('click', cycleTheme);

  const dropdown = $('#langDropdown');
  const trigger = $('#langTrigger');
  const setOpen = (open) => {
    dropdown.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(!dropdown.classList.contains('is-open'));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#langDropdown')) setOpen(false);
  });

  // 展开 / 收起「模型思考过程」
  document.addEventListener('click', (event) => {
    const head = event.target.closest('[data-toggle-reasoning]');
    if (!head) return;
    const box = $('#' + head.dataset.toggleReasoning);
    if (box) box.classList.toggle('is-open');
  });
  $('#langMenu').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
  });

  // 搜索
  $('#tagSearch').addEventListener('input', (event) => {
    $('#searchClear').hidden = !event.target.value;
    renderTags();
  });
  $('#searchClear').addEventListener('click', () => {
    $('#tagSearch').value = '';
    $('#searchClear').hidden = true;
    renderTags();
    $('#tagSearch').focus();
  });

  // 提示词输入
  $('#promptText').addEventListener('input', () => { onPromptChanged(); renderTags(); });
  $('#negText').addEventListener('input', () => { onPromptChanged(); renderTags(); });

  // 芯片区容器级拖拽（只绑一次，避免重复监听）
  ['pos', 'neg'].forEach((side) => {
    const container = sideContainer(side);
    container.dataset.side = side;

    container.addEventListener('dragover', (event) => {
      if (!state.drag || state.drag.side !== side) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      container.classList.add('is-drop-active');
    });
    container.addEventListener('dragleave', (event) => {
      if (event.target === container) container.classList.remove('is-drop-active');
    });
    container.addEventListener('drop', (event) => {
      // 落在空白处 = 移到末尾（芯片自身的 drop 已 stopPropagation）
      if (!state.drag || state.drag.side !== side) return;
      event.preventDefault();
      const from = state.drag.index;
      state.drag = null;
      clearDropMarks(container);
      const items = parseSegments(sideTextarea(side).value);
      if (from < 0 || from >= items.length) return;
      items.push(items.splice(from, 1)[0]);
      writeSide(side, items);
    });
  });

  $('#btnShufflePos').addEventListener('click', () => shuffleSide('pos'));
  $('#btnShuffleNeg').addEventListener('click', () => shuffleSide('neg'));
  $('#btnNormalizePos').addEventListener('click', () => normalizeSide('pos'));
  $('#btnNormalizeNeg').addEventListener('click', () => normalizeSide('neg'));

  $('#btnCopyPos').addEventListener('click', copyPositive);
  $('#btnCopyNeg').addEventListener('click', copyNegative);
  $('#btnCopyAll').addEventListener('click', copyBoth);
  $('#btnClearPos').addEventListener('click', () => {
    $('#promptText').value = '';
    onPromptChanged();
    renderTags();
  });
  $('#btnClearNeg').addEventListener('click', () => {
    $('#negText').value = '';
    onPromptChanged();
    renderTags();
  });
  $('#btnRefreshRec').addEventListener('click', renderRecommendations);
  $('#btnReset').addEventListener('click', () => {
    $('#promptText').value = '';
    $('#negText').value = '';
    onPromptChanged();
    renderTags();
    toast('已重置');
  });

  // 弹窗
  $('#btnSettings').addEventListener('click', () => { fillSettingsForm(); openModal('#modalSettings'); });
  $('#btnVision').addEventListener('click', () => {
    $('#visionUserPrompt').value = '';
    openModal('#modalVision');
  });
  $('#btnOpenPresets').addEventListener('click', () => { renderPresets(); openModal('#modalPresets'); });
  $('#btnSavePreset').addEventListener('click', savePreset);
  $('#btnLibrary').addEventListener('click', openLibrary);
  $('#btnManageFromNav').addEventListener('click', openLibrary);

  $('#btnFormOk').addEventListener('click', submitForm);

  // 表单里的图标选择器
  $('#formBody').addEventListener('click', (event) => {
    const opt = event.target.closest('.icon-opt');
    if (!opt) return;
    const picker = opt.closest('.icon-picker');
    const input = picker.parentElement.querySelector(`input[data-key="${picker.dataset.picker}"]`);
    picker.querySelectorAll('.icon-opt').forEach((b) => b.classList.toggle('is-active', b === opt));
    if (input) input.value = opt.dataset.value;
  });
  $('#formBody').addEventListener('input', (event) => {
    const input = event.target.closest('input[data-key]');
    if (!input) return;
    const picker = input.parentElement.querySelector('.icon-picker');
    if (!picker) return;
    picker.querySelectorAll('.icon-opt')
      .forEach((b) => b.classList.toggle('is-active', b.dataset.value === input.value));
  });

  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal.id === 'modalForm') settleForm(null);
    else closeModal('#' + modal.id);
  }));
  $$('.modal').forEach((modal) => modal.addEventListener('mousedown', (event) => {
    if (event.target !== modal) return;
    if (modal.id === 'modalForm') settleForm(null);
    else closeModal('#' + modal.id);
  }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      if (!$('#modalForm').hidden) { settleForm(null); return; }
      $$('.modal').forEach((m) => { m.hidden = true; });
    }
    if (event.key === 'Enter' && !$('#modalForm').hidden && event.target.tagName === 'INPUT') {
      submitForm();
    }
  });

  $('#btnSaveSettings').addEventListener('click', () => saveSettings().catch((e) => toast(e.message)));
  $('#btnResetPrompt').addEventListener('click', () => {
    $('#setSysPrompt').value = DEFAULT_SYS_PROMPT;
    $('#setUserPrompt').value = DEFAULT_USER_PROMPT;
    $('#saveHint').textContent = '模板已复原，记得点保存';
  });
  $('#btnResetPolishPrompt').addEventListener('click', () => {
    $('#setPolishPrompt').value = DEFAULT_POLISH_PROMPT;
    $('#saveHint').textContent = '润色模板已复原，记得点保存';
  });

  // 复制格式：改任何一项都实时刷新预览
  ['#setCopyMode', '#setCopyPosPrefix', '#setCopyNegPrefix'].forEach((sel) => {
    $(sel).addEventListener('change', updateCopyPreview);
    $(sel).addEventListener('input', updateCopyPreview);
  });

  // 服务商预设 + 连接测试
  $('#setProvider').addEventListener('change', () => applyProvider($('#setProvider').value));
  $('#btnTestConnection').addEventListener('click', testConnection);

  // 模型名：下拉可选，也能直接手填
  $('#btnModelPick').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleModelMenu();
  });
  $('#setModel').addEventListener('input', () => { $('#connResult').hidden = true; });
  // 点别处 / 按 Esc 关掉下拉
  document.addEventListener('click', (event) => {
    const combo = $('#modelCombo');
    if (combo && !combo.hidden && !combo.contains(event.target)) closeModelMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menu = $('#modelMenu');
    if (menu && !menu.hidden) {
      closeModelMenu();
      event.stopPropagation();   // 别把设置弹窗也一起关了
      event.preventDefault();
    }
  }, true);
  // 手动改了地址就自动切到「自定义」，避免预设和实际配置对不上还没提示
  $('#setBaseUrl').addEventListener('input', () => {
    const matched = matchProvider($('#setBaseUrl').value);
    if ($('#setProvider').value !== matched) {
      $('#setProvider').value = matched;
      updateProviderNote();
    }
  });

  // 图片反推
  $('#dropzone').addEventListener('click', () => $('#fileInput').click());
  $('#btnPickImage').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (event) => readFile(event.target.files[0]));
  $('#btnClearImage').addEventListener('click', clearImage);
  $('#btnAnalyze').addEventListener('click', analyzeImage);
  $('#btnFillFromResult').addEventListener('click', parseVisionResult);

  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((evt) => dz.addEventListener(evt, (event) => {
    event.preventDefault();
    dz.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((evt) => dz.addEventListener(evt, (event) => {
    event.preventDefault();
    dz.classList.remove('is-over');
  }));
  dz.addEventListener('drop', (event) => readFile(event.dataTransfer.files[0]));
  document.addEventListener('paste', (event) => {
    if ($('#modalVision').hidden) return;
    const item = Array.from(event.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    if (item) readFile(item.getAsFile());
  });

  bindLibraryEvents();
  bindEfficiencyEvents();
  bindSidebarDrag();
}

function openLibrary() {
  state.libActiveCat = state.activeCat || state.libActiveCat || (state.categories[0] || {}).id || null;
  $('#libCatSearch').value = '';
  $('#libHint').textContent = state.tagSource === 'user'
    ? '正在使用自定义库（data/tags.user.json）。拖动标签 / 分组 / 分类即可自由归类。'
    : '正在使用内置库。拖动标签 / 分组 / 分类即可自由归类，改动会自动存为 data/tags.user.json。';
  renderLibrary();
  openModal('#modalLibrary');
}

function setLanguage(lang) {
  state.lang = lang;
  state.settings.language = lang;
  $('#langLabel').textContent = LANG_LABEL[lang] || lang;
  $('#langMenu').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.lang === lang);
  });
  $('#langDropdown').classList.remove('is-open');
  $('#langTrigger').setAttribute('aria-expanded', 'false');
  refreshAll();
  renderLibrary();
  api('/api/settings', { method: 'POST', body: JSON.stringify({ language: lang }) }).catch(() => {});
}

/* ============================== 启动 ==================================== */

const DEFAULT_SYS_PROMPT = `你是一位资深的 AI 绘画提示词工程师，精通 Stable Diffusion、Midjourney、DALL·E 等主流文生图模型。
请仔细观察用户提供的图片，反推出可直接使用的提示词。

要求：
1. 正向提示词（PROMPT）：英文，关键词之间用英文逗号分隔。按「主体 → 外貌/服装 → 动作表情 → 环境场景 → 光线 → 色彩 → 构图镜头 → 风格 → 画质」的顺序组织。
2. 负面提示词（NEGATIVE）：英文，给出通用的低画质与畸形类排除词。
3. 中文说明：把正向提示词逐项翻译成中文，并简述画面内容。

严格按以下三行格式输出，不要输出任何多余内容、不要使用 Markdown 代码块：

PROMPT: <英文正向提示词>
NEGATIVE: <英文负面提示词>
中文: <中文翻译与简要说明>`;

const DEFAULT_POLISH_PROMPT = `你是一位顶尖的 AI 绘画提示词工程师，精通 Stable Diffusion、ComfyUI、Midjourney、Flux、DALL·E 等主流文生图模型。
用户会给你一段已经写好的正向提示词（可能还有负面提示词），请你按用户指定的方式把它调优。

无论采用哪种调优方式，都必须遵守：
1. 严格按下面三行格式输出，不要输出任何多余内容，不要使用 Markdown 代码块：
PROMPT: <调优后的正向提示词>
NEGATIVE: <调优后的负面提示词>
说明: <用中文列出你做的关键修改，3-6 条，用分号隔开>
2. 「说明」要具体到关键词级别，例如「补了 rim light 与 volumetric light 强化轮廓和光斑」「删掉了重复的 beautiful 与 gorgeous」。
3. 顺手修掉模型识别不了的写法：中文、句号、引号、书名号、多余空格、无意义修饰词。
4. 不要输出任何与画面无关的寒暄。`;

async function boot() {
  try {
    const [tagsData, stateData, tplData] = await Promise.all([
      api('/api/tags'),
      api('/api/state'),
      api('/data/templates.json').catch(() => null),
    ]);
    state.categories = tagsData.categories || [];
    state.tagSource = tagsData.source || 'builtin';
    state.settings = stateData.settings || {};
    state.presets = stateData.presets || [];
    state.history = (stateData.history || []).filter(Array.isArray);
    state.parked = {
      pos: (state.settings.parked && state.settings.parked.pos) || [],
      neg: (state.settings.parked && state.settings.parked.neg) || [],
    };
    state.slots = state.settings.slots || [];
    if (tplData) state.templates = tplData;
    state.lang = state.settings.language || 'both';
    state.theme = THEME_ORDER.includes(state.settings.theme) ? state.settings.theme : 'system';
  } catch (err) {
    document.body.innerHTML = `<div style="padding:60px;text-align:center;font-family:sans-serif;color:#e6e9f0">
      <h2>加载失败</h2><p style="color:#9aa4b8">${esc(err.message)}</p>
      <p style="color:#6b7488;font-size:13px">请确认服务是通过 <code>启动.command</code> 启动的，而不是直接双击 index.html</p></div>`;
    return;
  }

  if (!/PROMPT\s*:/.test(state.settings.vision_system_prompt || '')) {
    state.settings.vision_system_prompt = DEFAULT_SYS_PROMPT;
  }
  if (!/PROMPT\s*:/.test(state.settings.polish_system_prompt || '')) {
    state.settings.polish_system_prompt = DEFAULT_POLISH_PROMPT;
  }

  applyTheme();
  $('#langLabel').textContent = LANG_LABEL[state.lang] || state.lang;
  $('#langMenu').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.lang === state.lang);
  });

  bindEvents();
  buildIndex();
  ensureSlots();
  undo.last = snapshot();
  renderCategories();
  renderTags();
  renderChips();
  renderRecommendations();
  renderSlots();
  updateUndoButtons();
}

boot();
