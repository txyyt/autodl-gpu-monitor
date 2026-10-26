const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../clone-core.js');
const root = path.join(__dirname, '..');
const url = 'https://www.autodl.com/cloneInstance?region=cq-A1&id=source-abc&copy_data_disk=1&expand_size=0';
const config = C.options({ models: ['RTX 4090'], count: 2, maxPrice: 4, interval: 15, preview: false });
const machine = { id: 'host123', model: 'RTX 4090', available: 2, price: 1.98, enabled: true };

test('clone identity requires data disk, exact source/region and official origin', () => {
  assert.equal(C.context(url).sourceId, 'source-abc');
  for (const bad of [url.replace('copy_data_disk=1', 'copy_data_disk=0'), url.replace('www.autodl.com', 'other.test'),
    url.replace('/cloneInstance', '/createInstance'), url.replace('id=source-abc', 'id=')]) {
    assert.throws(() => C.context(bad));
  }
  assert.throws(() => C.assertContext(C.context(url.replace('cq-A1', 'bj-B1')), C.context(url)));
  assert.throws(() => C.assertContext(C.context(url.replace('source-abc', 'other-def')), C.context(url)));
});

test('full-instance budget, exact GPU model, stock and disabled host filtering', () => {
  assert.equal(C.eligible(machine, config), true);
  for (const changed of [{ price: 2.01 }, { model: 'RTX 4090D' }, { available: 1 }, { enabled: false },
    { price: NaN }, { price: 0 }, { id: '' }]) {
    assert.equal(C.eligible({ ...machine, ...changed }, config), false);
  }
  assert.equal(C.eligible({ ...machine, price: 2 }, config), true);
  assert.equal(C.money('￥1,234.56/时 ￥1999/时'), 1234.56);
});

test('config rejects missing GPU, CPU, invalid quantity, unbounded budget or rapid refresh', () => {
  for (const changed of [{ models: [] }, { models: ['CPU'] }, { count: 9 }, { count: 1.5 }, { maxPrice: '' },
    { maxPrice: Infinity }, { maxPrice: 1.001 }, { interval: 2 }, { interval: 3.5 }, { interval: '' }, { interval: NaN }]) {
    assert.throws(() => C.options({ ...config, ...changed }));
  }
  assert.equal('preview' in C.options({ ...config, preview: true }), false);
});

