/**
 * 无浏览器环境下的启动自测：
 * 用一个极简 DOM 桩真正执行 app.js 的 boot()，抓运行时错误，
 * 并断言分类 / 标签 / 分段 / 权重 / 停用区 等核心逻辑。
 *
 *   node tools/boot_test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
/** 读 JSON；文件不存在时返回兜底值（data/ 目录被清空后测试仍要能跑） */
const read = (p, fallback = {}) => {
  const full = path.join(ROOT, p);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (_) {
    return fallback;
  }
};

/* ------------------------------ DOM 桩 ---------------------------------- */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this.children = [];
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.files = [];
    this.attributes = {};
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  querySelector(sel) {
    if (sel === 'use') return new El('use');
    return null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  closest() { return null; }
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  focus() {}
  select() {}
  click() {}
  getBoundingClientRect() { return { left: 0, width: 100 }; }
}

const elements = new Map();
const getEl = (sel) => {
  if (!elements.has(sel)) elements.set(sel, new El('div'));
  return elements.get(sel);
};

const documentStub = {
  documentElement: new El('html'),
  body: new El('body'),
  querySelector: (sel) => (sel.startsWith('#') ? getEl(sel) : null),
  querySelectorAll: () => [],
  createElement: (tag) => new El(tag),
  addEventListener: () => {},
};

/* ------------------------------ fetch 桩 -------------------------------- */

let settingsData = Object.assign(
  {
    slots: [
      { prompt: '', negative: '' }, { prompt: '', negative: '' },
      { prompt: '', negative: '' }, { prompt: '', negative: '' },
    ],
  },
  read('data/settings.json'),
);
const stateData = () => ({
  settings: Object.assign({ parked: { pos: [], neg: [] } }, settingsData),
  presets: read('data/presets.json').presets || [],
  history: read('data/history.json').combos || [],
});
const tagsData = Object.assign(read('app/data/tags.json'), { source: 'builtin', canReset: false });
const tplData = read('app/data/templates.json');

const calls = [];
async function fetchStub(url, options = {}) {
  calls.push(`${options.method || 'GET'} ${url}`);
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (url === '/api/__fail_reasoning') {
    return {
      ok: false,
      status: 502,
      json: async () => ({
        error: '模型输出被 max_tokens 截断了，正文还没写完',
        reasoning: '思考了半天没写正文',
        finishReason: 'length',
      }),
    };
  }
  if (url === '/api/tags') return json(tagsData);
  if (url === '/data/templates.json') return json(tplData);
  if (url === '/api/state') return json(stateData());
  if (url === '/api/settings') {
    settingsData = Object.assign({}, settingsData, JSON.parse(options.body || '{}'));
    return json({ ok: true, settings: settingsData });
  }
  if (url === '/api/history') return json({ ok: true, count: 1 });
  if (url === '/api/translate') return json({ ok: true, content: 'translated text', model: 'test-model' });
  if (url === '/api/test-connection') {
    const body = JSON.parse(options.body || '{}');
    if (String(body.base_url || '').includes('bad')) {
      return { ok: false, status: 502, json: async () => ({
        error: 'API Key 无效或没有权限（HTTP 401）',
        detail: '{"error":{"message":"Incorrect API key provided"}}',
        url: 'https://api.openai.com/v1/models',
      }) };
    }
    return json({
      ok: true, method: 'models',
      url: String(body.base_url || '').replace(/\/+$/, '') + '/models',
      modelCount: 3, modelFound: body.model === 'deepseek-chat',
      sample: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
      message: '地址与 API Key 均可用',
    });
  }
  if (url === '/api/polish') {
    return json({
      ok: true,
      model: 'test-model',
      style: 'balanced',
      target: 'tags',
      reasoning: '先看看用户给的提示词……beautiful 和 gorgeous 重复了，应该删掉一个。',
      content: [
        'PROMPT: 1girl, silver hair, red eyes, forest, rim light, cinematic, masterpiece, 8k',
        'NEGATIVE: low quality, blurry, watermark',
        '说明: 补了 rim light 强化轮廓光；删掉了重复的 beautiful 与 gorgeous；统一为全小写。',
        'WEIGHTS: rim light:1.4, forest:0.8, masterpiece:1.2, nonexistent tag:1.5',
      ].join('\n'),
    });
  }
  return json({ ok: true });
}

/* ------------------------------ 沙箱 ------------------------------------ */

