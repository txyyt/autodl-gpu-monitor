/* Persistent one-shot submission and status tracking; imported by background.js. */
importScripts('clone-core.js', 'diagnostics.js');
const diagnosticLog = createDiagnosticLogger(chrome.storage.local, CloneCore.VERSION);
diagnosticLog.append('extension.boot');
const CLONE_JOB_KEY = 'cloneMonitorJob';
let cloneQueue = Promise.resolve();
const cloneWait = ms => new Promise(resolve => setTimeout(resolve, ms));
const readCloneJob = async () => (await chrome.storage.local.get(CLONE_JOB_KEY))[CLONE_JOB_KEY];
async function saveCloneJob(job) {
  await chrome.storage.local.set({ [CLONE_JOB_KEY]: { ...job, updatedAt: Date.now() } });
  await diagnosticLog.append('job.state', { jobId: job.id, sourceId: job.context?.sourceId,
    region: job.context?.region, pageVersion: job.context?.adapterVersion,
    phase: job.phase, stage: job.stage, round: job.round, message: job.message,
    createdAt: job.createdAt, lastSubmissionNotice: job.lastSubmissionNotice, attemptId: job.attemptId,
    candidateId: job.selected?.id, candidateName: job.selected?.name, imageCuda: job.context?.imageCuda,
    expandGB: job.config?.expandGB, expandableGB: job.selected?.expandableGB, dailyQuote: job.selected?.dailyQuote },
    ['error', 'uncertain'].includes(job.phase) ? 'error' : 'info');
  const badge = { watching: ['ON', '#13854b'], submitting: ['…', '#2563eb'], submitted: ['…', '#2563eb'],
    error: ['ERR', '#dc2626'], uncertain: ['!', '#b45309'], success: ['OK', '#13854b'] }[job.phase];
  await chrome.action?.setBadgeText({ text: badge?.[0] || '' });
  if (badge) await chrome.action?.setBadgeBackgroundColor({ color: badge[1] });
  await chrome.action?.setTitle({ title: `AutoDL GPU 监控：${job.message}` });
}
async function cloneNotice(title, message) {
  await chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message });
}
async function sendClonePage(tabId, message) {
  const result = await chrome.tabs.sendMessage(tabId, message);
  if (!result?.success) throw new Error(result?.error || '页面未响应，请刷新 AutoDL 页面');
  return result;
}
async function snapshotInstances() {
  const tab = await chrome.tabs.create({ url: 'https://www.autodl.com/console/instance/list', active: false });
  try {
    for (let i = 0; i < 50; i++) {
      await cloneWait(300);
      const live = await chrome.tabs.get(tab.id);
      if (live.status !== 'complete') continue;
      if (!live.url?.startsWith('https://www.autodl.com/console/instance/list')) throw new Error('AutoDL 登录状态已过期');
      try { return (await sendClonePage(tab.id, { action: 'cloneListSnapshot' })).instances; }
      catch (error) { if (i === 49) throw error; }
    }
    throw new Error('实例列表读取超时');
  } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
}
function stopLegacyMonitor() {
  monitoringEnabled = false;
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}
function cloneActive(job) { return job && ['watching', 'submitting', 'submitted'].includes(job.phase); }
async function handleCloneMessage(request, sender) {
  let job = await readCloneJob();
  if (request.action === 'diagnosticRead') return { success: true, log: await diagnosticLog.read(),
    exportedAt: new Date().toISOString(), extensionVersion: CloneCore.VERSION,
    currentJob: cleanDiagnosticDetails({ jobId: job?.id, phase: job?.phase, round: job?.round,
      pageVersion: job?.context?.adapterVersion, sourceId: job?.context?.sourceId,
      message: job?.message, createdAt: job?.createdAt, updatedAt: job?.updatedAt,
      lastSubmissionNotice: job?.lastSubmissionNotice, expandGB: job?.config?.expandGB,
      expandableGB: job?.selected?.expandableGB, dailyQuote: job?.selected?.dailyQuote }) };
  if (request.action === 'diagnosticClear') { await diagnosticLog.clear(); return { success: true }; }
  if (request.action === 'diagnosticPopup') {
    await diagnosticLog.append('popup.open', { popupVersion: request.popupVersion });
    return { success: true };
  }
  if (request.action === 'cloneStatus') return { success: true, job };
  if (request.action === 'cloneStart') {
    await diagnosticLog.append('monitor.start.request', { ...request.config, popupVersion: request.popupVersion });
    if (cloneActive(job)) throw new Error('已有克隆任务，请先停止；已提交的任务需核实后解除锁定');
    if (job?.phase === 'uncertain') throw new Error('上次提交结果未确认，请先核实实例列表并解除提交锁定');
    if (checkInProgress) throw new Error('原开关机操作仍在执行，请稍后再开始克隆');
    const cfg = CloneCore.options(request.config);
    const { context } = await sendClonePage(request.tabId, { action: 'cloneContext' });
    await diagnosticLog.append('page.version', { pageVersion: context.adapterVersion, sourceId: context.sourceId, region: context.region });
    if (context.adapterVersion !== CloneCore.VERSION) throw new Error('AutoDL 页面仍在运行旧版脚本，请刷新克隆页面后重试');
    const requiredExpansionGB = CloneCore.sourceExpansion(context.url);
    if (cfg.expandGB < requiredExpansionGB) throw new Error(`源实例已扩容 ${requiredExpansionGB} GB，目标额外扩容不能小于此值`);
    if (cfg.models.some(model => !context.models.includes(model))) throw new Error('所选 GPU 型号不属于源实例地区');
    stopLegacyMonitor();
    legacyCloneLocked = true;
    let baseline;
    try { baseline = await snapshotInstances(); }
    catch (error) { legacyCloneLocked = false; throw error; }
    const source = baseline.find(instance => instance.id === context.sourceId);
    if (!source || !source.status.includes('已关机') || source.region !== context.regionName) {
      legacyCloneLocked = false;
      if (!source) throw new Error('实例列表中未找到源实例，请核对克隆页面的源实例 ID');
      if (!source.status.includes('已关机')) throw new Error(`源实例尚未关机，读取到的状态：${source.status || '未知'}`);
      if (!source.region) throw new Error('无法从实例列表识别源实例地区，请导出诊断日志并检查实例行格式');
      throw new Error(`源实例地区（${source.region}）与克隆页面地区（${context.regionName}）不一致`);
    }
    stopLegacyMonitor();
    job = { id: crypto.randomUUID(), phase: 'watching', tabId: request.tabId, context,
      config: cfg, baseline: baseline.map(instance => instance.id), createdAt: Date.now(),
      round: 0, message: '监控已开启：正在扫描同地区可用主机' };
    await saveCloneJob(job);
    await chrome.alarms.create('clone-watchdog', { periodInMinutes: 0.5 });
    await sendClonePage(job.tabId, { action: 'cloneRun' });
    return { success: true, job };
  }
  if (request.action === 'cloneStop') {
    if (job) {
      const uncertain = ['submitting', 'submitted', 'uncertain'].includes(job.phase);
      await saveCloneJob({ ...job, phase: uncertain ? 'uncertain' : 'stopped',
        message: uncertain ? '已停止跟踪；可能已提交，请核实控制台后解除锁定' : '已停止，不会创建新实例' });
    }
    return { success: true };
  }
  if (request.action === 'cloneUnlock') {
    if (job && ['uncertain', 'submitted'].includes(job.phase)) {
      await saveCloneJob({ ...job, phase: 'stopped', message: '用户已核实提交结果并解除锁定' });
    }
    return { success: true };
  }
  // Page actions must come from the exact monitored tab and job, never from another instance tab.
  if (!job || job.id !== request.id && request.action !== 'cloneJob' || sender.tab?.id !== job.tabId) {
    return { success: false, error: '不是当前克隆任务' };
  }
  if (request.action === 'cloneJob') {
    if (job.phase === 'watching' && request.adapterVersion !== CloneCore.VERSION) {
      await saveCloneJob({ ...job, phase: 'error', message: '网页脚本版本已更新，请刷新克隆页面后重新开始' });
      return { success: false };
    }
    return { success: true, job };
  }
  if (request.action === 'cloneDiagnostic') {
    if (!['scan.result', 'price.check', 'page.error', 'page.feedback', 'candidate.selected', 'submit.clicked'].includes(request.event)) return { success: false };
    await diagnosticLog.append(request.event, { ...request.details, jobId: job.id, pageVersion: request.adapterVersion },
      request.event === 'page.error' ? 'error' : 'info');
    return { success: true };
  }
  if (request.action === 'clonePermit') return { success: job.phase === 'submitting' && !!request.attemptId && request.attemptId === job.attemptId };
  if (request.action === 'cloneClicked') {
    if (job.phase === 'submitting' && request.attemptId === job.attemptId) await saveCloneJob({ ...job, phase: 'submitted',
      clickedAt: Date.now(), submittedAt: Date.now(), message: job.lastSubmissionNotice ?
        `页面提示：${job.lastSubmissionNotice}；请检查页面，创建结果尚未确认` : '已点击创建，正在核实是否生成新实例' });
    return { success: true };
  }
  if (request.action === 'cloneAbortBeforeClick') {
    if (job.phase !== 'submitting' || !request.attemptId || request.attemptId !== job.attemptId || job.clickedAt) {
      return { success: false, error: '已提交或尝试标识不匹配，不能重试' };
    }
    await saveCloneJob({ ...job, phase: 'watching', selected: null, attemptId: null,
      submittedAt: null, message: '提交前库存变化，继续监控' });
    return { success: true };
  }
  if (request.action === 'cloneSubmissionNotice') {
    if (!request.attemptId || request.attemptId !== job.attemptId || !['submitting', 'submitted'].includes(job.phase)) return { success: false };
    const notice = String(request.notice || '').slice(0, 4000);
    await diagnosticLog.append('submit.feedback', { jobId: job.id, attemptId: job.attemptId,
      noticeKind: request.noticeKind, notice, candidateId: job.selected?.id,
      candidateName: job.selected?.name, imageCuda: job.context.imageCuda, hostCuda: job.selected?.cuda }, 'warn');
    await saveCloneJob({ ...job, lastSubmissionNotice: notice.slice(0, 1000), message: `页面提示：${notice.slice(0, 1000)}；请检查页面，创建结果尚未确认` });
    // This records every message. Only the exact validated rejection handler below may unlock it.
    return { success: true };
  }
  if (request.action === 'cloneSubmissionRejected') {
    const cuda = request.reason === 'cuda' && CloneCore.cudaRejected(request.notice);
    const stock = request.reason === 'stock' && CloneCore.stockRejected(request.notice);
    if (request.adapterVersion !== CloneCore.VERSION || !request.attemptId || request.attemptId !== job.attemptId ||
        !['submitting', 'submitted'].includes(job.phase) || job.newInstanceId ||
        request.candidateId !== job.selected?.id || !cuda && !stock) return { success: false };
    const excludedHosts = [...new Set([...(job.excludedHosts || []), ...(cuda ? [job.selected.id] : [])])];
    if (excludedHosts.length > 1000) return { success: false };
    const hostCooldowns = Object.fromEntries(Object.entries(job.hostCooldowns || {}).filter(([, until]) => until > Date.now()));
    if (stock) hostCooldowns[job.selected.id] = Date.now() + 30000;
    await diagnosticLog.append(`submit.${request.reason}.rejected`, { jobId: job.id, attemptId: job.attemptId, candidateId: job.selected.id,
      notice: request.notice, imageCuda: job.context.imageCuda, hostCuda: job.selected.cuda }, 'warn');
    await saveCloneJob({ ...job, phase: 'watching', excludedHosts, hostCooldowns, selected: null, attemptId: null,
      clickedAt: null, submittedAt: null, lastSubmissionNotice: String(request.notice).slice(0, 1000),
      message: cuda ? '页面明确拒绝：目标主机 CUDA 不兼容，已跳过，继续监控' : '页面明确拒绝：GPU 库存发生变更，继续监控（该主机暂避 30 秒）' });
    return { success: true };
  }
  if (request.action === 'cloneError') {
    if (cloneActive(job)) {
      const uncertain = ['submitting', 'submitted'].includes(job.phase);
      await saveCloneJob({ ...job, phase: uncertain ? 'uncertain' : 'error', message: request.message });
      await cloneNotice('AutoDL 克隆监控已停止', request.message);
    }
    return { success: true };
  }
  if (job.phase !== 'watching') return { success: false, error: '任务已停止或已提交' };
  if (request.action === 'cloneRoundComplete') {
    if (!request.roundId) return { success: false };
    if (job.lastRoundId !== request.roundId) await saveCloneJob({ ...job,
      round: (Number.isInteger(job.round) ? job.round : 0) + 1, lastRoundId: request.roundId });
  } else if (request.action === 'cloneProgress') {
    await saveCloneJob({ ...job, message: request.message, stage: request.stage,
      nextCheckAt: request.nextCheckAt || null });
  } else if (request.action === 'cloneReserve') {
    if (job.config.preview === true) throw new Error('旧版预览任务需要重新启动');
    if (!request.selected?.id || !job.config.models.includes(request.selected.model) ||
        (job.excludedHosts || []).includes(request.selected.id) ||
        job.hostCooldowns?.[request.selected.id] > Date.now() ||
        CloneCore.cudaCompatible(job.context.imageCuda, request.selected.cuda) === false ||
        !CloneCore.expansionFits(request.selected, job.config.expandGB || 0) ||
        (request.selected.expandGB || 0) !== (job.config.expandGB || 0) ||
        job.config.expandGB > 0 && (!Number.isFinite(request.selected.dailyQuote) || request.selected.dailyQuote < 0) ||
        !Number.isFinite(request.selected.total) || !Number.isFinite(request.selected.price) ||
        request.selected.total > job.config.maxPrice || request.selected.total <= 0 ||
        Math.abs(request.selected.total - request.selected.price * job.config.count) > 0.011) throw new Error('提交参数不符合限制');
    const attemptId = crypto.randomUUID();
    await saveCloneJob({ ...job, phase: 'submitting', selected: request.selected, attemptId, clickedAt: null,
      submittedAt: Date.now(), lastSubmissionNotice: null, nextCheckAt: null, message: '正在提交创建请求' });
    return { success: true, attemptId };
  }
  return { success: true };
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  const actions = ['cloneStatus', 'cloneStart', 'cloneStop', 'cloneUnlock', 'cloneJob', 'clonePermit',
    'cloneProgress', 'cloneRoundComplete', 'cloneReserve', 'cloneClicked', 'cloneError',
    'cloneAbortBeforeClick', 'cloneSubmissionNotice', 'cloneSubmissionRejected', 'cloneDiagnostic',
    'diagnosticRead', 'diagnosticClear', 'diagnosticPopup'];
  if (!actions.includes(request.action)) return false;
  // Serialize reserve, stop and progress mutations, including across different tabs.
  cloneQueue = cloneQueue.then(() => handleCloneMessage(request, sender))
    .then(respond, async error => {
      await diagnosticLog.append('worker.error', { reason: request.action, pageVersion: request.adapterVersion,
        popupVersion: request.popupVersion, message: error.message }, 'error');
      respond({ success: false, error: error.message });
    });
  return true;
});
let cloneTracking = false;
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'clone-watchdog' || cloneTracking) return;
  cloneTracking = true;
  try {
    let job = await readCloneJob();
    if (!cloneActive(job)) { await chrome.alarms.clear('clone-watchdog'); return; }
    if (job.phase === 'watching') {
      const tab = await chrome.tabs.get(job.tabId).catch(() => null);
      if (!tab || tab.url !== job.context.url) {
        cloneQueue = cloneQueue.then(async () => {
          const latest = await readCloneJob();
          if (latest?.id === job.id && latest.phase === 'watching') await saveCloneJob({ ...latest,
            phase: 'error', message: '监控页面关闭、退出登录或克隆参数改变，已停止' });
        });
      }
      return;
    }
    const instances = await snapshotInstances();
    const matches = instances.filter(instance => !job.baseline.includes(instance.id) &&
      instance.region === job.context.regionName && instance.host === job.selected.name &&
      CloneCore.normalize(instance.spec).startsWith(`${job.selected.model} * ${job.config.count}卡`));
    await diagnosticLog.append('tracking.snapshot', { jobId: job.id, rows: instances.length,
      candidateId: job.selected.id, candidateName: job.selected.name,
      message: `匹配新实例 ${matches.length} 个`, newInstanceId: matches.length === 1 ? matches[0].id : undefined });
    cloneQueue = cloneQueue.then(async () => {
      const latest = await readCloneJob();
      if (latest?.id !== job.id || latest.attemptId !== job.attemptId || !['submitting', 'submitted'].includes(latest.phase)) return;
      if (matches.length === 1) {
        const instance = matches[0];
        if (instance.status.includes('运行中') && !instance.status.includes('无卡')) {
          await saveCloneJob({ ...latest, phase: 'success', newInstanceId: instance.id,
            message: `克隆实例 ${instance.id} 已带 GPU 运行，监控结束` });
          await cloneNotice('AutoDL 克隆开机成功', `${instance.host}，新实例 ${instance.id}`);
          await sendEmailNotification({ instanceName: `${instance.host} / ${instance.id}`,
            host: instance.host, instanceId: instance.id, spec: instance.spec });
        } else if (/失败|异常/.test(instance.status)) {
          await saveCloneJob({ ...latest, phase: 'uncertain', message: `新实例 ${instance.id} 状态：${instance.status}，请检查；不会重复创建` });
        } else await saveCloneJob({ ...latest, phase: 'submitted', newInstanceId: instance.id,
          message: `新实例 ${instance.id}：${instance.status}；等待 GPU 运行` });
      } else if (Date.now() - latest.submittedAt > 20 * 60 * 1000 || matches.length > 1) {
        await saveCloneJob({ ...latest, phase: 'uncertain', message: '未能唯一确认新实例；请检查控制台后解除锁定，不会自动重试' });
        await cloneNotice('AutoDL 克隆结果需要核实', '请查看控制台，提交已锁定，不会重复创建');
      }
    });
    await cloneQueue;
  } catch (error) {
    await diagnosticLog.append('tracking.error', { message: error.message }, 'error');
    console.error('克隆状态核实失败，将继续只读核实：', error.message);
  }
  finally { cloneTracking = false; }
});