function worker(store, snapshots = [], startContext) {
  let onMessage, alarm;
  const notices = [];
  const sandbox = { console, URL, crypto: require('node:crypto').webcrypto, CloneCore: C,
    createDiagnosticLogger: require('../diagnostics.js').createDiagnosticLogger,
    cleanDiagnosticDetails: require('../diagnostics.js').clean,
    monitoringEnabled: false, intervalId: null, checkInProgress: false, clearInterval() {},
    setTimeout: fn => { queueMicrotask(fn); return 1; }, importScripts() {},
    sendEmailNotification: async data => notices.push({ email: data }),
    chrome: {
      storage: { local: { get: async key => ({ [key]: store[key] }), set: async values => Object.assign(store, structuredClone(values)) } },
      runtime: { onMessage: { addListener: fn => { onMessage = fn; } } },
      notifications: { create: async data => notices.push(data) },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: fn => { alarm = fn; } } },
      tabs: { create: async () => ({ id: 99 }), remove: async () => {},
        get: async id => ({ id, status: 'complete', url: 'https://www.autodl.com/console/instance/list' }),
        sendMessage: async (id, request) => {
          if (startContext && request.action === 'cloneContext') return { success: true, context: startContext };
          if (startContext && request.action === 'cloneRun') return { success: true };
          assert.equal(request.action, 'cloneListSnapshot', 'tracking may only read instance lists');
          return { success: true, instances: snapshots };
        } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'clone-background.js'), 'utf8'), sandbox);
  return { notices, tick: () => alarm({ name: 'clone-watchdog' }), send: (action, data = {}, tabId = 7) =>
    new Promise(resolve => onMessage({ action, ...data }, { tab: { id: tabId } }, resolve)) };
}
function watching(preview = false) {
  return { id: 'job-1', tabId: 7, phase: 'watching', config: { ...config, preview },
    context: { ...C.context(url), regionName: '重庆A区', dataCenter: 'chongqingDC1' }, baseline: ['source-abc', 'busy-710'] };
}
const selected = { id: 'host123', model: 'RTX 4090', name: '123机', price: 1.98, total: 3.96 };
test('worker diagnostics export captures page version, price comparison and prior job context', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  await w.send('cloneDiagnostic', { id: 'job-1', adapterVersion: C.VERSION, event: 'price.check',
    details: { hourlyQuote: 2.19, dailyQuote: 0, count: 1, expectedTotal: 2.19, maxPrice: 3, token: 'do-not-log' } });
  const exported = await w.send('diagnosticRead');
  assert.equal(exported.currentJob.jobId, 'job-1');
  assert.equal(exported.extensionVersion, C.VERSION);
  const price = exported.log.entries.find(entry => entry.event === 'price.check');
  assert.equal(price.details.pageVersion, C.VERSION);
  assert.equal(price.details.hourlyQuote, 2.19);
  assert.equal(price.details.dailyQuote, 0);
  assert.equal(JSON.stringify(exported).includes('do-not-log'), false);
});
test('only one reservation survives concurrent requests and worker restart', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  const results = await Promise.all([w.send('cloneReserve', { id: 'job-1', selected }), w.send('cloneReserve', { id: 'job-1', selected })]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(store.cloneMonitorJob.phase, 'submitting');
  const restarted = worker(store);
  assert.equal((await restarted.send('cloneReserve', { id: 'job-1', selected })).success, false);
});
test('other tabs, preview jobs and changed IDs cannot reserve', async () => {
  for (const [preview, jobId, tabId] of [[true, 'job-1', 7], [false, 'wrong', 7], [false, 'job-1', 8]]) {
    const store = { cloneMonitorJob: watching(preview) };
    assert.equal((await worker(store).send('cloneReserve', { id: jobId, selected }, tabId)).success, false);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
  }
});
test('malformed or over-budget reservation cannot take the submission lock', async () => {
  for (const changed of [{ total: NaN }, { total: 0 }, { price: NaN }, { total: 5 }, { total: 3, price: 1.98 }, { id: '' }]) {
    const store = { cloneMonitorJob: watching() };
    const result = await worker(store).send('cloneReserve', { id: 'job-1', selected: { ...selected, ...changed } });
    assert.equal(result.success, false);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
  }
});
test('stop before reservation cancels; stop after reservation retains uncertainty lock', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  await w.send('cloneStop');
  assert.equal((await w.send('cloneReserve', { id: 'job-1', selected })).success, false);
  store.cloneMonitorJob = watching();
  await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneStop');
  assert.equal(store.cloneMonitorJob.phase, 'uncertain');
  assert.equal((await w.send('clonePermit', { id: 'job-1' })).success, false);
});
test('tracking does not call success for creating, failed or no-card instances', async () => {
  for (const status of ['创建中', '克隆中', '运行中 无卡模式', '创建失败']) {
    const job = { ...watching(), selected, phase: 'submitted', submittedAt: Date.now() };
    const store = { cloneMonitorJob: job };
    const w = worker(store, [{ id: 'new-123', region: '重庆A区', host: '123机', spec: 'RTX 4090 * 2卡', status }]);
    await w.tick();
    assert.notEqual(store.cloneMonitorJob.phase, 'success');
    assert.equal(w.notices.some(n => n.email), false);
  }
});
test('unique new GPU-running instance ends job; existing busy 710 instance is ignored', async () => {
  const store = { cloneMonitorJob: { ...watching(), selected, phase: 'submitted', submittedAt: Date.now() } };
  const w = worker(store, [
    { id: 'busy-710', host: '710机', region: '重庆A区', status: '运行中', spec: 'vGPU-32GB * 1卡' },
    { id: 'new-123', host: '123机', region: '重庆A区', status: '运行中', spec: 'RTX 4090 * 2卡' }
  ]);
  await w.tick();
  assert.equal(store.cloneMonitorJob.phase, 'success');
  assert.equal(store.cloneMonitorJob.newInstanceId, 'new-123');
  assert.equal(w.notices.filter(n => n.email).length, 1);
});