const clipboardLog = [];

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  document: documentStub,
  navigator: { clipboard: { writeText: async (text) => { clipboardLog.push(text); } } },
  fetch: fetchStub,
  URL: { createObjectURL: () => 'blob:', revokeObjectURL: () => {} },
  Blob: class {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  JSON, Math, Date, Object, Array, String, Number, RegExp, Promise, Error,
  Set, Map, Boolean, parseInt, parseFloat, isNaN,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// window.confirm 在沙箱里默认不存在；给个可控的桩，方便测「确认 / 取消」两条路径
let confirmAnswer = true;
let confirmCalls = [];
sandbox.confirm = (message) => {
  confirmCalls.push(String(message || ''));
  return confirmAnswer;
};

let source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
source += `
globalThis.__probe = { state, toggleTag, renderLibrary, openLibrary, setLanguage, cycleTheme,
  applyTheme, parseSegment, parseSegments, formatSegment, serializeSegments, hasWeight,
  removeChip, parkChip, unpark, moveItem, shuffleSide, normalizeSide, writeSide,
  predictByHistory, predictByInput, predictByGroup, renderRecommendations, renderChips,
  renderParked, openForm, findCat, slugify, catIcon, CAT_ICON_KEYS, THEME_META,
  undo, undoStep, redoStep, commitUndo, snapshot, updateUndoButtons,
  translateTextLocally, runLocalTranslate, lookupChinese, splitChinese,
  applyNegativeTemplate, openNegativeTemplates, generateInspiration, openInspiration,
  rollInspiration, poolForSlot, renderInspireThemes,
  ensureSlots, renderSlots, renderCompare, saveSlots, SLOT_KEYS, updateSlotBadge,
  exportProject, exportPromptText, openShortcuts, SHORTCUTS, handleShortcut, jumpCategory,
  openPolish, runPolish, parsePolishResult, renderPolishDiff, renderPolishNotes, applyPolishResult,
  setPolishStyle, setPolishTarget, grabBlock, tagDiff,
  parseWeights, renderPolishWeights, syncPolishWeights, setAllWeights, resetWeightValues,
  libMoveCategory, libMoveGroup, libMoveTag, clearLibDropMarks, clearLibDragState,
  showReasoning, fillSettingsForm, saveSettings, api,
  bindSidebarDrag, clearSideDropMarks, renderCategories, renderTags,
  download, nativeSaveFile, copyText,
  LLM_PROVIDERS, matchProvider, applyProvider, testConnection,
  renderProviderOptions, updateProviderNote,
  splitNoParam, stripTrailingBlocks, mergeNoParam, updateMergeNoButton, isNoneWord,
  slotFilled, slotSummary, slotBody, saveToSlot, syncSlotOption,
  PROVIDER_MODELS, updateModelOptions, openModelMenu, closeModelMenu, toggleModelMenu, pickModel,
  translateEnToZh, translateSide, HAS_CJK,
  formatPromptText, copyPrefixFlags, copyPositive, copyNegative, copyBoth,
  updateCopyPreview, COPY_MODE_OPTIONS, DEFAULT_COPY_POS_PREFIX, DEFAULT_COPY_NEG_PREFIX,
  getPolishState: () => ({ style: polishStyle, target: polishTarget }),
  POLISH_STYLE_DESC, POLISH_TARGET_DESC };
`;
vm.createContext(sandbox);

let failed = false;
const check = (label, condition, extra = '') => {
  if (!condition) failed = true;
  console.log(`  ${condition ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
};

const promptValue = () => getEl('#promptText').value;
const negValue = () => getEl('#negText').value;

(async () => {
  try {
    vm.runInContext(source, sandbox, { filename: 'app.js' });
    await new Promise((r) => setTimeout(r, 60));
  } catch (err) {
    console.log('✗ app.js 执行抛错：\n', err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : err);
    process.exit(1);
  }

  const p = sandbox.__probe;
  const st = p.state;

  console.log('\n[1] 启动加载');
  check('分类加载', st.categories.length === 18, `实际 ${st.categories.length}`);
  check('标签索引构建', st.tagIndex.length === 2134, `实际 ${st.tagIndex.length}`);
  check('主题默认 = 跟随系统', st.theme === 'system', st.theme);
  check('语言默认 = 中英对照', st.lang === 'both', st.lang);
  check('html data-theme 已应用', !!documentStub.documentElement.dataset.theme,
    documentStub.documentElement.dataset.theme);
  check('分类导航已渲染', getEl('#catList').innerHTML.includes('场景'));
  check('导航图标为 SVG 而非 emoji',
    getEl('#catList').innerHTML.includes('i-cat-scene')
    && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(getEl('#catList').innerHTML));
  check('标签区已渲染', getEl('#tagScroll').innerHTML.includes('森林'));
  check('分类计数文案', getEl('#catCount').textContent.includes('2134'), getEl('#catCount').textContent);

  console.log('\n[2] 分类图标');
  check('icon 键 → SVG', p.catIcon({ icon: 'camera' }).includes('#i-cat-camera'));
  check('未知 icon → 字符兜底', p.catIcon({ icon: '★' }).includes('cat-char'));
  check('有 27 个可选图标', p.CAT_ICON_KEYS.length === 27, String(p.CAT_ICON_KEYS.length));
  check('每个分类 icon 都是合法键',
    st.categories.every((c) => p.CAT_ICON_KEYS.includes(c.icon)),
    st.categories.filter((c) => !p.CAT_ICON_KEYS.includes(c.icon)).map((c) => c.id).join(',') || '全部合法');

  console.log('\n[3] 主题循环');
  p.cycleTheme();
  check('system → light', st.theme === 'light');
  p.cycleTheme();
  check('light → dark', st.theme === 'dark');
  p.cycleTheme();
  check('dark → system', st.theme === 'system');

  console.log('\n[4] 语言切换');
  p.setLanguage('en');
  check('切到 English', st.lang === 'en' && getEl('#langLabel').textContent === 'English');
  p.setLanguage('zh');
  check('切到中文', st.lang === 'zh');
  p.setLanguage('both');

  console.log('\n[5] 权重语法解析');
  check('裸词无权重', p.parseSegment('masterpiece').weight === null);
  check('(a) → 1.1', p.parseSegment('(masterpiece)').weight === 1.1);
  check('((a)) → 1.21', p.parseSegment('((masterpiece))').weight === 1.21);
  check('[a] → 0.9', p.parseSegment('[masterpiece]').weight === 0.9);
  check('(a:1.4) → 1.4', p.parseSegment('(masterpiece:1.4)').weight === 1.4);
  check('(a:0.6) → 0.6', p.parseSegment('(masterpiece:0.6)').weight === 0.6);
  check('权重上限 3', p.parseSegment('(a:9)').weight === 3);
  check('权重下限 0.1', p.parseSegment('(a:0.001)').weight === 0.1);

  console.log('\n[6] 序列化往返');
  const rt = '1girl, (long hair:1.30), forest, (masterpiece:0.80)';
  const rtOut = '1girl, (long hair:1.3), forest, (masterpiece:0.8)';
  const segs = p.parseSegments(rt);
  check('解析出 4 段', segs.length === 4, String(segs.length));
  check('往返一致（权重末尾零会被去掉）', p.serializeSegments(segs) === rtOut, p.serializeSegments(segs));
  check('再次解析稳定', p.serializeSegments(p.parseSegments(rtOut)) === rtOut);
  check('中文逗号也能切分', p.parseSegments('a，b，c').length === 3);
  check('权重 1 不写括号', p.formatSegment({ base: 'x', weight: 1 }) === 'x');
  check('hasWeight 判定', p.hasWeight({ base: 'x', weight: 1.2 }) && !p.hasWeight({ base: 'x', weight: 1 }));

  console.log('\n[7] 标签点击增删');
  getEl('#promptText').value = '1girl';
  p.toggleTag('masterpiece', false);
  check('追加标签', promptValue() === '1girl, masterpiece', promptValue());
  p.toggleTag('1girl', false);
  check('移除标签', promptValue() === 'masterpiece', promptValue());
  getEl('#negText').value = 'low quality';
  p.toggleTag('blurry', true);
  check('负面框独立', negValue() === 'low quality, blurry', negValue());
  getEl('#negText').value = '';

  console.log('\n[8] 排序 / 打乱 / 清权重');
  getEl('#promptText').value = 'a, b, c, d';
  p.moveItem('pos', 0, 4);
  check('拖到末尾', promptValue() === 'b, c, d, a', promptValue());
  p.moveItem('pos', 3, 0);
  check('拖到开头', promptValue() === 'a, b, c, d', promptValue());

  getEl('#promptText').value = 'a, (b:1.5), c';
  p.normalizeSide('pos');
  check('清除权重', promptValue() === 'a, b, c', promptValue());

  getEl('#promptText').value = 'a, b, c, d, e, f, g, h';
  const before = p.parseSegments(promptValue()).map((x) => x.base).sort().join('|');
  p.shuffleSide('pos');
  const after = p.parseSegments(promptValue()).map((x) => x.base).sort().join('|');
  check('打乱后元素集合不变', before === after);
  check('打乱后长度不变', p.parseSegments(promptValue()).length === 8);

  console.log('\n[9] 启用 / 停用');
  getEl('#promptText').value = '1girl, masterpiece, (forest:1.3)';
  p.parkChip('pos', 1);
  check('停用后从提示词移除', promptValue() === '1girl, (forest:1.3)', promptValue());
  check('进入停用区', st.parked.pos.length === 1 && st.parked.pos[0] === 'masterpiece');
  check('停用区已渲染', getEl('#parkedPosChips').innerHTML.includes('masterpiece'));
  check('停用区可见', getEl('#parkedPos').hidden === false);
  p.unpark('pos', 0);
  check('恢复回提示词末尾', promptValue() === '1girl, (forest:1.3), masterpiece', promptValue());
  check('停用区清空后隐藏', st.parked.pos.length === 0 && getEl('#parkedPos').hidden === true);

  p.removeChip('pos', 0);
  check('移除芯片', promptValue() === '(forest:1.3), masterpiece', promptValue());

  console.log('\n[10] 权重编辑');
  check('权重芯片渲染 ×1.3', getEl('#chipsPos').innerHTML.includes('×1.3'));
  p.writeSide('pos', [{ base: 'forest', weight: 1.5 }]);
  check('写回带权重语法', promptValue() === '(forest:1.5)', promptValue());
  check('未收录标签带 unknown 样式',
    (getEl('#chipsPos').innerHTML.includes('unknown') === false)
    === Boolean(st.tagIndex.find((t) => t.en === 'forest')));

  console.log('\n[11] 智能推荐');
  getEl('#promptText').value = '1girl, long hair, forest, cinematic, masterpiece';
  p.renderRecommendations();
  check('推荐区有内容', getEl('#recList').innerHTML.length > 100);
  check('同类推荐命中', getEl('#recList').innerHTML.includes('同属'));
  check('来源标签识别正确',
    p.predictByGroup().items.length > 0
    && p.predictByGroup().reason.includes('杰作'),
    p.predictByGroup().reason);

  console.log('\n[12] 标签管理');
  st.libActiveCat = 'scene';
  p.renderLibrary();
  check('分类列表已渲染', getEl('#libCatList').innerHTML.includes('场景'));
  check('管理页图标为 SVG', getEl('#libCatList').innerHTML.includes('i-cat-scene'));
  check('详情区渲染出标签', getEl('#libDetail').innerHTML.includes('lib-tag'));
  p.openLibrary();
  check('打开管理弹窗', getEl('#modalLibrary').hidden === false);

  console.log('\n[13] 表单');
  const formPromise = p.openForm({
    title: '测试',
    fields: [
      { key: 'name', label: '名字', value: 'abc' },
      { key: 'icon', label: '图标', type: 'icon', value: 'camera' },
      { key: 'weight', label: '权重', type: 'number', value: '1.2' },
    ],
    validate: (v) => (v.name ? null : '必填'),
  });
  check('表单弹窗已打开', getEl('#modalForm').hidden === false);
  check('文本框已渲染', getEl('#formBody').innerHTML.includes('data-key="name"'));
  check('图标选择器已渲染', getEl('#formBody').innerHTML.includes('icon-picker'));
  check('图标选中态正确', getEl('#formBody').innerHTML.includes('class="icon-opt is-active" data-value="camera"'));
  check('数字框已渲染', getEl('#formBody').innerHTML.includes('type="number" data-key="weight"'));
  void formPromise;

  console.log('\n[14] 工具函数');
  check('slugify 英文', p.slugify('My Group') === 'my-group');
  check('slugify 中文回退', p.slugify('金属材质') === '');
  check('findCat 命中', !!p.findCat('character'));

  console.log('\n[15] 撤销 / 重做');
  getEl('#promptText').value = '';
  getEl('#negText').value = '';
  p.undo.stack = []; p.undo.redo = []; p.undo.last = p.snapshot();
  getEl('#promptText').value = 'a';
  p.commitUndo();
  getEl('#promptText').value = 'a, b';
  p.commitUndo();
  check('栈深度 2', p.undo.stack.length === 2, String(p.undo.stack.length));
  p.undoStep();
  check('撤销一次 → a', promptValue() === 'a', promptValue());
  p.undoStep();
  check('撤销两次 → 空', promptValue() === '', JSON.stringify(promptValue()));
  p.undoStep();
  check('到底后不报错', promptValue() === '');
  check('重做栈有 2 步', p.undo.redo.length === 2, String(p.undo.redo.length));
  p.redoStep();
  check('重做 → a', promptValue() === 'a', promptValue());
  p.redoStep();
  check('重做 → a, b', promptValue() === 'a, b', promptValue());
  getEl('#promptText').value = 'a, b, c';
  p.commitUndo();
  check('新操作清空重做栈', p.undo.redo.length === 0);

  console.log('\n[16] 本地词库中 → 英');
  const lc = p.translateTextLocally('森林, 杰作, 1girl, (长发:1.2)');
  check('中文标签被替换', lc.text === 'forest, masterpiece, 1girl, (long hair:1.2)', lc.text);
  check('命中计数', lc.hit === 3, String(lc.hit));
  const split = p.splitChinese('红眼睛少女');
  check('长中文串能拆成多个标签', split.length >= 2, split.map((t) => t.en).join(' + '));
  check('拆分结果含 red eyes', split.some((t) => t.en === 'red eyes'));
  check('纯英文原样返回', p.translateTextLocally('1girl, forest').text === '1girl, forest');
  check('查不到的中文保留原样', p.translateTextLocally('这是一个不存在的词').text === '这是一个不存在的词');
  getEl('#promptText').value = '森林, 杰作';
  p.runLocalTranslate();
  check('一键翻译改写提示词', promptValue() === 'forest, masterpiece', promptValue());

  console.log('\n[17] 负面词模板');
  check('模板已加载 8 套', (st.templates.negativeTemplates || []).length === 8,
    String((st.templates.negativeTemplates || []).length));
  p.openNegativeTemplates();
  check('模板列表已渲染', getEl('#negTplList').innerHTML.includes('tpl-card'));
  check('含「通用去瑕疵」', getEl('#negTplList').innerHTML.includes('通用去瑕疵'));
  getEl('#negText').value = 'blurry';
  p.applyNegativeTemplate('minimal', true);
  const negItems = p.parseSegments(negValue());
  const minimalTpl = st.templates.negativeTemplates.find((t) => t.id === 'minimal');
  const minimalSet = new Set(minimalTpl.tags.map((t) => t.toLowerCase()));
  check('替换模式套用 12 个模板词', negItems.length === 12, String(negItems.length));
  check('替换结果只含模板内的词', negItems.every((i) => minimalSet.has(i.base.toLowerCase())),
    negItems.map((i) => i.base).filter((b) => !minimalSet.has(b.toLowerCase())).join(',') || '全部合法');
  p.applyNegativeTemplate('minimal', false);
  check('追加模式自动去重', p.parseSegments(negValue()).length === 12,
    String(p.parseSegments(negValue()).length));
  getEl('#negText').value = '';

  console.log('\n[18] 随机灵感');
  check('主题已加载 6 套', (st.templates.inspiration.themes || []).length === 6);
  check('slot 池非空', p.poolForSlot({ categories: ['character'], groups: ['character.basic'] }).length > 0);
  p.openInspiration();
  check('生成 3 个候选', st.inspireCandidates.length === 3, String(st.inspireCandidates.length));
  check('候选都有标签', st.inspireCandidates.every((c) => c.tags.length >= 8),
    st.inspireCandidates.map((c) => c.tags.length).join('/'));
  check('候选提示词非空', st.inspireCandidates.every((c) => c.prompt.length > 20));
  check('候选彼此不同', new Set(st.inspireCandidates.map((c) => c.prompt)).size > 1);
  check('灵感列表已渲染', getEl('#inspireList').innerHTML.includes('inspire-card'));
  check('主题按钮已渲染', getEl('#inspireThemes').innerHTML.includes('inspire-theme'));
  const before18 = st.inspireCandidates[0].prompt;
  p.rollInspiration();
  check('换一批后仍是 3 个', st.inspireCandidates.length === 3,
    st.inspireCandidates[0].prompt === before18 ? '（恰好重复，可接受）' : '已刷新');

  console.log('\n[19] 方案槽位 & 对比');
  st.slots = [{ prompt: 'a, b' }];
  p.ensureSlots();
  check('补齐到 4 个槽位', st.slots.length === 4, String(st.slots.length));
  check('保留已有内容', st.slots[0].prompt === 'a, b');
  check('缺失字段补空串', st.slots[1].prompt === '' && st.slots[0].negative === '');
  st.slots[1] = { prompt: 'b, c', negative: 'low quality' };
  p.renderSlots();
  check('槽位卡片已渲染', getEl('#slotList').innerHTML.includes('slot-card'));
  check('槽位键 A-D', p.SLOT_KEYS.join('') === 'ABCD');
  getEl('#promptText').value = 'a, b, e';
  st.compareOpen = true;
  p.renderCompare();
  check('对比区可见', getEl('#slotCompare').hidden === false);
  check('渲染出 3 列（A/B/当前）', (getEl('#slotCompare').innerHTML.match(/compare-col"/g) || []).length === 3,
    String((getEl('#slotCompare').innerHTML.match(/compare-col"/g) || []).length));
  check('共有标签标绿', getEl('#slotCompare').innerHTML.includes('in-all'));
  check('独有标签标黄', getEl('#slotCompare').innerHTML.includes('unique'));
  st.compareOpen = false;
  p.renderCompare();
  check('关闭后隐藏', getEl('#slotCompare').hidden === true);

  console.log('\n[20] 工程导出');
  await p.exportPromptText();
  check('TXT 导出提示了结果', getEl('#projectHint').textContent.includes('TXT'),
    getEl('#projectHint').textContent);
  await p.exportProject();
  check('工程导出提示了结果', getEl('#projectHint').textContent.includes('工程'),
    getEl('#projectHint').textContent);

  console.log('\n[20b] 原生窗口：保存对话框桥');
  const bridgeCalls = [];
  const useNative = (result) => {
    sandbox.__NATIVE_APP__ = true;
    sandbox.window.__NATIVE_APP__ = true;
    sandbox.window.webkit = {
      messageHandlers: {
        saveFile: {
          postMessage: (payload) => {
            bridgeCalls.push(payload);
            setTimeout(() => {
              if (sandbox.window.__nativeSaveResult) {
                sandbox.window.__nativeSaveResult(result[0], result[1]);
              }
            }, 0);
          },
        },
      },
    };
  };
  const useBrowser = () => {
    sandbox.window.__NATIVE_APP__ = false;
    delete sandbox.window.webkit;
  };

  useNative([true, '/Users/me/Desktop/prompt-studio.json']);
  await p.download('prompt-studio.json', '{"a":1}');
  check('原生模式走系统保存对话框', bridgeCalls.length === 1, `调用 ${bridgeCalls.length} 次`);
  check('传给原生的文件名正确', bridgeCalls[0] && bridgeCalls[0].filename === 'prompt-studio.json',
    bridgeCalls[0] && bridgeCalls[0].filename);
  check('传给原生的内容正确', bridgeCalls[0] && bridgeCalls[0].content === '{"a":1}');
  check('保存成功后面板提示', getEl('#projectHint').textContent.includes('工程'),
    getEl('#projectHint').textContent);

  bridgeCalls.length = 0;
  useNative([false, 'cancelled']);
  await p.exportProject();
  check('用户取消时也走桥', bridgeCalls.length === 1);
  check('取消后仍有结果提示', getEl('#projectHint').textContent.includes('工程'));

  bridgeCalls.length = 0;
  useBrowser();
  await p.download('x.json', '{}');
  check('浏览器模式不调用原生桥', bridgeCalls.length === 0);
  check('浏览器模式走 Blob 下载', true);

  await p.download('y.json', '{}');
  check('空内容不会误触发原生桥（已切回浏览器）', bridgeCalls.length === 0);

  console.log('\n[21] 快捷键');
  check('快捷键表不少于 10 条', p.SHORTCUTS.length >= 10, String(p.SHORTCUTS.length));
  p.openShortcuts();
  check('快捷键弹窗已渲染', getEl('#kbdList').innerHTML.includes('<kbd>'));
  check('含撤销条目', getEl('#kbdList').innerHTML.includes('撤销'));

  const mkEvent = (over) => Object.assign({
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    key: '', target: { tagName: 'BODY' }, preventDefault() {},
  }, over);

  getEl('#promptText').value = 'x, y';
  p.undo.stack = []; p.undo.redo = []; p.undo.last = p.snapshot();
  getEl('#promptText').value = 'x, y, z';
  p.commitUndo();
  p.handleShortcut(mkEvent({ ctrlKey: true, key: 'z' }));
  check('Ctrl+Z 撤销', promptValue() === 'x, y', promptValue());
  p.handleShortcut(mkEvent({ ctrlKey: true, shiftKey: true, key: 'z' }));
  check('Ctrl+Shift+Z 重做', promptValue() === 'x, y, z', promptValue());

  st.activeCat = null;
  p.handleShortcut(mkEvent({ altKey: true, key: 'ArrowDown' }));
  check('Alt+↓ 切到第一个分类', st.activeCat === st.categories[0].id, String(st.activeCat));
  p.handleShortcut(mkEvent({ altKey: true, key: '3' }));
  check('Alt+3 跳到第三个分类', st.activeCat === st.categories[2].id, String(st.activeCat));
  p.handleShortcut(mkEvent({ altKey: true, key: '1' }));
  check('Alt+1 跳到第一个分类', st.activeCat === st.categories[0].id, String(st.activeCat));
  p.handleShortcut(mkEvent({ altKey: true, key: '0' }));
  check('Alt+0 回到全部标签', st.activeCat === null, String(st.activeCat));

  console.log('\n[22] 模板数据完整性');
  check('templates.version', st.templates.version === 1);
  const negPool = new Set(st.tagIndex.filter((t) => t.negative).map((t) => t.en.toLowerCase()));
  const badTplTag = [];
  st.templates.negativeTemplates.forEach((tpl) => {
    (tpl.tags || []).forEach((tag) => { if (!negPool.has(tag.toLowerCase())) badTplTag.push(tag); });
  });
  check('模板里的负面词全部存在于词库', badTplTag.length === 0, badTplTag.slice(0, 3).join(','));
  const badRef = [];
  st.templates.inspiration.themes.forEach((theme) => {
    (theme.slots || []).forEach((slot) => {
      if (!p.poolForSlot(slot).length) badRef.push(`${theme.id}/${slot.name}`);
    });
  });
  check('每个 slot 都能抽到标签', badRef.length === 0, badRef.join(','));

  console.log('\n[23] AI 提示词润色');
  check('默认方式 balanced', p.getPolishState().style === 'balanced');
  check('默认目标 tags', p.getPolishState().target === 'tags');

  getEl('#promptText').value = '1girl, beautiful, gorgeous, silver hair, red eyes, forest';
  getEl('#negText').value = 'low quality, blurry';
  p.openPolish();
  check('润色弹窗已打开', getEl('#modalPolish').hidden === false);
  check('自动带入当前提示词', getEl('#polishSource').value.includes('silver hair'));
  check('自动带入负面提示词', getEl('#polishSourceNeg').value === 'low quality, blurry');
  check('说明区已渲染', getEl('#polishDesc').innerHTML.includes('保持原意'));
  check('应用按钮初始禁用', getEl('#btnPolishApply').disabled === true);

  p.setPolishStyle('simplify');
  check('切换润色方式', p.getPolishState().style === 'simplify');
  check('说明区跟随更新', getEl('#polishDesc').innerHTML.includes('20–35'));
  p.setPolishTarget('midjourney');
  check('切换输出目标', p.getPolishState().target === 'midjourney');
  check('目标说明更新', getEl('#polishDesc').innerHTML.includes('--ar'));
  p.setPolishStyle('balanced');
  p.setPolishTarget('tags');

  await p.runPolish();
  check('结果已填入', getEl('#polishResult').value.startsWith('1girl, silver hair, red eyes'),
    getEl('#polishResult').value);
  check('负面结果已填入', getEl('#polishResultNeg').value === 'low quality, blurry, watermark');
  check('应用按钮已启用', getEl('#btnPolishApply').disabled === false);
  check('状态提示成功', getEl('#polishStatus').className === 'status ok');

  check('变化区已显示', getEl('#polishDiff').hidden === false);
  check('识别出新增标签', getEl('#polishDiff').innerHTML.includes('diff-tag add'));
  check('识别出移除标签', getEl('#polishDiff').innerHTML.includes('diff-tag del'));
  check('移除了 beautiful', getEl('#polishDiff').innerHTML.includes('>beautiful<'));
  check('新增了 rim light', getEl('#polishDiff').innerHTML.includes('>rim light<'));
  check('模型说明已渲染', getEl('#polishNotes').innerHTML.includes('轮廓光'));

  const pd = p.parsePolishResult('**PROMPT**: a, b\n- NEGATIVE: c\n说明: 一条；两条。');
  check('解析容忍 Markdown 装饰', pd.prompt === 'a, b' && pd.negative === 'c', `${pd.prompt} | ${pd.negative}`);
  check('解析出说明', pd.notes.includes('一条'));

  const diff = p.tagDiff(
    p.parseSegments('a, b, c'),
    p.parseSegments('b, c, d'),
  );
  check('tagDiff 新增', diff.added.join() === 'd');
  check('tagDiff 移除', diff.removed.join() === 'a');
  check('tagDiff 保留计数', diff.kept === 2, String(diff.kept));

  p.applyPolishResult(false);
  check('应用到工作区', promptValue().startsWith('1girl, silver hair, red eyes'), promptValue());
  check('负面一并应用', negValue() === 'low quality, blurry, watermark');
  check('弹窗已关闭', getEl('#modalPolish').hidden === true);

  getEl('#promptText').value = 'x, y';
  getEl('#negText').value = 'z';
  getEl('#polishResult').value = 'x, y2';
  getEl('#polishResultNeg').value = '';
  getEl('#promptText').value = 'x, y';
  p.applyPolishResult(true);
  check('只应用负面时不动正向', promptValue() === 'x, y', promptValue());

  console.log('\n[24] 权重建议');
  const w1 = p.parseWeights('rim light:1.4, forest:0.8, masterpiece:1.2');
  check('解析出 3 条权重', w1.length === 3, String(w1.length));
  check('权重值正确', w1[0].tag === 'rim light' && w1[0].weight === 1.4, `${w1[0].tag}=${w1[0].weight}`);
  check('默认勾选', w1.every((i) => i.checked === true));
  check('「无」返回空', p.parseWeights('无').length === 0);
  check('空串返回空', p.parseWeights('').length === 0);
  check('权重上下限钳制', p.parseWeights('a:9, b:0.01').map((i) => i.weight).join() === '3,0.1');
  check('容错中文冒号与换行', p.parseWeights('a：1.2\nb:0.9').length === 2);
  check('容错多余括号与反引号', p.parseWeights('(a:1.2), `b`:0.9').length === 2);
  check('忽略无法解析的片段', p.parseWeights('乱七八糟, a:1.2').length === 1);

  p.openPolish();
  getEl('#promptText').value = '1girl, forest, rim light, cinematic, masterpiece, 8k';
  getEl('#polishSource').value = '1girl, forest, rim light';
  getEl('#polishSourceNeg').value = '';
  await p.runPolish();
  const wr = getEl('#polishResult').value;
  check('权重已写进润色结果', wr.includes('(rim light:1.4)') && wr.includes('(forest:0.8)') && wr.includes('(masterpiece:1.2)'), wr);
  check('面板已显示', getEl('#polishWeights').hidden === false);
  check('权重行已渲染', (getEl('#polishWeightList').innerHTML.match(/weight-row/g) || []).length === 4,
    String((getEl('#polishWeightList').innerHTML.match(/weight-row/g) || []).length));
  check('未收录关键词被标记 missing', st.polishWeightItems.filter((i) => i.missing).length === 1,
    String(st.polishWeightItems.filter((i) => i.missing).length));
  check('missing 行带 is-missing 样式', getEl('#polishWeightList').innerHTML.includes('is-missing'));
  check('计数文案', getEl('#polishWeightCount').textContent === '3 / 3 已选',
    getEl('#polishWeightCount').textContent);
  check('up/down 配色提示', getEl('#polishWeightList').innerHTML.includes('w-input up')
    && getEl('#polishWeightList').innerHTML.includes('w-input down'));

  p.setAllWeights(false);
  const wr0 = getEl('#polishResult').value;
  check('全不选后权重被移除', !wr0.includes(':1.4') && !wr0.includes(':0.8'), wr0);
  check('全不选后仍保留标签', wr0.includes('rim light') && wr0.includes('forest'));

  p.setAllWeights(true);
  check('全选后权重恢复', getEl('#polishResult').value.includes('(rim light:1.4)'));

  st.polishWeightItems[0].weight = 2;
  p.syncPolishWeights();
  check('手动改值生效', getEl('#polishResult').value.includes('(rim light:2)'),
    getEl('#polishResult').value);
  p.resetWeightValues();
  check('恢复建议值', getEl('#polishResult').value.includes('(rim light:1.4)'),
    getEl('#polishResult').value);

  p.applyPolishResult(false);
  check('带权重应用到工作区', promptValue().includes('(rim light:1.4)'), promptValue());

  console.log('\n[25] 标签管理：拖拽归类');
  const catOrderBefore = st.categories.map((c) => c.id).join(',');

  p.libMoveCategory('character', 0);
  check('分类拖到最前', st.categories[0].id === 'character', st.categories[0].id);
  p.libMoveCategory('character', st.categories.length);
  check('分类拖到最后', st.categories[st.categories.length - 1].id === 'character',
    st.categories[st.categories.length - 1].id);
  // 还原
  st.categories.sort((a, b) => catOrderBefore.split(',').indexOf(a.id) - catOrderBefore.split(',').indexOf(b.id));
  check('分类顺序已还原', st.categories.map((c) => c.id).join(',') === catOrderBefore);

  const colorGroupsBefore = st.categories.find((c) => c.id === 'color').groups.length;
  const sceneGroupsBefore = st.categories.find((c) => c.id === 'scene').groups.length;
  const natureGroup = st.categories.find((c) => c.id === 'scene').groups.find((g) => g.id === 'scene.nature');
  const natureCount = natureGroup.tags.length;

  p.libMoveGroup('scene', 'scene.nature', 'color', 1e9);
  const colorCat = st.categories.find((c) => c.id === 'color');
  const movedGroup = colorCat.groups[colorCat.groups.length - 1];
  check('分组已搬到 color 末尾', colorCat.groups.length === colorGroupsBefore + 1,
    String(colorCat.groups.length));
  check('分组 id 前缀已重写', movedGroup.id.startsWith('color.'), movedGroup.id);
  check('分组内容完整保留', movedGroup.tags.length === natureCount, String(movedGroup.tags.length));
  check('原分类少了这个分组', st.categories.find((c) => c.id === 'scene').groups.length === sceneGroupsBefore - 1);

  // 还原：搬回 scene
  p.libMoveGroup('color', movedGroup.id, 'scene', 0);
  const sceneCat = st.categories.find((c) => c.id === 'scene');
  check('分组已搬回 scene 开头', sceneCat.groups[0].tags.length === natureCount);
  check('scene 分组数恢复', sceneCat.groups.length === sceneGroupsBefore, String(sceneCat.groups.length));
  check('color 分组数恢复', st.categories.find((c) => c.id === 'color').groups.length === colorGroupsBefore);

  // 标签：跨分类搬运
  const forestBefore = st.categories.find((c) => c.id === 'scene').groups
    .find((g) => g.id === 'scene.nature').tags.find((t) => t.en === 'forest');
  check('搬运前 forest 在 scene.nature', !!forestBefore);

  const ok = p.libMoveTag('scene', 'scene.nature', 'forest', 'color', 'color.palette', 1e9);
  check('libMoveTag 返回成功', ok === true);
  const palette = st.categories.find((c) => c.id === 'color').groups.find((g) => g.id === 'color.palette');
  check('标签已落到 color.palette 末尾', palette.tags[palette.tags.length - 1].en === 'forest',
    palette.tags[palette.tags.length - 1].en);
  check('标签中文名一并搬走', palette.tags[palette.tags.length - 1].zh === '森林');
  check('原分组里已移除',
    !st.categories.find((c) => c.id === 'scene').groups.find((g) => g.id === 'scene.nature')
      .tags.some((t) => t.en === 'forest'));

  // 同组内排序
  const paletteTagCount = palette.tags.length;
  p.libMoveTag('color', 'color.palette', 'forest', 'color', 'color.palette', 0);
  check('同组内拖到开头', palette.tags[0].en === 'forest', palette.tags[0].en);
  check('同组内移动不改变总数', palette.tags.length === paletteTagCount);

  // 重复词保护：目标分组里塞一个同名标签，应该被拦住
  const guardTarget = st.categories.find((c) => c.id === 'color').groups.find((g) => g.id === 'color.palette');
  p.libMoveTag('color', 'color.palette', 'forest', 'scene', 'scene.nature', 1e9);
  check('forest 已归位（准备重复词测试）',
    !!st.categories.find((c) => c.id === 'scene').groups.find((g) => g.id === 'scene.nature')
      .tags.find((t) => t.en === 'forest'));

  guardTarget.tags.push({ zh: '临时森林', en: 'forest' });
  const blocked = p.libMoveTag('scene', 'scene.nature', 'forest', 'color', 'color.palette', 1e9);
  check('同名标签不会重复搬入', blocked === false, String(blocked));
  check('被拦住后原位置未受影响',
    !!st.categories.find((c) => c.id === 'scene').groups.find((g) => g.id === 'scene.nature')
      .tags.find((t) => t.en === 'forest'));
  guardTarget.tags.pop();

  p.renderLibrary();
  check('管理页渲染 drag 属性', getEl('#libDetail').innerHTML.includes('data-drag="group"')
    && getEl('#libDetail').innerHTML.includes('data-drag="tag"'));
  check('分类行可拖动', getEl('#libCatList').innerHTML.includes('data-drag="cat"'));
  check('拖拽提示已显示', getEl('#libDetail').innerHTML.includes('lib-drag-hint'));

  console.log('\n[26] 推理模型兼容');
  check('思考过程面板已显示', getEl('#polishReasoning').hidden === false);
  check('思考内容已填入', getEl('#polishReasoningBody').textContent.includes('beautiful'),
    getEl('#polishReasoningBody').textContent.slice(0, 40));
  check('成功时默认收起', getEl('#polishReasoning').classList.contains('is-open') === false);

  p.showReasoning('polishReasoning', '模型正在想……', true);
  check('可强制展开', getEl('#polishReasoning').classList.contains('is-open') === true);
  check('展开后内容更新', getEl('#polishReasoningBody').textContent === '模型正在想……');

  p.showReasoning('polishReasoning', '', false);
  check('清空后整块隐藏', getEl('#polishReasoning').hidden === true);
  check('清空后内容置空', getEl('#polishReasoningBody').textContent === '');

  p.showReasoning('visionReasoning', '', false);
  check('vision 面板清空后隐藏', getEl('#visionReasoning').hidden === true);
  p.showReasoning('visionReasoning', '看图……', true);
  check('vision 面板可用', getEl('#visionReasoningBody').textContent === '看图……');
  check('vision 面板可展开', getEl('#visionReasoning').classList.contains('is-open') === true);
  check('vision 面板展开后可见', getEl('#visionReasoning').hidden === false);
  p.showReasoning('visionReasoning', '', false);

  check('设置里有 max_tokens 字段', getEl('#setMaxTokens') !== undefined);
  p.fillSettingsForm();
  check('max_tokens 回填有效', Number(getEl('#setMaxTokens').value) > 0,
    getEl('#setMaxTokens').value);

  // 错误响应里的 reasoning 要能传到前端
  let caught = null;
  try {
    await p.api('/api/__fail_reasoning');
  } catch (err) {
    caught = err;
  }
  check('错误对象带 reasoning', !!caught && caught.reasoning === '思考了半天没写正文',
    caught ? String(caught.reasoning) : 'null');
  check('错误对象带 finishReason', !!caught && caught.finishReason === 'length');
  check('错误文案可读', !!caught && caught.message.includes('截断'), caught ? caught.message : '');

  console.log('\n[27] 复制全部 + 前缀格式');
  const mk = (mode, pos = 'Positive prompt: ', neg = 'Negative prompt: ') => ({
    copy_prefix_mode: mode, copy_positive_prefix: pos, copy_negative_prefix: neg,
  });
  const P = '1girl, forest';
  const N = 'low quality';

  check('mode=none 纯提示词', p.formatPromptText(P, N, mk('none')) === '1girl, forest\n\nlow quality',
    JSON.stringify(p.formatPromptText(P, N, mk('none'))));
  check('mode=negative 只负面前缀',
    p.formatPromptText(P, N, mk('negative')) === '1girl, forest\n\nNegative prompt: low quality',
    JSON.stringify(p.formatPromptText(P, N, mk('negative'))));
  check('mode=both 两边都有',
    p.formatPromptText(P, N, mk('both')) === 'Positive prompt: 1girl, forest\n\nNegative prompt: low quality',
    JSON.stringify(p.formatPromptText(P, N, mk('both'))));

  check('前缀文字可自定义',
    p.formatPromptText(P, N, mk('both', 'PROMPT>> ', 'NO>> ')) === 'PROMPT>> 1girl, forest\n\nNO>> low quality',
    JSON.stringify(p.formatPromptText(P, N, mk('both', 'PROMPT>> ', 'NO>> '))));
  check('只给正向时不出负面块',
    p.formatPromptText(P, '', mk('both')) === 'Positive prompt: 1girl, forest');
  check('只给负面时不出正向块',
    p.formatPromptText('', N, mk('both')) === 'Negative prompt: low quality');
  check('两边都空时返回空串', p.formatPromptText('', '', mk('both')) === '');
  check('空白会被 trim', p.formatPromptText('  a  ', '  b  ', mk('none')) === 'a\n\nb');

  check('copyPrefixFlags(none)', JSON.stringify(p.copyPrefixFlags(mk('none'))) === '{"pos":false,"neg":false}');
  check('copyPrefixFlags(negative)', JSON.stringify(p.copyPrefixFlags(mk('negative'))) === '{"pos":false,"neg":true}');
  check('copyPrefixFlags(both)', JSON.stringify(p.copyPrefixFlags(mk('both'))) === '{"pos":true,"neg":true}');

  check('三种模式选项齐全', p.COPY_MODE_OPTIONS.map((o) => o.value).join() === 'none,negative,both');

  // 走真实的按钮逻辑
  getEl('#promptText').value = '1girl, forest';
  getEl('#negText').value = 'low quality';

  st.settings.copy_prefix_mode = 'both';
  st.settings.copy_positive_prefix = 'Positive prompt: ';
  st.settings.copy_negative_prefix = 'Negative prompt: ';

  clipboardLog.length = 0;
  await p.copyBoth();
  check('复制全部写入剪贴板',
    clipboardLog[0] === 'Positive prompt: 1girl, forest\n\nNegative prompt: low quality',
    JSON.stringify(clipboardLog[0]));

  clipboardLog.length = 0;
  await p.copyPositive();
  check('单独复制正向', clipboardLog[0] === 'Positive prompt: 1girl, forest', JSON.stringify(clipboardLog[0]));

  clipboardLog.length = 0;
  await p.copyNegative();
  check('单独复制负面', clipboardLog[0] === 'Negative prompt: low quality', JSON.stringify(clipboardLog[0]));

  st.settings.copy_prefix_mode = 'none';
  clipboardLog.length = 0;
  await p.copyBoth();
  check('切到 none 后无前缀', clipboardLog[0] === '1girl, forest\n\nlow quality', JSON.stringify(clipboardLog[0]));

  st.settings.copy_prefix_mode = 'negative';
  clipboardLog.length = 0;
  await p.copyBoth();
  check('默认模式只负面前缀',
    clipboardLog[0] === '1girl, forest\n\nNegative prompt: low quality', JSON.stringify(clipboardLog[0]));

  // 空内容保护
  getEl('#promptText').value = '';
  getEl('#negText').value = '';
  clipboardLog.length = 0;
  await p.copyBoth();
  check('空提示词不写入剪贴板', clipboardLog.length === 0);

  // 设置里的预览
  getEl('#setCopyMode').value = 'both';
  getEl('#setCopyPosPrefix').value = 'P: ';
  getEl('#setCopyNegPrefix').value = 'N: ';
  p.updateCopyPreview();
  const preview = getEl('#copyPreview').textContent;
  check('预览含正面前缀', preview.includes('P: 1girl'), preview);
  check('预览含负面前缀', preview.includes('N: low quality'), preview);

  // 设置保存 / 回填
  p.fillSettingsForm();
  check('回填 copy_prefix_mode', getEl('#setCopyMode').value === 'negative', getEl('#setCopyMode').value);
  check('回填正面前缀', getEl('#setCopyPosPrefix').value === 'Positive prompt: ',
    getEl('#setCopyPosPrefix').value);

  console.log('\n[28] 主界面左侧分类栏拖动排序');
  p.renderCategories();
  const catHtml = getEl('#catList').innerHTML;
  const dragCount = (catHtml.match(/data-drag="cat"/g) || []).length;
  check('每个真实分类都带拖拽属性', dragCount === st.categories.length,
    `${dragCount} vs ${st.categories.length}`);
  check('每个可拖分类都带 draggable', (catHtml.match(/draggable="true"/g) || []).length === st.categories.length);
  check('「全部标签」不可拖',
    !/data-cat="__all__"[^>]*data-drag/.test(catHtml), 'should have no data-drag');
  check('改为 div 而非 button', catHtml.includes('<div class="cat-item') && !catHtml.includes('<button class="cat-item'));
  check('带 role/tabindex 可键盘操作', catHtml.includes('role="button"') && catHtml.includes('tabindex="0"'));
  check('clearSideDropMarks 不报错', (() => { p.clearSideDropMarks(); return true; })());
  check('bindSidebarDrag 不报错', (() => { p.bindSidebarDrag(); return true; })());

  // 拖动排序后左侧栏顺序跟着变
  const order0 = st.categories.map((c) => c.id);
  p.libMoveCategory(order0[3], 0);
  p.renderCategories();
  const moved = st.categories[0].id;
  check('把第 4 个分类拖到最前后，渲染顺序同步', moved === order0[3], `${moved} vs ${order0[3]}`);
  check('被拖的分类出现在列表最上面（在全部标签之后）',
    getEl('#catList').innerHTML.indexOf(`data-cat="${moved}"`)
      < getEl('#catList').innerHTML.indexOf(`data-cat="${order0[0]}"`));
  // libMoveCategory 的 toIndex 是"删除前"的下标：从 0 移到下标 4 等价于落到最终下标 3
  p.libMoveCategory(moved, 4);
  check('顺序可还原', st.categories.map((c) => c.id).join() === order0.join(),
    st.categories.map((c) => c.id).join().slice(0, 40));

  console.log('\n[29] 服务商预设 + 连接测试');
  check('预设数量 >= 7', p.LLM_PROVIDERS.length >= 7, String(p.LLM_PROVIDERS.length));
  check('含 DeepSeek 预设', p.LLM_PROVIDERS.some((x) => x.id === 'deepseek'));
  check(
    'DeepSeek 地址正确',
    p.LLM_PROVIDERS.find((x) => x.id === 'deepseek').baseUrl === 'https://api.deepseek.com',
  );
  check(
    '每个预设都有 baseUrl / model / name',
    p.LLM_PROVIDERS.every((x) => x.name && (x.baseUrl || x.id === 'custom') && (x.model || x.id === 'custom')),
  );

  check('能识别 DeepSeek 地址', p.matchProvider('https://api.deepseek.com') === 'deepseek');
  check('末尾斜杠不影响识别', p.matchProvider('https://api.deepseek.com/') === 'deepseek');
  check('大小写不影响识别', p.matchProvider('https://API.DeepSeek.com') === 'deepseek');
  check('能识别 OpenAI 地址', p.matchProvider('https://api.openai.com/v1') === 'openai');
  check('陌生地址归为自定义', p.matchProvider('https://my-proxy.internal/v1') === 'custom');
  check('空地址归为自定义', p.matchProvider('') === 'custom');

  p.renderProviderOptions();
  check('下拉选项已渲染', getEl('#setProvider').innerHTML.includes('DeepSeek'));

  getEl('#setProvider').value = 'deepseek';
  p.applyProvider('deepseek');
  check('选预设会填地址', getEl('#setBaseUrl').value === 'https://api.deepseek.com', getEl('#setBaseUrl').value);
  check('选预设会填模型', getEl('#setModel').value === 'deepseek-chat', getEl('#setModel').value);
  check('预设说明已显示', getEl('#providerNote').hidden === false);

  getEl('#setProvider').value = 'custom';
  p.applyProvider('custom');
  check('自定义不清空已填内容', getEl('#setBaseUrl').value === 'https://api.deepseek.com');

  // 连接测试：成功
  getEl('#setBaseUrl').value = 'https://api.deepseek.com';
  getEl('#setModel').value = 'deepseek-chat';
  getEl('#setApiKey').value = 'sk-test';
  await p.testConnection();
  const okText = getEl('#connResult').textContent;
  check('测试成功显示 ok 样式', getEl('#connResult').className === 'conn-result ok', getEl('#connResult').className);
  check('提示地址可用', okText.includes('地址与 API Key 均可用'), okText.split('\n')[0]);
  check('提示模型名在列表里', okText.includes('在列表里'), okText);
  check('列出可用模型', okText.includes('deepseek-reasoner'));

  // 连接测试：模型名不匹配
  getEl('#setModel').value = 'gpt-4o-mini';
  await p.testConnection();
  check('模型名不在列表时给出警告', getEl('#connResult').textContent.includes('不在返回的列表里'),
    getEl('#connResult').textContent);

  // 连接测试：失败
  getEl('#setBaseUrl').value = 'https://bad.example.com/v1';
  getEl('#setModel').value = 'x';
  await p.testConnection();
  const errText = getEl('#connResult').textContent;
  check('测试失败显示 err 样式', getEl('#connResult').className === 'conn-result err');
  check('错误信息可读', errText.includes('API Key 无效'), errText.split('\n')[0]);
  check('给出常见原因提示', errText.includes('接口地址和服务商不匹配'), errText);
  check('失败后按钮恢复可用', getEl('#btnTestConnection').disabled === false);

  // 回填时能自动识别服务商
  st.settings.base_url = 'https://api.moonshot.cn/v1';
  st.settings.model = 'moonshot-v1-8k';
  p.fillSettingsForm();
  check('回填时自动选中对应服务商', getEl('#setProvider').value === 'moonshot', getEl('#setProvider').value);

  console.log('\n[30] 润色结果：正负提示词分离');
  // 1) 正常的四行格式
  const normal = p.parsePolishResult(
    'PROMPT: 1girl, forest, rim light\nNEGATIVE: low quality, blurry\n说明: 补了光线；删了重复词。',
  );
  check('正常格式：正向正确', normal.prompt === '1girl, forest, rim light', normal.prompt);
  check('正常格式：负面正确', normal.negative === 'low quality, blurry', normal.negative);
  check('正常格式：说明正确', normal.notes.includes('补了光线'));

  // 2) Midjourney 把 --no 写进正向的情况（这次报的 bug）
  const mj = p.parsePolishResult(
    'PROMPT: a serene forest at dawn, soft light --ar 16:9 --stylize 250 --no low quality, blurry, watermark\n'
    + 'NEGATIVE: \n说明: 改成 MJ 风格。',
  );
  check('MJ：--no 已从正向拆出', !mj.prompt.includes('--no'), mj.prompt);
  check('MJ：正向保留 --ar / --stylize', mj.prompt.includes('--ar 16:9') && mj.prompt.includes('--stylize 250'), mj.prompt);
  check('MJ：负面被正确分离', mj.negative === 'low quality, blurry, watermark', mj.negative);
  check('MJ：正向不含负面词', !/low quality|blurry/.test(mj.prompt), mj.prompt);

  // 3) --no 在中间、后面还有别的参数
  const mj2 = p.parsePolishResult('PROMPT: cat --no ugly --ar 1:1\nNEGATIVE: 无\n说明: ok');
  check('MJ：--no 后面还有参数也能切', mj2.prompt === 'cat --ar 1:1', mj2.prompt);
  check('MJ：负面来自 --no', mj2.negative === 'ugly', mj2.negative);

  // 4) 模型没打标签、整段输出（自然语言模式常见）
  const blob = p.parsePolishResult(
    'A girl stands in a sunlit forest, light filtering through leaves. She wears a white dress.\n'
    + 'NEGATIVE: low quality, blurry\n说明: 改成两句话描述。\nWEIGHTS: forest:1.2',
  );
  check('无 PROMPT 标签时能兜底', blob.prompt.startsWith('A girl stands'), blob.prompt.slice(0, 40));
  check('兜底不会把「说明」混进正向', !blob.prompt.includes('说明'), blob.prompt);
  check('兜底不会把 WEIGHTS 混进正向', !blob.prompt.includes('WEIGHTS'), blob.prompt);

  // 5) 完全没有任何标签
  const bare = p.parsePolishResult('just a plain sentence.\n说明: 一句话');
  check('纯文本兜底：切掉说明', bare.prompt === 'just a plain sentence.', bare.prompt);

  // 6) 「无」按空处理
  check('NEGATIVE=无 视为空', p.parsePolishResult('PROMPT: a\nNEGATIVE: 无').negative === '');
  check('NEGATIVE=none 视为空', p.parsePolishResult('PROMPT: a\nNEGATIVE: none').negative === '');
  check('isNoneWord 判定', p.isNoneWord('无') && p.isNoneWord('none') && !p.isNoneWord('low quality'));

  // 7) splitNoParam 单测
  const sp = p.splitNoParam('a, b --ar 16:9 --no x, y');
  check('splitNoParam 拆正向', sp.prompt === 'a, b --ar 16:9', sp.prompt);
  check('splitNoParam 拆负面', sp.negative === 'x, y', sp.negative);
  check('splitNoParam 无 --no 时原样', p.splitNoParam('a, b').prompt === 'a, b');

  // 8) 合成 --no 按钮
  getEl('#polishResult').value = 'a serene forest --ar 16:9';
  getEl('#polishResultNeg').value = 'low quality, blurry';
  p.mergeNoParam();
  check('合成 --no 追加到末尾',
    getEl('#polishResult').value === 'a serene forest --ar 16:9 --no low quality, blurry',
    getEl('#polishResult').value);

  // 9) 重复点合成不会叠加 --no
  p.mergeNoParam();
  check('重复合成不会叠加 --no',
    (getEl('#polishResult').value.match(/--no/g) || []).length === 1, getEl('#polishResult').value);

  // 10) 按钮只在 Midjourney 模式显示
  p.setPolishTarget('midjourney');
  check('MJ 模式显示合成按钮', getEl('#btnPolishMergeNo').hidden === false);
  p.setPolishTarget('tags');
  check('标签模式隐藏合成按钮', getEl('#btnPolishMergeNo').hidden === true);
  p.setPolishTarget('natural');
  check('自然语言模式隐藏合成按钮', getEl('#btnPolishMergeNo').hidden === true);
  p.setPolishTarget('tags');

  console.log('\n[31] 方案槽位：空值不覆盖 + 负面存储 + 二次确认');
  const setSlot = (i, prompt, negative) => { st.slots[i] = { prompt, negative }; };
  const setWork = (prompt, negative) => {
    getEl('#promptText').value = prompt;
    getEl('#negText').value = negative || '';
  };
  confirmAnswer = true;
  confirmCalls = [];

  // —— 原始 bug：槽位有内容 + 工作区空白 = 被清空 ——
  setSlot(0, '1girl, forest', 'low quality');
  setWork('', '');
  p.saveToSlot(0);
  check('空工作区不会清空已有槽位', st.slots[0].prompt === '1girl, forest', st.slots[0].prompt);
  check('空工作区不会清掉负面', st.slots[0].negative === 'low quality', st.slots[0].negative);
  check('空工作区不会弹覆盖确认', confirmCalls.length === 0, `confirm ${confirmCalls.length} 次`);

  // —— 空槽位 + 空工作区：也不写入 ——
  setSlot(1, '', '');
  p.saveToSlot(1);
  check('两边都空时不写入', st.slots[1].prompt === '' && st.slots[1].negative === '');

  // —— 正常存入（开关默认开）——
  st.settings.slot_store_negative = true;
  setSlot(2, '', '');
  setWork('1girl, cat', 'blurry');
  p.saveToSlot(2);
  check('存入正向', st.slots[2].prompt === '1girl, cat', st.slots[2].prompt);
  check('存入负面（开关打开时）', st.slots[2].negative === 'blurry', st.slots[2].negative);

  // —— 开关关闭时只存正向 ——
  st.settings.slot_store_negative = false;
  setSlot(3, '', '');
  setWork('a dog', 'watermark');
  p.saveToSlot(3);
  check('开关关闭时只存正向', st.slots[3].prompt === 'a dog', st.slots[3].prompt);
  check('开关关闭时不存负面', st.slots[3].negative === '', st.slots[3].negative);
  st.settings.slot_store_negative = true;

  // —— 覆盖已有槽位要确认：取消则不动 ——
  setSlot(0, 'old prompt', 'old neg');
  setWork('new prompt', 'new neg');
  confirmAnswer = false;
  confirmCalls = [];
  p.saveToSlot(0);
  check('覆盖前弹了确认框', confirmCalls.length === 1);
  check('确认框说明了会覆盖', confirmCalls[0].includes('已经有内容'), confirmCalls[0].split('\n')[0]);
  check('取消后正向不变', st.slots[0].prompt === 'old prompt', st.slots[0].prompt);
  check('取消后负面不变', st.slots[0].negative === 'old neg', st.slots[0].negative);

  // —— 确认则覆盖 ——
  confirmAnswer = true;
  confirmCalls = [];
  p.saveToSlot(0);
  check('确认后完成覆盖', st.slots[0].prompt === 'new prompt' && st.slots[0].negative === 'new neg',
    `${st.slots[0].prompt} / ${st.slots[0].negative}`);

  // —— 空槽位存入不打扰用户 ——
  setSlot(1, '', '');
  setWork('only pos', '');
  confirmCalls = [];
  p.saveToSlot(1);
  check('空槽位存入不弹确认', confirmCalls.length === 0);
  check('空槽位存入成功', st.slots[1].prompt === 'only pos');

  // —— 槽位卡片正文同时展示正负 ——
  const body = p.slotBody({ prompt: 'a, b', negative: 'x, y' });
  check('槽位正文含正向', body.includes('a, b'));
  check('槽位正文含负面', body.includes('x, y'));
  check('槽位正文有正负标记', body.includes('slot-lbl pos') && body.includes('slot-lbl neg'));
  check('无负面时不渲染负面行', !p.slotBody({ prompt: 'a', negative: '' }).includes('slot-lbl neg'));
  check('只有负面时也能显示', p.slotBody({ prompt: '', negative: 'z' }).includes('z'));

  // —— slotSummary 描述 ——
  check('slotSummary 统计正负', p.slotSummary({ prompt: 'a, b, c', negative: 'x' }) === '3 个正向标签，1 个负面标签',
    p.slotSummary({ prompt: 'a, b, c', negative: 'x' }));
  check('slotFilled 判定', p.slotFilled({ prompt: '', negative: 'x' }) === true
    && p.slotFilled({ prompt: '', negative: '' }) === false);

  // —— 并排对比纳入负面 ——
  st.compareOpen = false;
  st.slots[0] = { prompt: 'a', negative: 'NEG-A' };
  st.slots[1] = { prompt: 'b', negative: 'NEG-B' };
  st.compareOpen = true;
  p.renderCompare();
  const cmp = getEl('#slotCompare').innerHTML;
  check('对比里出现负面区', cmp.includes('compare-neg'));
  check('对比里含槽位负面内容', cmp.includes('NEG-A'), 'NEG-A');
  check('对比里含另一个槽位负面', cmp.includes('NEG-B'));
  st.compareOpen = false;

  // —— 开关同步 ——
  st.settings.slot_store_negative = false;
  p.syncSlotOption();
  check('开关未勾选', getEl('#slotStoreNeg').checked === false);
  check('提示文案跟着变', getEl('#slotStoreNegTip').textContent.includes('只存正向'),
    getEl('#slotStoreNegTip').textContent.slice(0, 24));
  st.settings.slot_store_negative = true;
  p.syncSlotOption();
  check('开关已勾选', getEl('#slotStoreNeg').checked === true);

  console.log('\n[32] 模型名下拉（可选可手填）');
  const nonCustom = p.LLM_PROVIDERS.filter((x) => x.id !== 'custom');
  check('每个服务商都配了模型清单',
    nonCustom.every((x) => (p.PROVIDER_MODELS[x.id] || []).length > 0),
    nonCustom.filter((x) => !(p.PROVIDER_MODELS[x.id] || []).length).map((x) => x.id).join(',') || '全部有');
  check('DeepSeek 清单含 deepseek-chat', p.PROVIDER_MODELS.deepseek.includes('deepseek-chat'));
  check('OpenAI 清单含 gpt-4o-mini', p.PROVIDER_MODELS.openai.includes('gpt-4o-mini'));

  // 切到 DeepSeek，下拉应列出其模型
  getEl('#setProvider').value = 'deepseek';
  p.applyProvider('deepseek');
  const menu = getEl('#modelMenu');
  check('下拉已渲染条目', menu.innerHTML.includes('data-model='));
  check('下拉列出 deepseek-reasoner', menu.innerHTML.includes('deepseek-reasoner'));
  check('当前模型被标为选中', menu.innerHTML.includes('is-active'), 'deepseek-chat');

  // 选中一项（测试桩的 querySelectorAll 不做选择器解析，所以直接调 pickModel）
  getEl('#setProvider').value = 'deepseek';
  p.updateModelOptions();
  p.pickModel('deepseek-reasoner');
  check('从下拉选中后写回输入框', getEl('#setModel').value === 'deepseek-reasoner', getEl('#setModel').value);
  check('选中后下拉自动收起', getEl('#modelMenu').hidden === true);

  // 自定义服务商 → 提示手填
  getEl('#setProvider').value = 'custom';
  p.updateModelOptions();
  check('自定义服务商提示手填', menu.innerHTML.includes('直接手填'), menu.innerHTML.slice(0, 40));

  // 开合
  getEl('#setProvider').value = 'openai';
  p.openModelMenu();
  check('openModelMenu 展开', menu.hidden === false);
  check('展开时带 is-open 样式', getEl('#modelCombo').classList.contains('is-open'));
  p.closeModelMenu();
  check('closeModelMenu 收起', menu.hidden === true);
  check('收起后去掉 is-open', !getEl('#modelCombo').classList.contains('is-open'));
  p.toggleModelMenu();
  check('toggle 能展开', menu.hidden === false);
  p.toggleModelMenu();
  check('toggle 能收起', menu.hidden === true);

  // 手填仍然可用
  getEl('#setModel').value = 'my-own-model';
  check('仍然支持手填任意模型名', getEl('#setModel').value === 'my-own-model');

  console.log('\n[33] 本地中英互译（按标签匹配）');
  check('HAS_CJK 判定', p.HAS_CJK.test('中文') === true && p.HAS_CJK.test('english') === false);

  // 英 → 中
  const someTag = st.tagIndex.find((t) => t.zh && t.en && !t.en.includes(','));
  check('词库里有可用样本', Boolean(someTag), someTag && `${someTag.en} → ${someTag.zh}`);

  const e2z = p.translateEnToZh(someTag.en);
  check('英译中：整条标签被换掉', e2z.text === someTag.zh, `${someTag.en} → ${e2z.text}`);
  check('英译中：计到 1 次命中', e2z.hit === 1);

  const mixed = p.translateEnToZh(`${someTag.en}, not-a-real-tag-xyz`);
  check('英译中：只换认得的标签', mixed.text.includes(someTag.zh) && mixed.text.includes('not-a-real-tag-xyz'),
    mixed.text);
  check('英译中：命中数正确', mixed.hit === 1);

  check('英译中：位置无关（大小写与空格）',
    p.translateEnToZh(`  ${someTag.en.toUpperCase()}  `).hit === 1, someTag.en.toUpperCase());

  // 方向自动判断
  check('translateSide：含中文 → zh2en', p.translateSide('一只猫').dir === 'zh2en');
  check('translateSide：纯英文 → en2zh', p.translateSide(someTag.en).dir === 'en2zh');
  check('translateSide：空串不判方向', p.translateSide('').dir === null);
  check('translateSide：空串不报错', p.translateSide('   ').hit === 0);

  // 端到端：英 → 中
  setWork(someTag.en, '');
  st.settings.slot_store_negative = true;
  p.runLocalTranslate();
  check('工作区英译中生效', promptValue() === someTag.zh, `${someTag.en} → ${promptValue()}`);

  // 端到端：中 → 英（原有方向不能被改坏）
  setWork(someTag.zh, '');
  p.runLocalTranslate();
  check('工作区中译英仍然生效', promptValue() === someTag.en, `${someTag.zh} → ${promptValue()}`);

  // 无命中时不动文本
  setWork('zzz-not-a-tag-zzz', '');
  p.runLocalTranslate();
  check('无命中时不改动文本', promptValue() === 'zzz-not-a-tag-zzz', promptValue());

  // 不做逐词翻译：单个英文单词不是标签时保持原样
  const wordOnly = p.translateEnToZh('zzznotatag');
  check('不按词拆分：整条不是标签就不换', wordOnly.text === 'zzznotatag' && wordOnly.hit === 0);

  console.log('\n[34] 右下操作栏吸底（CSS）');
  const css = fs.readFileSync(path.join(ROOT, 'app/style.css'), 'utf8');
  const wsRule = css.slice(css.indexOf('.ws-actions {'), css.indexOf('/* 把「复制全部'));
  check('底部栏用了 position: sticky', wsRule.includes('position: sticky'));
  check('底部栏吸底到 bottom: 0', wsRule.includes('bottom: 0'));
  check('底部栏有背景（否则内容会透出来）', wsRule.includes('background: var(--panel)'));
  check('底部栏有 z-index', /z-index:\s*\d+/.test(wsRule));
  check('底部栏横向抵消容器内边距', wsRule.includes('margin: auto -13px -13px'));
  check('保留了 push-right 右推规则', css.includes('.ws-actions .push-right { margin-left: auto; }'));
  check('浅色主题有单独阴影', css.includes('html[data-theme="light"] .ws-actions'));

  console.log(`\n接口调用 ${calls.length} 次：${[...new Set(calls)].join(' | ')}`);
  console.log(failed ? '\n❌ 存在失败项\n' : '\n✅ 全部通过\n');
  process.exit(failed ? 1 : 0);
})();
