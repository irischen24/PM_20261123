/**
 * Database.gs — Google Sheets 資料存取層（共用 CRUD Repository）
 *
 * - Spreadsheet ID 只從 Script Properties 讀取，前端無法指定或修改。
 * - 不以列號作為資料 ID；以每表的 key 欄位（UUID 或穩定編碼）辨識。
 * - 寫入時使用 LockService，並以 row_version 做樂觀鎖，避免覆寫他人修改。
 * - 刪除為 Soft Delete（is_deleted = TRUE），可由 Admin 復原。
 */

var DB_CACHE_ = {}; // 單次執行內的讀取快取

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty(APP.PROP_SS_ID);
  if (!id) throw appError_('NOT_CONFIGURED', '尚未設定資料庫。請由 Apps Script 編輯器執行 setupDatabase()。');
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw appError_('DB_UNAVAILABLE', '無法開啟資料庫試算表（ID 錯誤或執行身分無權限）：' + e.message); }
}

function sheet_(table) {
  var sh = ss_().getSheetByName(table);
  if (!sh) throw appError_('DB_SCHEMA', '找不到工作表「' + table + '」，請重新執行 setupDatabase()。');
  return sh;
}

/** 讀取整張表 → { headers, rows:[{...,_row}] }（_row 僅供內部定位，不回傳前端） */
function readTable_(table) {
  if (DB_CACHE_[table]) return DB_CACHE_[table];
  var sh = sheet_(table);
  var values = sh.getDataRange().getValues();
  var headers = (values.shift() || []).map(String);
  var expected = headersOf_(table);
  var missing = expected.filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length) throw appError_('DB_SCHEMA', '工作表「' + table + '」缺少欄位：' + missing.join(', '));
  var fields = schemaOf_(table), fmap = {};
  fields.forEach(function (f) { fmap[f.name] = f; });
  var rows = [];
  values.forEach(function (v, i) {
    if (v.join('') === '') return;
    var o = { _row: i + 2 };
    headers.forEach(function (h, c) { if (fmap[h]) o[h] = fromCell_(v[c], fmap[h]); });
    rows.push(o);
  });
  DB_CACHE_[table] = { headers: headers, rows: rows };
  return DB_CACHE_[table];
}

function invalidate_(table) { delete DB_CACHE_[table]; }

/** 儲存格值 → API 值（Date 轉字串，避免 google.script.run 無法序列化） */
function fromCell_(v, f) {
  if (v === '' || v === null || v === undefined) return (f.type === 'bool') ? false : '';
  var isDate = Object.prototype.toString.call(v) === '[object Date]';
  switch (f.type) {
    case 'date': return isDate ? fmtDate_(v) : String(v).substring(0, 10);
    case 'datetime': return isDate ? Utilities.formatDate(v, APP.TZ, 'yyyy-MM-dd HH:mm:ss') : String(v);
    case 'time': return isDate ? Utilities.formatDate(v, APP.TZ, 'HH:mm') : String(v);
    case 'int': case 'num': case 'money': case 'pct': { var n = Number(v); return isFinite(n) ? n : ''; }
    case 'bool': return v === true || String(v).toUpperCase() === 'TRUE';
    default: return unguard_(isDate ? fmtDate_(v) : String(v));
  }
}