test('DOM adapter reads live-style clone controls, ignores old price and fails on unlocked region', async () => {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(`<html><body>
    克隆实例仅能在同一地区内进行，以实例：source-abc的系统创建新实例
    <div class="filter-item"><span class="filter-label">选择地区:</span>
      <label>重庆A区<input type="radio" value="chongqingDC1" checked></label>
      <label>北京B区<input type="radio" value="beijingDC2" disabled></label></div>
    <div class="filter-item"><span class="filter-label">GPU型号:</span>
      <label><input type="checkbox" value="false">全部</label>
      <label><input type="checkbox" value="RTX 4090">RTX 4090</label></div>
    <table class="el-table__body"><tbody><tr>
      <td><input type="radio" value="host123"></td><td>123机</td>
      <td><div class="cell"><div>RTX 4090<br>24GB</div></div></td><td>2 / 8</td>
      <td>CPU</td><td>Xeon</td><td>50GB</td><td>13.0</td>
      <td><div class="price"><span>￥1.98</span>/时<span style="text-decoration:line-through">￥9.99/时</span></div></td>
    </tr></tbody></table></body></html>`);
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'checked', { get: () => input.hasAttribute('checked') });
    Object.defineProperty(input, 'disabled', { get: () => input.hasAttribute('disabled') });
    if (input.type === 'checkbox') input.closest('label')?.addEventListener('click', () => input.toggleAttribute('checked'));
  }
  const sandbox = { CloneCore: C, window, document, location: { href: url }, URL, console, setInterval: () => 1,
    chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8')
    .replace('  chrome.runtime.onMessage.addListener', '  globalThis.adapter = { pageContext, machines };\n  chrome.runtime.onMessage.addListener');
  vm.runInContext(source, sandbox);
  assert.equal(sandbox.adapter.pageContext().dataCenter, 'chongqingDC1');
  const row = sandbox.adapter.machines()[0];
  assert.equal(row.model, 'RTX 4090');
  assert.equal(row.price, 1.98);
  assert.equal(row.available, 2);
  assert.equal(C.eligible(row, config), true);
  document.querySelector('input[value="beijingDC2"]').removeAttribute('disabled');
  assert.throws(() => sandbox.adapter.pageContext(), /地区未锁定/);
});

