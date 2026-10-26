/* Bounded, allowlisted diagnostics. Never serialize settings, DOM, URLs or credentials. */
(function (root) {
  'use strict';
  const KEY = 'autodlDiagnosticLog';
  const MAX_BYTES = 512 * 1024;
  const fields = new Set(['jobId', 'sourceId', 'region', 'phase', 'stage', 'round', 'message', 'notice',
    'pageVersion', 'popupVersion', 'models', 'selectedModels', 'count', 'maxPrice', 'interval',
    'candidateId', 'candidateName', 'selectedModel', 'available', 'cardPrice', 'hourlyQuote',
    'dailyQuote', 'expectedTotal', 'quoteSource', 'rows', 'clicked', 'stockChanged', 'reason',
    'createdAt', 'updatedAt', 'newInstanceId', 'lastSubmissionNotice', 'imageCuda', 'hostCuda', 'incompatibleHosts',
    'attemptId', 'noticeKind', 'expandGB', 'expandableGB', 'requiredExpansionGB']);
  function redact(value, limit = 700) {
    return String(value)
      .replace(/https?:\/\/[^\s]+/gi, '[URL]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\bSCT[a-zA-Z0-9_-]+/g, '[SendKey]')
      .replace(/((?:password|passwd|token|authorization|api[_ -]?key|sendkey|密码)["']?\s*[:=：]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]')
      .slice(0, limit);
  }
  function clean(input) {
    const output = {};
    for (const [key, value] of Object.entries(input || {})) {
      if (!fields.has(key)) continue;
      if (value === null || typeof value === 'boolean') output[key] = value;
      else if (typeof value === 'number') output[key] = Number.isFinite(value) ? value : null;
      else if (typeof value === 'string') output[key] = redact(value, key === 'notice' ? 4000 : 700);
      else if (Array.isArray(value)) output[key] = value.slice(0, 16).filter(v => typeof v === 'string').map(v => redact(v).slice(0, 100));
    }
    return output;
  }
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function encodeDiagnosticExport(data, limit = MAX_BYTES) {
    const entries = [...data.log.entries];
    const meta = { type: 'metadata', schema: 1, extensionVersion: redact(data.extensionVersion),
      exportedAt: redact(data.exportedAt), maxBytes: limit, dropped: data.log.dropped || 0,
      trimmedForExport: 0, currentJob: clean(data.currentJob) };
    const encode = () => [JSON.stringify(meta), ...entries.map(entry => JSON.stringify(entry))].join('\n') + '\n';
    let output = encode();
    while (entries.length && new TextEncoder().encode(output).length > limit) {
      entries.shift(); meta.trimmedForExport++; output = encode();
    }
    return output;
  }
  function createDiagnosticLogger(storage, version, limit = MAX_BYTES) {
    let queue = Promise.resolve();
    function serial(fn) {
      const pending = queue.then(fn);
      queue = pending.catch(() => {});
      return pending;
    }
    function append(event, details = {}, level = 'info') {
      return serial(async () => {
        const previous = (await storage.get(KEY))[KEY];
        const log = { schema: 1, dropped: Number(previous?.dropped) || 0, entries: [] };
        // Re-sanitize persisted data as well, including after migrations or manual edits.
        log.entries = (Array.isArray(previous?.entries) ? previous.entries : []).slice(-1000).map(entry => ({
          time: redact(entry.time || ''), version: redact(entry.version || ''),
          event: redact(entry.event || '').slice(0, 64), level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
          details: clean(entry.details)
        }));
        log.entries.push({ time: new Date().toISOString(), version, event: redact(event).slice(0, 64),
          level: ['info', 'warn', 'error'].includes(level) ? level : 'info', details: clean(details) });
        while (log.entries.length && (log.entries.length > 1000 || bytes({ [KEY]: log }) > limit)) {
          log.entries.shift(); log.dropped++;
        }
        await storage.set({ [KEY]: log });
      }).catch(error => { console.warn('诊断日志写入失败：', error?.name || 'storage error'); });
    }
    function read() {
      return serial(async () => {
        const value = (await storage.get(KEY))[KEY] || { schema: 1, dropped: 0, entries: [] };
        const entries = (value.entries || []).map(entry => ({ time: redact(entry.time), version: redact(entry.version),
          event: redact(entry.event), level: entry.level, details: clean(entry.details) }));
        return { schema: 1, maxBytes: limit, bytes: bytes({ [KEY]: value }), dropped: value.dropped || 0, entries };
      });
    }
    const clear = () => serial(() => storage.set({ [KEY]: { schema: 1, dropped: 0, entries: [] } }));
    return { append, read, clear };
  }
  root.createDiagnosticLogger = createDiagnosticLogger;
  root.cleanDiagnosticDetails = clean;
  root.encodeDiagnosticExport = encodeDiagnosticExport;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createDiagnosticLogger, encodeDiagnosticExport, clean, KEY, MAX_BYTES, bytes };
})(globalThis);
