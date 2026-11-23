/**
 * Utils.gs — 日期、型別轉換、輸入清理、錯誤物件
 * 所有日期以 Asia/Taipei 計算；日期欄位在 API 層以 'yyyy-MM-dd' 字串傳遞。
 */

function appError_(code, message, details) {
  var e = new Error(message);
  e.appCode = code;
  e.details = details || null;
  return e;
}

function uuid_() { return Utilities.getUuid(); }

function nowStr_() { return Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd HH:mm:ss'); }

function todayStr_() { return Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd'); }

/** 'yyyy-MM-dd' → Date（台北當日中午，避免時區跨日） */
function parseDate_(s) {
  if (s === null || s === undefined || s === '') return null;
  if (Object.prototype.toString.call(s) === '[object Date]') return isNaN(s.getTime()) ? null : s;
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 4, 0, 0)); // 04:00 UTC = 12:00 台北
  if (d.getUTCMonth() !== +m[2] - 1) return null; // 2026-02-31 之類
  return d;
}

function fmtDate_(d) {
  if (!d) return '';
  return Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd');
}

/** 兩日期相差日曆天（b - a） */
function diffDays_(a, b) {
  var da = parseDate_(a), db = parseDate_(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function addDays_(s, n) {
  var d = parseDate_(s);
  if (!d) return '';
  return fmtDate_(new Date(d.getTime() + n * 86400000));
}

/** 工作日判斷：排除週末（依 Settings WORKDAYS）與 Settings HOLIDAYS */
function isWorkday_(s, cal) {
  var d = parseDate_(s);
  if (!d) return false;
  var dow = Number(Utilities.formatDate(d, APP.TZ, 'u')) % 7; // 1=Mon..7=Sun → 0=Sun
  if (cal.workdays.indexOf(dow) < 0) return false;
  return cal.holidays.indexOf(fmtDate_(d)) < 0;
}

/** 計算 a..b（含頭尾）間工作日數 */
function workingDaysBetween_(a, b, cal) {
  var n = diffDays_(a, b);
  if (n === null) return null;
  var sign = n < 0 ? -1 : 1, count = 0;
  for (var i = 0; i <= Math.abs(n); i++) if (isWorkday_(addDays_(a, i * sign), cal)) count++;
  return count * sign;
}

/** 從 s 起算第 n 個工作日（不含 s） */
function addWorkingDays_(s, n, cal) {
  var cur = s, added = 0, guard = 0;
  while (added < n && guard++ < 1000) {
    cur = addDays_(cur, 1);
    if (isWorkday_(cur, cal)) added++;
  }
  return cur;
}

/** 防止試算表公式注入：以 = + - @ \t \r 開頭的文字前置單引號 */
function guardFormula_(s) {
  if (typeof s !== 'string') return s;
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** 讀出時移除防注入前綴 */
function unguard_(s) {
  return (typeof s === 'string' && /^'[=+\-@\t\r]/.test(s)) ? s.substring(1) : s;
}

function cleanText_(v, max) {
  var s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s.length > max) throw appError_('VALIDATION', '文字長度超過上限 ' + max + ' 字');
  return s;
}

function isBlank_(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }

function num_(v) {
  if (isBlank_(v)) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function safeDiv_(a, b) {
  if (a === null || b === null || b === 0 || !isFinite(a) || !isFinite(b)) return null;
  return a / b;
}

function round_(n, d) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  var p = Math.pow(10, d || 0);
  return Math.round(n * p) / p;
}

function splitIds_(v) {
  if (isBlank_(v)) return [];
  return String(v).split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(String);
}

function groupCount_(rows, field, keys) {
  var out = {};
  (keys || []).forEach(function (k) { out[k] = 0; });
  rows.forEach(function (r) { var k = r[field] || '(未設定)'; out[k] = (out[k] || 0) + 1; });
  return out;
}

function sum_(rows, field) {
  return rows.reduce(function (a, r) { return a + (num_(r[field]) || 0); }, 0);
}