async function pageWorkflow({ preview = false, available = 2, quoted = 3.96, cancelOnReserve = false, lostOnSelect = false,
  imageCuda, hostCuda = '13.0', notice, noticeKind = 'notification', preexistingNotice,
  excludedHosts = [], hostCooldowns = {}, expandGB = 0, expandableGB = 100, sourceGB = 0,
  diskMax, lostCapacity = false, clampDisk = false, changeDailyOnReserve = false } = {}) {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(`<html><body>
    克隆实例仅能在同一地区内进行，以实例：source-abc的系统创建新实例
    <div class="filter-item"><span class="filter-label">选择地区:</span>
      <label>重庆A区<input type="radio" value="chongqingDC1" checked></label></div>
    <div class="filter-item"><span class="filter-label">GPU型号:</span>
      <label><input type="checkbox" value="RTX 4090" checked>RTX 4090</label></div>
    <div class="filter-item"><span class="filter-label">GPU数量:</span>
      <label><input type="radio" value="2" checked>2</label></div>
    <label><input type="radio" value="payg" checked>按量计费</label>
    <div class="el-table"><table><thead><tr><th class="descending">空闲GPU<i class="sort-caret descending"></i></th></tr></thead></table>
      <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr>
        <td><input type="radio" value="host123"></td><td>123机</td>
        <td><div class="cell"><div>RTX 4090<br>24GB</div></div></td><td>${available} / 8</td>
        <td>CPU</td><td>Xeon</td><td>数据盘：50GB 可扩容：${expandableGB}GB</td><td>驱动: 580.105.08 CUDA: ${hostCuda}</td>
        <td><div class="price"><span>￥1.98</span>/时</div></td>
      </tr></tbody></table></div></div><div class="sum">
        <div class="daily-cost"><span class="pay-mode">日常费用：</span><span class="rmb">￥</span><span class="num">0.00</span><span class="unit">/日</span></div>
        <div><span class="pay-mode">配置费用：</span><span class="rmb">￥</span><span class="num">${quoted}</span><span class="unit">/时</span></div>
      </div>
      ${expandGB > 0 ? '<label class="needExpand"><input type="checkbox" value="需要扩容">需要扩容</label><div class="disk-size"><input role="spinbutton" min="0" max="0" value="0"></div>' : ''}
      <button>创建并开机</button></body></html>`);
  const uiEvents = [];
  window.__autodlCloneAdapter = false;
  document.querySelector('.sort-caret.descending').addEventListener('click', () =>
    document.querySelector('th').classList.toggle('descending'));
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'checked', { get: () => input.hasAttribute('checked') });
    Object.defineProperty(input, 'disabled', { get: () => input.hasAttribute('disabled') });
  }
  document.querySelector('.el-table__body tr').addEventListener('click', () =>
    { document.querySelector('input[value="host123"]').setAttribute('checked', '');
      uiEvents.push('select-host');
      if (lostCapacity) document.querySelector('.el-table__body tr').children[6].textContent = '数据盘:50GB 可扩容:10GB';
      const diskField = document.querySelector('.disk-size input');
      if (diskField) diskField.setAttribute('max', String(diskMax ?? expandableGB));
      if (lostOnSelect) document.querySelector('.el-table__body tr').children[3].textContent = '0 / 8'; });
  if (expandGB > 0) {
    const check = document.querySelector('.needExpand input'), field = document.querySelector('.disk-size input');
    check.closest('label').addEventListener('click', () => { check.toggleAttribute('checked'); uiEvents.push('expand-toggle'); });
    field.blur = () => {};
    field.addEventListener('input', () => {
      assert.ok(document.querySelector('input[value="host123"]').checked, 'host must be selected before expansion input');
      assert.equal(check.checked, true);
      uiEvents.push(`input-${field.value}`);
      if (clampDisk) field.value = '0';
      document.querySelector('.daily-cost .num').textContent = '2.50';
    });
  }
  const create = document.querySelector('button');
  create.getClientRects = () => [1];
  let clicks = 0;
  let reselects = 0;
  function appendNotice(value, kind = 'notification') {
    const node = document.createElement('div');
    node.className = kind === 'dialog' ? 'el-message-box' : 'el-notification';
    const content = document.createElement('div');
    content.className = kind === 'dialog' ? 'el-message-box__message' : 'el-notification__content';
    content.textContent = value; node.append(content);
    let shown = true;
    node.getClientRects = () => shown ? [1] : [];
    if (kind === 'dialog') {
      const button = document.createElement('button'); button.textContent = '重新选择';
      button.getClientRects = () => shown ? [1] : [];
      button.addEventListener('click', () => { reselects++; shown = false; node.remove(); }); node.append(button);
    }
    document.body.append(node);
  }
  if (preexistingNotice) appendNotice(preexistingNotice);
  create.addEventListener('click', () => {
    clicks++;
    if (notice) appendNotice(notice, noticeKind);
  });
  const actions = [];
  const requests = [];
  let reloadScheduled = false;
  const job = watching(preview);
  const observers = [];
  const sourceUrl = url.replace('expand_size=0', `expand_size=${sourceGB * 1024 ** 3}`);
  const pageUrl = imageCuda ? `${sourceUrl}&image_cuda=${imageCuda}` : sourceUrl;
  job.config = { ...job.config, expandGB };
  job.context = { ...job.context, ...C.context(pageUrl), imageCuda };
  job.excludedHosts = excludedHosts; job.hostCooldowns = hostCooldowns;
  const sandbox = { CloneCore: C, window, document, location: { href: pageUrl, pathname: '/cloneInstance', reload() {} },
    console, URL, crypto: require('node:crypto').webcrypto, Event: window.Event,
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.active = true; } disconnect() { this.active = false; } }, clearTimeout() {}, setInterval: () => 1,
    setTimeout: (fn, ms) => { if (ms >= 10000) reloadScheduled = true; else queueMicrotask(fn); return 1; },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async request => {
      actions.push(request.action);
      requests.push(request);
      if (request.action === 'cloneError') actions.push(request.message);
      if (request.action === 'cloneJob') return { job };
      if (request.action === 'cloneReserve') {
        job.phase = cancelOnReserve ? 'stopped' : 'submitting'; job.selected = request.selected; job.attemptId = 'attempt';
        if (changeDailyOnReserve) document.querySelector('.daily-cost .num').textContent = '3.00';
        return { success: true, attemptId: 'attempt' };
      }
      if (request.action === 'clonePermit') return { success: job.phase === 'submitting' };
      if (request.action === 'cloneClicked') job.phase = 'submitted';
      if (request.action === 'cloneSubmissionRejected') job.phase = 'watching';
      return { success: true };
    } } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8')
    .replace('  chrome.runtime.onMessage.addListener', '  globalThis.runAdapter = run;\n  chrome.runtime.onMessage.addListener'), sandbox);
  await sandbox.runAdapter();
  return { clicks, actions, reloadScheduled, requests, job, reselects, uiEvents,
    emitNotice: async (value, kind) => {
      appendNotice(value, kind);
      for (const observer of observers) if (observer.active) observer.callback();
      await new Promise(resolve => setImmediate(resolve));
    } };
}
test('old preview jobs are stopped during migration instead of unexpectedly creating', async () => {
  const result = await pageWorkflow({ preview: true });
  assert.ok(result.actions.includes('cloneError'), JSON.stringify(result.actions));
  assert.equal(result.actions.includes('cloneReserve'), false);
  assert.equal(result.clicks, 0);
});