/** API 值 → 儲存格值（含型別驗證與清理）。失敗丟出 VALIDATION */
function toCell_(v, f, table) {
  var label = (LABELS[f.name] || f.name);
  if (isBlank_(v)) {
    if (f.required) throw appError_('VALIDATION', '「' + label + '」為必填欄位');
    return f.type === 'bool' ? false : '';
  }
  switch (f.type) {
    case 'date': {
      var d = parseDate_(v);
      if (!d) throw appError_('VALIDATION', '「' + label + '」日期格式須為 YYYY-MM-DD');
      return d;
    }
    case 'datetime': {
      var s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) throw appError_('VALIDATION', '「' + label + '」格式須為 YYYY-MM-DD HH:mm');
      return s;
    }
    case 'time': {
      var t = String(v).trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw appError_('VALIDATION', '「' + label + '」格式須為 HH:mm');
      return "'" + t; // 保持文字，避免 Sheets 轉成時間序列值
    }
    case 'int': case 'num': case 'money': case 'pct': {
      var n = Number(v);
      if (!isFinite(n)) throw appError_('VALIDATION', '「' + label + '」必須是數字');
      if (f.type === 'int' && Math.floor(n) !== n) throw appError_('VALIDATION', '「' + label + '」必須是整數');
      if (f.type === 'money') { if (n < 0) throw appError_('VALIDATION', '「' + label + '」金額不可為負數'); n = Math.round(n); }
      if (f.type === 'pct' && (n < 0 || n > 100)) throw appError_('VALIDATION', '「' + label + '」需介於 0–100');
      if ((f.name === 'probability' || f.name === 'impact') && (n < 1 || n > 5)) throw appError_('VALIDATION', '「' + label + '」需為 1–5 的整數');
      return n;
    }
    case 'bool': return v === true || String(v).toUpperCase() === 'TRUE';
    case 'enum': {
      var s2 = String(v).trim(), list = ENUMS[f.arg] || [];
      if (list.indexOf(s2) < 0) throw appError_('VALIDATION', '「' + label + '」值不在允許清單：' + s2);
      return s2;
    }
    case 'email': {
      var e = String(v).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw appError_('VALIDATION', '「' + label + '」Email 格式不正確');
      return e;
    }
    case 'url': {
      var u = String(v).trim();
      if (!/^https:\/\/[^\s]+$/i.test(u)) throw appError_('VALIDATION', '「' + label + '」必須是 https:// 開頭的連結');
      return guardFormula_(u);
    }
    case 'id': case 'ref': {
      var id = cleanText_(v, 80);
      if (!/^[A-Za-z0-9._\-]+$/.test(id)) throw appError_('VALIDATION', '「' + label + '」只能包含英數字、點、底線與連字號');
      return id;
    }
    case 'refs': {
      var ids = splitIds_(v);
      ids.forEach(function (x) { if (!/^[A-Za-z0-9._\-]+$/.test(x)) throw appError_('VALIDATION', '「' + label + '」含非法 ID：' + x); });
      return ids.join(',');
    }
    case 'json': {
      var j = typeof v === 'string' ? v : JSON.stringify(v);
      if (j.length > 45000) throw appError_('VALIDATION', '「' + label + '」內容過大');
      return guardFormula_(j);
    }
    case 'text': return guardFormula_(cleanText_(v, APP.MAX_TEXT));
    default: return guardFormula_(cleanText_(v, APP.MAX_STR));
  }
}

function stripInternal_(r) {
  var o = {};
  for (var k in r) if (k !== '_row') o[k] = r[k];
  return o;
}

