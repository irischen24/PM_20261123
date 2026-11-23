// Minimal Google Apps Script mock to exercise Setup / Repo / Services / Dashboard in Node.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.argv[2];

function makeEnv(opts) {
  const sheets = {};
  let props = {};
  let activeEmail = opts.email || 'admin@example.com';
  const fmt = (d, tz, p) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(d).map(x => [x.type, x.value]));
    const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
    return p.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour === '24' ? '00' : parts.hour).replace('mm', parts.minute).replace('ss', parts.second).replace(/^u$/, String(u));
  };
  function Range(sh, r, c, nr, nc) {
    const ensure = () => { while (sh.data.length < r + nr - 1) sh.data.push([]); };
    return {
      getValues() { ensure(); const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sh.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
      getValue() { return this.getValues()[0][0]; },
      setValues(v) { ensure(); v.forEach((row, i) => row.forEach((x, j) => { sh.data[r - 1 + i][c - 1 + j] = (typeof x === 'string' && x.startsWith("'")) ? x.substring(1) : x; })); return this; },
      setNotes() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
      setNumberFormat() { return this; }, setDataValidation() { return this; },
      protect() { return { setDescription() { return this; }, setWarningOnly() { return this; } }; }
    };
  }
  function Sheet(name) {
    const sh = { name, data: [], maxRows: 1000 };
    Object.assign(sh, {
      getName: () => name,
      getDataRange: () => { const nr = Math.max(1, sh.data.length), nc = Math.max(1, ...sh.data.map(r => r.length)); return Range(sh, 1, 1, nr, nc); },
      getRange: (r, c, nr, nc) => Range(sh, r, c, nr || 1, nc || 1),
      getLastColumn: () => Math.max(0, ...sh.data.map(r => r.length)),
      getLastRow: () => sh.data.length,
      getMaxRows: () => sh.maxRows, insertRowsAfter() {},
      appendRow: row => { sh.data.push(row.map(x => (typeof x === 'string' && x.startsWith("'")) ? x.substring(1) : x)); },
      setFrozenRows() {}, setTabColor() {}, setConditionalFormatRules() {}
    });
    return sh;
  }
  const ss = {
    getId: () => 'SS1', getName: () => 'YearEnd_PMO_2027_Database', getUrl: () => 'https://docs.google.com/spreadsheets/d/SS1',
    getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = Sheet(n)), getSheets: () => Object.values(sheets), deleteSheet() {},
    setSpreadsheetTimeZone() {}, setSpreadsheetLocale() {}
  };
  const dv = () => { const b = new Proxy({}, { get: (t, k) => k === 'build' ? () => ({}) : () => b }); return b; };
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => opts.verbose && console.error(...a) },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => null, create: () => ss, flush() {}, newDataValidation: dv, newConditionalFormatRule: dv },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => activeEmail }), getEffectiveUser: () => ({ getEmail: () => 'admin@example.com' }) },
    Utilities: { formatDate: fmt, getUuid: () => require('crypto').randomUUID() },
    HtmlService: {}, ScriptApp: {},
    Date, JSON, Math, Object, String, Number, Array, Error, isFinite, isNaN, Intl
  };
  vm.createContext(ctx);
  fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort((a, b) => (a === 'Config.gs' ? -1 : b === 'Config.gs' ? 1 : a.localeCompare(b)))
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
  ctx.__setEmail = e => { activeEmail = e; vm.runInContext('USER_CACHE_=null;DB_CACHE_={};SETTINGS_CACHE_=null;', ctx); };
  ctx.__reset = () => vm.runInContext('USER_CACHE_=null;DB_CACHE_={};SETTINGS_CACHE_=null;', ctx);
  ctx.__sheets = sheets;
  return ctx;
}
module.exports = { makeEnv };