test('hourly quote ignores daily charges, balance and other currency amounts', () => {
  const { document } = require('linkedom').parseHTML(`<div class="sum">
    <div class="daily-cost"><span class="pay-mode">日常费用：</span><span class="num">0.00</span><span class="unit">/日</span></div>
    <div><span class="pay-mode">配置费用：</span><span class="rmb">￥</span><span class="num">2.19</span><span class="unit">/时</span></div>
    <div>余额 ￥199.63</div></div>`);
  assert.equal(C.hourlyQuote(document), 2.19);
  document.querySelector('.daily-cost .num').textContent = '8.00';
  assert.equal(C.hourlyQuote(document), 2.19);
  document.querySelector('.sum > div:nth-child(2) .unit').textContent = '/日';
  assert.throws(() => C.hourlyQuote(document), /小时价/);
});

test('UI exposes separate mode menus, an immediate status card and no preview checkbox', () => {
  const { document } = require('linkedom').parseHTML(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'));
  assert.equal(document.querySelectorAll('[data-panel]').length, 3);
  assert.ok(document.querySelector('#clonePanel #cloneStateTitle'));
  assert.ok(document.querySelector('#legacyPanel #statusText'));
  assert.ok(document.querySelector('#notificationsPanel #enableEmailNotify'));
  assert.equal(document.querySelector('#clonePreview'), null);
  const ids = Array.from(document.querySelectorAll('[id]')).map(e => e.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('page workflow reserves then clicks once, and cancels before click if stopped', async () => {
  const submitted = await pageWorkflow();
  assert.equal(submitted.clicks, 1, JSON.stringify(submitted.actions));
  assert.ok(submitted.actions.includes('cloneClicked'));
  const cancelled = await pageWorkflow({ cancelOnReserve: true });
  assert.equal(cancelled.clicks, 0);
});

test('new minimum interval accepts 3 and 9 seconds and rejects malformed input', () => {
  assert.equal(C.options({ ...config, interval: 3 }).interval, 3);
  assert.equal(C.options({ ...config, interval: 9 }).interval, 9);
  for (const value of [0, 2, -1, 3.1, 'bad', '', Infinity]) assert.throws(() => C.options({ ...config, interval: value }));
});

test('completed rounds count once and continue increasing across worker restarts', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  await w.send('cloneRoundComplete', { id: 'job-1', roundId: 'round-a' });
  await w.send('cloneRoundComplete', { id: 'job-1', roundId: 'round-a' });
  assert.equal(store.cloneMonitorJob.round, 1);
  await worker(store).send('cloneRoundComplete', { id: 'job-1', roundId: 'round-b' });
  assert.equal(store.cloneMonitorJob.round, 2);
});

test('old webpage scripts cannot silently run against the new worker', async () => {
  const store = { cloneMonitorJob: watching() };
  const response = await worker(store).send('cloneJob');
  assert.equal(response.success, false);
  assert.equal(store.cloneMonitorJob.phase, 'error');
  assert.match(store.cloneMonitorJob.message, /刷新/);
});

test('losing inventory before any submission continues polling without a create click', async () => {
  const result = await pageWorkflow({ lostOnSelect: true });
  assert.equal(result.clicks, 0);
  assert.equal(result.actions.includes('cloneReserve'), false);
  assert.equal(result.actions.includes('cloneError'), false);
  assert.ok(result.reloadScheduled);
});

test('pre-click reservation release is attempt-scoped and cannot release clicked requests', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  assert.equal((await w.send('cloneAbortBeforeClick', { id: 'job-1', attemptId: 'wrong' })).success, false);
  assert.equal((await w.send('cloneAbortBeforeClick', { id: 'job-1', attemptId: permit.attemptId })).success, true);
  assert.equal(store.cloneMonitorJob.phase, 'watching');
  const next = await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneClicked', { id: 'job-1', attemptId: next.attemptId });
  assert.equal((await w.send('cloneAbortBeforeClick', { id: 'job-1', attemptId: next.attemptId })).success, false);
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
});

test('new submission errors are retained without unlocking an ambiguous billable request', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
  await w.send('cloneSubmissionNotice', { id: 'job-1', attemptId: permit.attemptId, notice: '测试：GPU资源发生变化' });
  assert.equal(store.cloneMonitorJob.lastSubmissionNotice, '测试：GPU资源发生变化');
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
  assert.equal((await w.send('cloneReserve', { id: 'job-1', selected })).success, false);
});
test('no stock schedules refresh; changed checkout total fails closed', async () => {
  const empty = await pageWorkflow({ available: 0 });
  assert.equal(empty.reloadScheduled, true);
  assert.equal(empty.clicks, 0);
  const changed = await pageWorkflow({ quoted: 4.5 });
  assert.ok(changed.actions.includes('cloneError'));
  assert.equal(changed.actions.includes('cloneReserve'), false);
  assert.equal(changed.clicks, 0);
});

const cudaNotice = '镜像的CUDA版本高于主机支持的最高CUDA版本，将导致无法开机，请重新选择主机/镜像';
const stockNotice = 'GPU库存发生变更，请刷新后重新选择';

test('CUDA comparisons use major/minor versions and preserve unknown values', () => {
  assert.equal(C.cudaCompatible('12.8', '12.4'), false);
  assert.equal(C.cudaCompatible('12.8', '13.0'), true);
  assert.equal(C.cudaCompatible('12.10', '12.9'), false);
  assert.equal(C.cudaCompatible('13.0', '13.0'), true);
  assert.equal(C.cudaCompatible('12.8', null), null);
  assert.equal(C.cudaCompatible(null, '12.4'), null);
  assert.equal(C.eligible({ ...machine, cuda: '12.4' }, config, '12.8'), false);
  assert.equal(C.cudaRejected(cudaNotice), true);
  assert.equal(C.stockRejected(stockNotice), true);
  assert.equal(C.stockRejected('请求超时，GPU库存发生变更，请刷新后重新选择'), false);
  assert.equal(C.stockRejected('GPU资源发生变化'), false);
});

test('page skips known incompatible, excluded and cooling-down hosts before a billable click', async () => {
  for (const options of [{ imageCuda: '12.8', hostCuda: '12.4' }, { excludedHosts: ['host123'] },
    { hostCooldowns: { host123: Date.now() + 30000 } }]) {
    const result = await pageWorkflow(options);
    assert.equal(result.clicks, 0);
    assert.equal(result.actions.includes('cloneReserve'), false);
    assert.equal(result.actions.includes('cloneError'), false);
  }
  assert.equal((await pageWorkflow({ imageCuda: '12.8', hostCuda: '13.0' })).clicks, 1);
});

test('page captures plain Element UI notifications and resumes only exact stock rejection', async () => {
  const rejected = await pageWorkflow({ notice: stockNotice });
  assert.equal(rejected.clicks, 1);
  assert.ok(rejected.actions.includes('cloneSubmissionRejected'));
  assert.equal(rejected.requests.find(r => r.action === 'cloneSubmissionRejected').reason, 'stock');
  assert.equal(rejected.job.phase, 'watching');
  const unknown = await pageWorkflow({ notice: '订单处理异常，请联系管理员\n请求编号：example' });
  assert.equal(unknown.clicks, 1);
  assert.equal(unknown.actions.includes('cloneSubmissionRejected'), false);
  assert.equal(unknown.job.phase, 'submitted');
  const feedback = unknown.requests.find(r => r.action === 'cloneSubmissionNotice');
  assert.equal(feedback.notice, '订单处理异常，请联系管理员\n请求编号：example');
  assert.equal(feedback.noticeKind, 'notification');
});

test('CUDA modal reselects and resumes; unknown modal is recorded without pressing its button', async () => {
  const rejected = await pageWorkflow({ notice: cudaNotice, noticeKind: 'dialog' });
  assert.equal(rejected.reselects, 1);
  assert.equal(rejected.job.phase, 'watching');
  assert.equal(rejected.requests.find(r => r.action === 'cloneSubmissionRejected').reason, 'cuda');
  const unknown = await pageWorkflow({ notice: '需要额外确认费用', noticeKind: 'dialog' });
  assert.equal(unknown.reselects, 0);
  assert.equal(unknown.job.phase, 'submitted');
  assert.equal(unknown.requests.find(r => r.action === 'cloneSubmissionNotice').notice, '需要额外确认费用');
});

test('worker whitelists attempt-scoped rejections, persists CUDA exclusions and stock cooldowns', async () => {
  for (const reason of ['cuda', 'stock']) {
    const store = { cloneMonitorJob: watching() };
    const w = worker(store);
    const permit = await w.send('cloneReserve', { id: 'job-1', selected });
    await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
    const request = { id: 'job-1', adapterVersion: C.VERSION, attemptId: permit.attemptId,
      candidateId: selected.id, reason, notice: reason === 'cuda' ? cudaNotice : stockNotice };
    assert.equal((await w.send('cloneSubmissionRejected', { ...request, attemptId: 'stale' })).success, false);
    assert.equal((await w.send('cloneSubmissionRejected', { ...request, notice: '未知错误' })).success, false);
    assert.equal((await w.send('cloneSubmissionRejected', request, 8)).success, false);
    assert.equal((await w.send('cloneSubmissionRejected', request)).success, true);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
    assert.equal(store.cloneMonitorJob.attemptId, null);
    if (reason === 'cuda') assert.ok(store.cloneMonitorJob.excludedHosts.includes(selected.id));
    else assert.ok(store.cloneMonitorJob.hostCooldowns[selected.id] > Date.now());
    assert.equal((await worker(store).send('cloneReserve', { id: 'job-1', selected })).success, false);
    const next = await w.send('cloneReserve', { id: 'job-1', selected: { ...selected, id: 'another-host' } });
    assert.equal(next.success, true);
    assert.equal(store.cloneMonitorJob.lastSubmissionNotice, null, 'new attempt must not display a prior rejection as current feedback');
    assert.equal((await w.send('cloneSubmissionRejected', request)).success, false);
    assert.equal(store.cloneMonitorJob.attemptId, next.attemptId);
  }
});

test('unknown submission feedback is persisted with full bounded text and attempt provenance', async () => {
  const store = { cloneMonitorJob: watching() }, w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
  const notice = '尚未适配的提示：\n' + '排查内容'.repeat(300);
  await w.send('cloneSubmissionNotice', { id: 'job-1', attemptId: permit.attemptId, notice, noticeKind: 'dialog' });
  const exported = await w.send('diagnosticRead');
  const record = exported.log.entries.find(e => e.event === 'submit.feedback');
  assert.equal(record.details.notice, notice);
  assert.equal(record.details.attemptId, permit.attemptId);
  assert.equal(record.details.candidateId, selected.id);
  assert.equal(record.details.noticeKind, 'dialog');
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
});

test('late unknown feedback is observed and old identical toasts cannot hide fresh stock rejection', async () => {
  const late = await pageWorkflow();
  await late.emitNotice('延迟返回的新错误：example', 'dialog');
  assert.equal(late.requests.find(r => r.action === 'cloneSubmissionNotice').notice, '延迟返回的新错误：example');
  assert.equal(late.job.phase, 'submitted');
  const old = await pageWorkflow({ preexistingNotice: stockNotice });
  assert.equal(old.actions.includes('cloneSubmissionRejected'), false);
  const fresh = await pageWorkflow({ preexistingNotice: stockNotice, notice: stockNotice });
  assert.ok(fresh.actions.includes('cloneSubmissionRejected'));
});

test('stock cooldown expires but an observed new instance or unknown rejection never unlocks a request', async () => {
  const store = { cloneMonitorJob: { ...watching(), hostCooldowns: { [selected.id]: Date.now() - 1 } } };
  const w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  assert.equal(permit.success, true);
  await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
  const request = { id: 'job-1', adapterVersion: C.VERSION, attemptId: permit.attemptId,
    candidateId: selected.id, reason: 'stock', notice: stockNotice };
  store.cloneMonitorJob.newInstanceId = 'already-created';
  assert.equal((await w.send('cloneSubmissionRejected', request)).success, false);
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
  delete store.cloneMonitorJob.newInstanceId;
  assert.equal((await w.send('cloneSubmissionRejected', { ...request, adapterVersion: 'old' })).success, false);
  assert.equal((await w.send('cloneSubmissionRejected', { ...request, reason: 'unknown' })).success, false);
});

test('expansion input and source byte units are validated without treating GB as total disk size', () => {
  assert.equal(C.sourceExpansion(url.replace('expand_size=0', `expand_size=${50 * 1024 ** 3}`)), 50);
  for (const value of ['50', '-1', 'abc', '9007199254740993']) {
    assert.throws(() => C.sourceExpansion(url.replace('expand_size=0', `expand_size=${value}`)));
  }
  assert.equal(C.options({ ...config, expandGB: 50 }).expandGB, 50);
  for (const value of ['', ' ', false, null, -1, 1.5, Infinity, 'x', 9007199254740992]) assert.throws(() => C.options({ ...config, expandGB: value }));
  for (const capacity of [0, 49, 50, null, undefined, NaN]) {
    assert.equal(C.eligible({ ...machine, expandableGB: capacity }, { ...config, expandGB: 50 }), false);
  }
  assert.equal(C.eligible({ ...machine, expandableGB: 51 }, { ...config, expandGB: 50 }), true);
});

test('expansion is applied after host selection and daily fee remains separate from hourly cap', async () => {
  const result = await pageWorkflow({ expandGB: 50, sourceGB: 50, expandableGB: 100 });
  assert.equal(result.clicks, 1, JSON.stringify(result.actions));
  assert.deepEqual(result.uiEvents, ['select-host', 'expand-toggle', 'input-50']);
  const selected = result.requests.find(r => r.action === 'cloneReserve').selected;
  assert.equal(selected.expandGB, 50);
  assert.equal(selected.expandableGB, 100);
  assert.equal(selected.dailyQuote, 2.5);
  assert.equal(selected.total, 3.96);
  const quote = result.requests.find(r => r.action === 'cloneDiagnostic' && r.event === 'price.check');
  assert.equal(quote.details.expandGB, 50);
  assert.equal(quote.details.dailyQuote, 2.5);
});

test('insufficient disk capacity, changing capacity, disabled range and clamped values cannot create', async () => {
  for (const opts of [{ expandableGB: 50 }, { expandableGB: 49 }, { lostCapacity: true }, { diskMax: 10 }, { clampDisk: true }]) {
    const result = await pageWorkflow({ expandGB: 50, ...opts });
    assert.equal(result.clicks, 0, JSON.stringify(opts));
    assert.equal(result.actions.includes('cloneReserve'), false, JSON.stringify(result.actions));
  }
  const changed = await pageWorkflow({ expandGB: 50, changeDailyOnReserve: true });
  assert.equal(changed.clicks, 0);
  assert.ok(changed.actions.some(a => a.includes('日常费用发生变化')));
});

test('background independently rejects unauthorized expansion quantities, capacity and missing daily fee', async () => {
  for (const delta of [{ expandGB: 49 }, { expandableGB: 50 }, { dailyQuote: NaN }, { dailyQuote: -1 }]) {
    const job = watching(); job.config.expandGB = 50;
    const store = { cloneMonitorJob: job }, w = worker(store);
    const result = await w.send('cloneReserve', { id: 'job-1', selected: { ...selected, expandGB: 50, expandableGB: 100, dailyQuote: 2.5, ...delta } });
    assert.equal(result.success, false);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
  }
  const job = watching(); job.config.expandGB = 50;
  assert.equal((await worker({ cloneMonitorJob: job }).send('cloneReserve', {
    id: 'job-1', selected: { ...selected, expandGB: 50, expandableGB: 100, dailyQuote: 2.5 }
  })).success, true);
});

test('start refuses an expansion smaller than source and accepts an explicit sufficient quantity', async () => {
  const expandedUrl = url.replace('expand_size=0', `expand_size=${50 * 1024 ** 3}`);
  const ctx = { ...C.context(expandedUrl), adapterVersion: C.VERSION, models: ['RTX 4090'], regionName: '重庆A区' };
  const store = {};
  const w = worker(store, [{ id: 'source-abc', status: '已关机', region: '重庆A区' }], ctx);
  const rejected = await w.send('cloneStart', { tabId: 7, config: { ...config, expandGB: 49 } });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /源实例已扩容 50 GB/);
  assert.equal(store.cloneMonitorJob, undefined);
  const accepted = await w.send('cloneStart', { tabId: 7, config: { ...config, expandGB: 50 } });
  assert.equal(accepted.success, true);
  assert.equal(store.cloneMonitorJob.config.expandGB, 50);
});
