/* Shared validation for clone monitoring. No account credentials are read here. */
(function (root) {
  'use strict';
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  function context(url) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://www.autodl.com' || parsed.pathname !== '/cloneInstance') {
      throw new Error('请先从已关机的源实例进入“克隆实例”页面');
    }
    const sourceId = parsed.searchParams.get('id');
    const region = parsed.searchParams.get('region');
    if (!sourceId || !region || parsed.searchParams.get('copy_data_disk') !== '1') {
      throw new Error('缺少源实例、地区或数据盘复制参数；请重新进入克隆流程并勾选数据盘');
    }
    if (!/^[\w-]+$/.test(sourceId) || !/^[\w-]+$/.test(region)) throw new Error('源实例或地区参数格式不正确');
    return { sourceId, region, url: parsed.href };
  }
  function options(input) {
    const models = [...new Set((input.models || []).map(normalize).filter(Boolean))];
    const count = Number(input.count);
    const maxPrice = Number(input.maxPrice);
    const interval = Number(input.interval);
    const expandGB = input.expandGB === undefined ? 0 : Number(input.expandGB);
    if (!models.length || models.some(m => m === '全部' || m === 'CPU')) throw new Error('请选择至少一种 GPU 型号');
    if (![1, 2, 3, 4, 5, 6, 7, 8, 10, 12].includes(count)) throw new Error('GPU 数量不正确');
    if (!Number.isFinite(maxPrice) || maxPrice <= 0 || Math.abs(maxPrice * 100 - Math.round(maxPrice * 100)) > 1e-6) throw new Error('价格上限必须大于 0，最多两位小数');
    if (!Number.isInteger(interval) || interval < 3 || interval > 3600) throw new Error('检查间隔必须为 3–3600 秒的整数');
    if (typeof input.expandGB === 'string' && !input.expandGB.trim() || input.expandGB === null ||
        typeof input.expandGB === 'boolean' || !Number.isSafeInteger(expandGB) || expandGB < 0) throw new Error('数据盘扩容大小必须为非负整数 GB；不扩容请填 0');
    return { models, count, maxPrice, interval, expandGB };
  }
  function sourceExpansion(url) {
    const raw = new URL(url).searchParams.get('expand_size') || '0';
    const bytes = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes % (1024 ** 3) !== 0) {
      throw new Error('无法准确读取源实例扩容大小，请核对克隆页面参数');
    }
    return bytes / (1024 ** 3);
  }
  function expansionFits(machine, expandGB = 0) {
    return expandGB === 0 || Number.isFinite(machine.expandableGB) && machine.expandableGB > expandGB;
  }
  function money(text) {
    const match = normalize(text).match(/[￥¥]\s*([\d,]+(?:\.\d+)?)/);
    return match ? Number(match[1].replace(/,/g, '')) : NaN;
  }
  function hourlyQuote(root) {
    const labels = Array.from(root.querySelectorAll('.sum .pay-mode')).filter(e =>
      normalize(e.textContent).replace(/[:：]/g, '') === '配置费用');
    if (labels.length !== 1) throw new Error('无法唯一确认“配置费用”，请等待页面报价加载');
    const row = labels[0].parentElement;
    const unit = normalize(row.querySelector('.unit')?.textContent);
    if (!/^\/\s*(?:时|小时)$/.test(unit)) throw new Error('配置费用不是小时价，已停止');
    const amount = normalize(row.querySelector('.num')?.textContent).replace(/,/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error('页面配置费用尚未就绪');
    return Number(amount);
  }
  function cudaVersion(value) {
    const match = normalize(value).match(/^(\d{1,2})\.(\d{1,2})(?:\.\d+)?$/);
    return match ? [Number(match[1]), Number(match[2])] : null;
  }
  function dailyQuote(root) {
    const labels = Array.from(root.querySelectorAll('.sum .pay-mode')).filter(e =>
      normalize(e.textContent).replace(/[:：]/g, '') === '日常费用');
    if (labels.length !== 1) throw new Error('无法唯一确认数据盘日常费用，请等待页面报价加载');
    const row = labels[0].parentElement;
    if (!/^\/\s*(?:日|天)$/.test(normalize(row.querySelector('.unit')?.textContent))) throw new Error('数据盘费用单位不是元/日');
    const raw = normalize(row.querySelector('.num')?.textContent).replace(/,/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('数据盘日常费用尚未就绪');
    return Number(raw);
  }
  function cudaCompatible(required, supported) {
    const need = cudaVersion(required), have = cudaVersion(supported);
    if (!need || !have) return null;
    return have[0] > need[0] || have[0] === need[0] && have[1] >= need[1];
  }
  function cudaRejected(notice) {
    return /镜像的?\s*CUDA\s*版本高于主机支持的最高\s*CUDA\s*版本/.test(normalize(notice)) &&
      /无法开机/.test(notice) && /重新选择主机\s*[/／]\s*镜像/.test(notice);
  }
  function stockRejected(notice) {
    return /^(?:错误\s*)?GPU库存发生变更[，,]\s*请刷新后重新选择[。.!！]?$/.test(normalize(notice));
  }
  function eligible(machine, config, imageCuda) {
    return !!machine.id && config.models.includes(normalize(machine.model)) &&
      Number.isInteger(machine.available) && machine.available >= config.count &&
      machine.enabled === true && Number.isFinite(machine.price) && machine.price > 0 &&
      Math.round(machine.price * 100) * config.count <= Math.round(config.maxPrice * 100) &&
      expansionFits(machine, config.expandGB || 0) &&
      cudaCompatible(imageCuda, machine.cuda) !== false;
  }
  function assertContext(actual, expected) {
    if (actual.sourceId !== expected.sourceId || actual.region !== expected.region || actual.url !== expected.url) {
      throw new Error('源实例、地区或克隆页面参数发生变化，已停止');
    }
  }
  const api = { VERSION: '1.1.8', normalize, context, options, sourceExpansion, expansionFits, money, hourlyQuote, dailyQuote, cudaVersion, cudaCompatible, cudaRejected, stockRejected, eligible, assertContext };
  root.CloneCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
