/* DOM adapter verified against AutoDL's ordinary-instance clone page. */
(() => {
  'use strict';
  if (window.__autodlCloneAdapter) return;
  window.__autodlCloneAdapter = true;
  const C = CloneCore;
  let busy = false;
  let reloadTimer;
  let retryDelay = 0;
  let submissionObserver;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const text = e => C.normalize(e?.innerText || e?.textContent);
  const rpc = (action, data = {}) => chrome.runtime.sendMessage({ action, adapterVersion: C.VERSION, ...data });
  const inputs = (root, type) => Array.from(root.querySelectorAll(`input[type="${type}"]`));
  function filter(label) {
    const item = Array.from(document.querySelectorAll('.filter-item')).find(e =>
      text(e.querySelector('.filter-label')).replace(/[:：]/g, '') === label);
    if (!item) throw new Error(`找不到“${label}”控件，页面可能已更新`);
    return item;
  }
  function pageContext() {
    const ctx = C.context(location.href);
    if (!text(document.body).includes('克隆实例仅能在同一地区内进行') ||
        !text(document.body).includes(`以实例：${ctx.sourceId}的系统创建新实例`)) {
      throw new Error('无法核实当前页面的源实例和同地区克隆限制');
    }
    const regionItem = filter('选择地区');
    const regions = inputs(regionItem, 'radio');
    const enabled = regions.filter(e => !e.disabled);
    // In the live page, only the source data centre is enabled. Other region groups may be siblings.
    const selected = enabled.filter(e => e.checked);
    if (enabled.length !== 1 || selected.length !== 1) throw new Error('地区未锁定到唯一的源实例地区');
    const models = inputs(filter('GPU型号'), 'checkbox').map(e => e.value).filter(v => !['false', 'CPU'].includes(v));
    if (!models.length) throw new Error('GPU 型号尚未加载，请等待页面加载完成');
    const imageCuda = new URL(location.href).searchParams.get('image_cuda');
    return { ...ctx, requiredExpansionGB: C.sourceExpansion(location.href), imageCuda: C.cudaVersion(imageCuda) ? imageCuda : null,
      adapterVersion: C.VERSION, dataCenter: selected[0].value, regionName: text(selected[0].closest('label')), models };
  }
  function machines() {
    return Array.from(document.querySelectorAll('.el-table__body tr')).flatMap(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      const radio = row.querySelector('input[type="radio"]');
      if (cells.length !== 9 || !radio) return [];
      const free = text(cells[3]).match(/^(\d+)\s*\/\s*(\d+)$/);
      const modelNode = cells[2].querySelector('.cell > div');
      const model = C.normalize((modelNode?.innerHTML || '').split(/<br\s*\/?\s*>/i)[0].replace(/<[^>]+>/g, ''));
      // Ignore struck-through original prices; the first live price span is the payable card price.
      const priceNode = cells[8].querySelector('.price > span:not([style*="line-through"])');
      const cuda = text(cells[7]).match(/CUDA\s*[:：]\s*(\d+\.\d+(?:\.\d+)?)/i)?.[1] || null;
      const capacity = text(cells[6]).match(/可扩容\s*[:：]\s*([\d,]+(?:\.\d+)?)\s*GB/i);
      const expandableGB = capacity ? Number(capacity[1].replace(/,/g, '')) : null;
      return [{ id: radio.value, name: text(cells[1]), model, cuda, expandableGB,
        available: free ? Number(free[1]) : -1, price: C.money(text(priceNode)),
        enabled: !radio.disabled, row, radio }];
    });
  }
  async function current(job) {
    const response = await rpc('cloneJob');
    if (!response?.job || response.job.id !== job.id || response.job.phase !== 'watching') {
      throw new Error('监控已停止或任务已变更');
    }
    const ctx = pageContext();
    C.assertContext(ctx, job.context);
    if (ctx.dataCenter !== job.context.dataCenter) throw new Error('源地区发生变化');
    return ctx;
  }
  async function clickInput(input, job) {
    await current(job);
    if (!input || input.disabled) throw new Error('筛选控件不可用');
    input.closest('label').click();
    await sleep(200);
  }
  function loading() {
    return Array.from(document.querySelectorAll('.el-loading-mask')).some(visible);
  }
  async function settle(job) {
    let previous = '';
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      await current(job);
      const fingerprint = machines().map(m => `${m.id}:${m.available}:${m.price}:${m.expandableGB}`).join('|');
      stable = fingerprint === previous && !loading() ? stable + 1 : 0;
      previous = fingerprint;
      if (stable >= 2) return;
      await sleep(200);
    }
    throw new Error('主机列表加载超时，请检查网络后重新开始');
  }
  async function applyFilters(job) {
    const cfg = job.config;
    const typeInputs = inputs(filter('GPU型号'), 'checkbox').filter(e => e.value !== 'false');
    for (const model of cfg.models) {
      if (!typeInputs.some(e => e.value === model)) throw new Error(`本地区没有型号：${model}`);
    }
    for (const input of typeInputs) {
      if (input.checked !== cfg.models.includes(input.value)) await clickInput(input, job);
    }
    // Trigger AutoDL's native query even when all filters already match. No full document reload.
    const refreshInput = typeInputs.find(input => cfg.models.includes(input.value));
    if (!refreshInput?.checked) throw new Error('GPU 筛选未就绪');
    await clickInput(refreshInput, job);
    await settle(job);
    const refreshedInput = inputs(filter('GPU型号'), 'checkbox').find(input => input.value === refreshInput.value);
    await clickInput(refreshedInput, job);
    const count = inputs(filter('GPU数量'), 'radio').find(e => e.value === String(cfg.count));
    if (!count) throw new Error('页面不支持该 GPU 数量');
    if (!count.checked) await clickInput(count, job);
    const payg = document.querySelector('input[type="radio"][value="payg"]');
    if (!payg) throw new Error('无法确认按量计费');
    if (!payg.checked) await clickInput(payg, job);
    await settle(job);
    const table = Array.from(document.querySelectorAll('.el-table')).find(e => text(e).includes('空闲GPU'));
    const head = Array.from(table?.querySelectorAll('th') || []).find(e => text(e).startsWith('空闲GPU'));
    const descending = head?.querySelector('.sort-caret.descending');
    if (!descending) throw new Error('找不到库存排序控件');
    if (!head.classList.contains('descending')) {
      await current(job);
      descending.click();
      await settle(job);
    }
    if (!head.classList.contains('descending')) throw new Error('未能确认空闲 GPU 降序排列');
    return table;
  }
  async function candidate(job, table) {
    const scroller = table.querySelector('.el-table__body-wrapper');
    let previous = '';
    // AutoDL lazy-loads rows. Search beyond the first ten rows when all early rows are over budget.
    for (let i = 0; i < 200; i++) {
      await current(job);
      const rows = machines();
      const matches = rows.filter(m => !(job.excludedHosts || []).includes(m.id) &&
        !(job.hostCooldowns?.[m.id] > Date.now()) &&
        C.eligible(m, job.config, job.context.imageCuda)).sort((a, b) => a.price - b.price);
      if (matches.length) return matches[0];
      if (rows.length && rows.some(m => m.available >= 0 && m.available < job.config.count)) return null;
      const fingerprint = rows.map(m => m.id).join('|');
      if (!scroller || (i > 0 && fingerprint === previous)) return null;
      previous = fingerprint;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(800);
      await settle(job);
    }
    throw new Error('主机列表超过扫描上限，请缩小 GPU 型号范围');
  }
  async function selectMachine(job, machine) {
    await current(job);
    machine.row.click();
    await settle(job);
    const checked = machines().filter(m => m.radio.checked);
    const fresh = checked.find(m => m.id === machine.id);
    if (checked.length !== 1 || !fresh || !C.eligible(fresh, job.config, job.context.imageCuda)) {
      const error = new Error('候选主机库存已变化，继续等待'); error.stockChanged = true; throw error;
    }
    const count = inputs(filter('GPU数量'), 'radio').find(e => e.checked)?.value;
    if (Number(count) !== job.config.count) throw new Error('GPU 数量发生变化');
    if (!document.querySelector('input[type="radio"][value="payg"]')?.checked) throw new Error('计费模式发生变化');
    await configureDisk(job);
    const afterDisk = machines().find(m => m.id === machine.id && m.radio.checked);
    if (!afterDisk || !C.eligible(afterDisk, job.config, job.context.imageCuda)) {
      const error = new Error('填写扩容期间主机库存或容量变化，继续等待'); error.stockChanged = true; throw error;
    }
    let quoted;
    try { quoted = C.hourlyQuote(document); }
    finally {
      await rpc('cloneDiagnostic', { id: job.id, event: 'price.check', details: {
        hourlyQuote: quoted ?? null, dailyQuote: job.config.expandGB > 0 ? C.dailyQuote(document) : Number(document.querySelector('.sum .daily-cost .num')?.textContent),
        quoteSource: '配置费用', cardPrice: fresh.price, expectedTotal: fresh.price * job.config.count,
        maxPrice: job.config.maxPrice, count: job.config.count, candidateId: fresh.id, selectedModel: fresh.model,
        imageCuda: job.context.imageCuda, hostCuda: fresh.cuda,
        expandGB: job.config.expandGB || 0, expandableGB: afterDisk.expandableGB
      } }).catch(() => {});
    }
    if (quoted > job.config.maxPrice || Math.abs(quoted - fresh.price * job.config.count) > 0.011) {
      throw new Error(`报价核对失败：配置费用 ￥${quoted.toFixed(2)}/小时；单卡 ￥${fresh.price.toFixed(2)} × ${job.config.count}；上限 ￥${job.config.maxPrice.toFixed(2)}/小时`);
    }
    assertDisk(job);
    const daily = job.config.expandGB > 0 ? C.dailyQuote(document) : 0;
    await rpc('cloneProgress', { id: job.id, stage: 'checking',
      message: `已核对：GPU ￥${quoted.toFixed(2)}/小时；扩容 ${job.config.expandGB || 0} GB，数据盘 ￥${daily.toFixed(2)}/日` });
    return { id: fresh.id, name: fresh.name, model: fresh.model, price: fresh.price, total: quoted, cuda: fresh.cuda,
      expandGB: job.config.expandGB || 0, expandableGB: afterDisk.expandableGB, dailyQuote: daily };
  }
  function diskControls() {
    const checks = Array.from(document.querySelectorAll('.needExpand input[type="checkbox"]'));
    const fields = Array.from(document.querySelectorAll('.disk-size input[role="spinbutton"]'));
    if (checks.length > 1 || fields.length > 1) throw new Error('数据盘扩容控件不唯一，请停止并检查页面');
    return { check: checks[0], field: fields[0] };
  }
  function assertDisk(job) {
    const wanted = job.config.expandGB || 0;
    const { check, field } = diskControls();
    if (wanted === 0) {
      if (check?.checked || !check && field && Number(field.value || 0) !== 0) throw new Error('页面存在未授权的数据盘扩容，请取消扩容后重试');
      return;
    }
    if (!check?.checked || !field || field.disabled || field.value.trim() === '' || Number(field.value) !== wanted ||
        !Number.isFinite(Number(field.getAttribute('max'))) || Number(field.getAttribute('max')) < wanted) {
      throw new Error(`数据盘扩容核对失败：必须勾选扩容并准确填写 ${wanted} GB`);
    }
  }
  async function configureDisk(job) {
    const wanted = job.config.expandGB || 0;
    const before = diskControls();
    if (!before.check) {
      if (wanted > 0) throw new Error('找不到“需要扩容”控件，请检查页面');
      return;
    }
    if (before.check.checked !== (wanted > 0)) await clickInput(before.check, job);
    if (wanted === 0) { assertDisk(job); return; }
    await current(job);
    const { field } = diskControls();
    if (!field || field.disabled || !field.hasAttribute('max') || Number(field.getAttribute('max')) < wanted) {
      const error = new Error('目标主机扩容上限不足或输入框未就绪，继续等待'); error.stockChanged = true; throw error;
    }
    field.value = String(wanted);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    let previous = '', stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      await current(job);
      try {
        assertDisk(job);
        const fingerprint = `${C.hourlyQuote(document)}:${C.dailyQuote(document)}`;
        stable = fingerprint === previous && !loading() ? stable + 1 : 0;
        previous = fingerprint;
        if (stable >= 2) return;
      } catch (_) { stable = 0; }
    }
    throw new Error('扩容容量或日常费用未能核对，请检查页面后重试');
  }
  async function run() {
    if (busy || location.pathname !== '/cloneInstance') return;
    busy = true;
    let job, attemptId, clicked = false;
    try {
      const response = await rpc('cloneJob');
      job = response?.job;
      if (!job || job.phase !== 'watching') return;
      submissionObserver?.disconnect();
      if (job.config.preview === true) throw new Error('旧版预览任务已停止，请在新版界面重新开始监控');
      await current(job);
      await rpc('cloneProgress', { id: job.id, message: '正在刷新库存…', stage: 'scanning' });
      const table = await applyFilters(job);
      const found = await candidate(job, table);
      await rpc('cloneDiagnostic', { id: job.id, event: 'scan.result', details: {
        models: job.config.models, selectedModels: inputs(filter('GPU型号'), 'checkbox').filter(e => e.checked).map(e => e.value),
        rows: machines().length, candidateId: found?.id, candidateName: found?.name,
        selectedModel: found?.model, available: found?.available, cardPrice: found?.price,
        imageCuda: job.context.imageCuda, hostCuda: found?.cuda,
        expandGB: job.config.expandGB || 0, expandableGB: found?.expandableGB,
        incompatibleHosts: machines().filter(m => C.cudaCompatible(job.context.imageCuda, m.cuda) === false).map(m => m.name)
      } }).catch(() => {});
      await rpc('cloneRoundComplete', { id: job.id, roundId: crypto.randomUUID() });
      retryDelay = 0;
      if (!found) {
        await schedule(job, job.context.imageCuda ? `等待符合条件的库存（镜像 CUDA ${job.context.imageCuda}，跳过已知不兼容主机）` : '等待符合条件的库存');
        return;
      }
      await rpc('cloneProgress', { id: job.id, message: `发现 ${found.name} ${found.model}，正在核对配置费用`, stage: 'checking' });
      const selected = await selectMachine(job, found);
      await current(job);
      const create = Array.from(document.querySelectorAll('button')).filter(visible)
        .filter(e => text(e) === '创建并开机');
      if (create.length !== 1 || create[0].disabled) throw new Error('创建并开机按钮不可用');
      const blocking = submissionDialogs();
      if (blocking.length) {
        for (const node of blocking) await rpc('cloneDiagnostic', { id: job.id, event: 'page.feedback', details: {
          notice: String((node.querySelector('.el-message-box__message, .el-dialog__body') || node).textContent || '').trim().slice(0, 4000),
          noticeKind: 'dialog', stage: 'before-click', clicked: false
        } }).catch(() => {});
        throw new Error('页面有待处理弹窗，请关闭或处理后重新开始');
      }
      // A durable one-shot barrier is persisted by the background before any billable click.
      const permit = await rpc('cloneReserve', { id: job.id, selected });
      if (!permit?.success) throw new Error(permit?.error || '提交被取消');
      attemptId = permit.attemptId;
      // Recheck the entire selection after awaiting the worker; no automatic confirmation of other dialogs.
      C.assertContext(pageContext(), job.context);
      const fresh = machines().find(m => m.id === selected.id && m.radio.checked);
      if (!fresh || !C.eligible(fresh, job.config, job.context.imageCuda) || C.hourlyQuote(document) !== selected.total) {
        const error = new Error('提交前库存或报价变化，继续监控'); error.stockChanged = true; throw error;
      }
      assertDisk(job);
      if (job.config.expandGB > 0 && C.dailyQuote(document) !== selected.dailyQuote) throw new Error('数据盘日常费用发生变化，已停止提交，请核对');
      const allowed = await rpc('clonePermit', { id: job.id, attemptId });
      if (!allowed?.success) throw new Error('提交已取消');
      const inspectSubmission = observeSubmission(job, attemptId);
      clicked = true;
      create[0].click();
      await rpc('cloneClicked', { id: job.id, attemptId });
      await rpc('cloneDiagnostic', { id: job.id, event: 'submit.clicked', details: {
        candidateId: selected.id, candidateName: selected.name, clicked: true,
        message: '已点击创建按钮，尚未证明订单被接受'
      } }).catch(() => {});
      await inspectSubmission();
      // The next page may show a required confirmation; leave it for the user. Never repeat the click.
    } catch (error) {
      if (!job) return;
      await rpc('cloneDiagnostic', { id: job.id, event: 'page.error', details: {
        message: error.message, stockChanged: !!error.stockChanged, clicked
      } }).catch(() => {});
      if (error.stockChanged && !clicked) {
        const released = !attemptId || (await rpc('cloneAbortBeforeClick', { id: job.id, attemptId })).success;
        if (released) { await schedule(job, error.message); return; }
      }
      if (!attemptId && /列表加载超时/.test(error.message)) {
        retryDelay = Math.min(30000, Math.max(job.config.interval * 1000, retryDelay * 2 || 3000));
        await schedule(job, '库存加载较慢，稍后重试', retryDelay); return;
      }
      await rpc('cloneError', { id: job.id, message: error.message }).catch(() => {});
    } finally { busy = false; }
  }
  async function schedule(job, message, delay = job.config.interval * 1000) {
    await current(job);
    await rpc('cloneProgress', { id: job.id, message, stage: 'waiting', nextCheckAt: Date.now() + delay });
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => run(), delay);
  }
  function submissionDialogs() {
    return Array.from(document.querySelectorAll('.el-message-box, .el-dialog, [role="dialog"]')).filter(visible)
      .filter(node => !Array.from(node.querySelectorAll('.el-message-box, .el-dialog')).some(visible));
  }
  function observeSubmission(job, attemptId) {
    const selector = '.el-message, .el-notification, .el-message--error, .el-notification--error';
    const noticeText = node => {
      const body = node.querySelector('.el-notification__content, .el-message__content, .el-message-box__message, .el-dialog__body') || node;
      return String(body.textContent || body.innerText || '').trim().slice(0, 4000);
    };
    const seen = new Map(Array.from(document.querySelectorAll(selector)).filter(visible).map(node => [node, noticeText(node)]));
    let inspecting = false, inspectAgain = false;
    async function inspect() {
      if (inspecting) { inspectAgain = true; return; }
      inspecting = true;
      try {
      for (const node of [...document.querySelectorAll(selector), ...submissionDialogs()]) {
        if (!visible(node)) { seen.delete(node); continue; }
        const notice = noticeText(node);
        if (!notice || seen.get(node) === notice) continue;
        seen.set(node, notice);
        const noticeKind = node.matches('.el-notification, .el-notification--error') ? 'notification' :
          node.matches('.el-message, .el-message--error') ? 'message' : 'dialog';
        await rpc('cloneSubmissionNotice', { id: job.id, attemptId, notice, noticeKind });
        const reselect = Array.from(node.querySelectorAll('button')).filter(e => visible(e) && !e.disabled && text(e) === '重新选择');
        const reason = C.stockRejected(notice) && noticeKind !== 'dialog' ? 'stock' :
          C.cudaRejected(notice) && reselect.length === 1 ? 'cuda' : null;
        if (!reason) continue;
        // Only this observed, explicit non-creation validation is allowed to release a clicked attempt.
        // Never click a generic confirmation, purchase button or guessed stock-rejection dialog.
        const pending = await rpc('cloneJob');
        if (pending.job?.id !== job.id || pending.job.attemptId !== attemptId ||
            !['submitting', 'submitted'].includes(pending.job.phase)) continue;
        if (reason === 'cuda') {
          reselect[0].click();
          await sleep(200);
          if (visible(node)) continue;
        }
        const result = await rpc('cloneSubmissionRejected', { id: job.id, attemptId, notice, reason, candidateId: pending.job.selected.id });
        if (result.success) {
          observer.disconnect();
          await schedule(job, reason === 'cuda' ? '目标主机 CUDA 不兼容，已跳过，继续监控' : '库存已被占用，刷新后继续监控（该主机暂避 30 秒）');
        }
      }
      } finally {
        inspecting = false;
        if (inspectAgain) {
          inspectAgain = false;
          Promise.resolve().then(inspect).catch(() => {});
        }
      }
    }
    const observer = new MutationObserver(() => { inspect().catch(() => {}); });
    submissionObserver?.disconnect();
    submissionObserver = observer;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
    setTimeout(() => observer.disconnect(), 20 * 60 * 1000);
    return inspect;
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (request.action === 'cloneContext') {
      try { respond({ success: true, context: pageContext() }); }
      catch (error) { respond({ success: false, error: error.message }); }
    } else if (request.action === 'cloneRun') {
      clearTimeout(reloadTimer);
      respond({ success: true });
      run();
    } else if (request.action === 'cloneListSnapshot') {
      listSnapshot().then(result => respond({ success: true, instances: result }))
        .catch(error => respond({ success: false, error: error.message }));
      return true;
    }
    return false;
  });
  async function listSnapshot() {
    if (location.pathname !== '/console/instance/list') throw new Error('不是实例列表页面');
    const result = new Map();
    for (let page = 0; page < 200; page++) {
      let rows;
      for (let attempt = 0; attempt < 40; attempt++) {
        rows = Array.from(document.querySelectorAll('.el-table__body tr'));
        if (rows.length && !loading()) break;
        await sleep(300);
      }
      if (!rows?.length) throw new Error('实例列表未加载或登录已过期');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        const id = text(cells[0]).match(/\b[\w]+-[\w]+\b/)?.[0];
        if (!id) throw new Error('无法读取实例 ID');
        const regionHost = text(cells[0]).match(/^(.+?区)\s*\/\s*(\d+机)/);
        result.set(id, { id, region: regionHost?.[1], host: regionHost?.[2],
          spec: text(cells[2]), status: text(cells[1]) });
      }
      const next = document.querySelector('.el-pagination .btn-next');
      if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return [...result.values()];
      const first = text(rows[0]);
      next.click();
      let changed = false;
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        if (!loading() && text(document.querySelector('.el-table__body tr')) !== first) { changed = true; break; }
      }
      if (!changed) throw new Error('实例列表翻页超时');
    }
    throw new Error('实例列表超过扫描上限');
  }
  // Vue may mount after document_idle. Retry readiness without interacting with the page.
  let attempts = 0;
  const ready = setInterval(() => {
    if (location.pathname !== '/cloneInstance' || ++attempts > 60) { clearInterval(ready); return; }
    try { pageContext(); clearInterval(ready); run(); } catch (_) { /* wait for DOM */ }
  }, 500);
})();