var Repo_ = {
  /** 查詢：opts.projectId、opts.includeDeleted、opts.where(fn) */
  list: function (table, opts) {
    opts = opts || {};
    var hasProject = headersOf_(table).indexOf('project_id') >= 0;
    return readTable_(table).rows.filter(function (r) {
      if (!opts.includeDeleted && r.is_deleted) return false;
      if (opts.projectId && hasProject && r.project_id && r.project_id !== opts.projectId) return false;
      return opts.where ? opts.where(r) : true;
    }).map(stripInternal_);
  },

  findRaw_: function (table, id) {
    var key = TABLES[table].key;
    var rows = readTable_(table).rows;
    for (var i = 0; i < rows.length; i++) if (String(rows[i][key]) === String(id)) return rows[i];
    return null;
  },

  get: function (table, id) {
    var r = this.findRaw_(table, id);
    return (r && !r.is_deleted) ? stripInternal_(r) : null;
  },

  /** 新增。payload 中未知欄位會被忽略；系統欄位由後端設定 */
  create: function (table, payload, ctx) {
    var def = TABLES[table], key = def.key, fields = schemaOf_(table);
    return withLock_(function () {
      invalidate_(table);
      var rec = {};
      fields.forEach(function (f) { if (!f.system) rec[f.name] = payload[f.name]; });
      if (isBlank_(rec[key])) rec[key] = (def.idPrefix || '') + uuid_();
      if (Repo_.findRaw_(table, rec[key])) throw appError_('DUPLICATE', '資料 ID 已存在：' + rec[key]);
      var now = nowStr_();
      if (fields.some(function (f) { return f.name === 'created_at'; })) rec.created_at = now;
      if (fields.some(function (f) { return f.name === 'updated_at'; })) rec.updated_at = now;
      rec.row_version = 1;
      rec.is_deleted = false;
      var sh = sheet_(table), headers = readTable_(table).headers;
      var fmap = {}; fields.forEach(function (f) { fmap[f.name] = f; });
      var row = headers.map(function (h) {
        if (!fmap[h]) return '';
        if (h === 'row_version' || h === 'is_deleted') return rec[h];
        return toCell_(rec[h], fmap[h], table);
      });
      sh.appendRow(row);
      invalidate_(table);
      var saved = Repo_.get(table, rec[key]);
      audit_(ctx, table, rec[key], 'CREATE', null, saved, 'SUCCESS');
      return saved;
    });
  },

  /** 修改。payload.row_version 必須等於目前版本，否則回傳 CONFLICT */
  update: function (table, id, payload, ctx, opts) {
    opts = opts || {};
    var def = TABLES[table], key = def.key, fields = schemaOf_(table);
    if (def.immutable && !opts.force) throw appError_('IMMUTABLE', '「' + def.label + '」資料建立後不可修改');
    if (def.appendOnly) throw appError_('IMMUTABLE', '稽核紀錄不可修改');
    return withLock_(function () {
      invalidate_(table);
      var raw = Repo_.findRaw_(table, id);
      if (!raw || (raw.is_deleted && !opts.allowDeleted)) throw appError_('NOT_FOUND', '找不到資料：' + id);
      if (!opts.skipVersion) {
        if (isBlank_(payload.row_version)) throw appError_('VALIDATION', '缺少 row_version，無法確認資料版本');
        if (Number(payload.row_version) !== Number(raw.row_version)) {
          throw appError_('CONFLICT', '資料已被其他人修改（目前版本 ' + raw.row_version + '），請重新整理後再編輯。');
        }
      }
      var before = stripInternal_(raw);
      var next = stripInternal_(raw);
      fields.forEach(function (f) {
        if (f.system || f.name === key || f.name === 'created_at') return;
        if (Object.prototype.hasOwnProperty.call(payload, f.name)) next[f.name] = payload[f.name];
      });
      if (fields.some(function (f) { return f.name === 'updated_at'; })) next.updated_at = nowStr_();
      next.row_version = Number(raw.row_version || 0) + 1;
      if (opts.setDeleted !== undefined) next.is_deleted = opts.setDeleted;
      var sh = sheet_(table), headers = readTable_(table).headers;
      var fmap = {}; fields.forEach(function (f) { fmap[f.name] = f; });
      var row = headers.map(function (h) {
        if (!fmap[h]) return sh.getRange(raw._row, headers.indexOf(h) + 1).getValue();
        if (h === 'row_version' || h === 'is_deleted') return next[h];
        return toCell_(next[h], fmap[h], table);
      });
      // 寫入前再次確認目標列 key 未被人工移動（防止有人在 Sheets 手動排序）
      var keyCol = headers.indexOf(key) + 1;
      if (String(sh.getRange(raw._row, keyCol).getValue()) !== String(id)) {
        throw appError_('CONFLICT', '資料列位置已變動，請重新整理後再試。');
      }
      sh.getRange(raw._row, 1, 1, headers.length).setValues([row]);
      invalidate_(table);
      var saved = stripInternal_(Repo_.findRaw_(table, id));
      audit_(ctx, table, id, opts.action || (opts.setDeleted === true ? 'DELETE' : opts.setDeleted === false ? 'RESTORE' : 'UPDATE'),
        before, saved, 'SUCCESS');
      return saved;
    });
  },

  softDelete: function (table, id, rowVersion, ctx) {
    return this.update(table, id, { row_version: rowVersion }, ctx, { setDeleted: true });
  },

  restore: function (table, id, ctx) {
    return this.update(table, id, {}, ctx, { setDeleted: false, allowDeleted: true, skipVersion: true });
  }
};

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.LOCK_WAIT_MS)) throw appError_('BUSY', '系統忙碌中（其他人正在寫入），請稍後再試。');
  try { return fn(); }
  finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}
