/**
 * AuditService.gs — 操作稽核（AuditLogs 僅新增，不可修改／刪除）
 * 注意：audit_ 在 Repo_ 的 Lock 區段內被呼叫，因此本身不再取鎖。
 */

function audit_(ctx, entityType, entityId, action, before, after, result) {
  try {
    var sh = sheet_('AuditLogs');
    var headers = headersOf_('AuditLogs');
    var rec = {
      log_id: uuid_(),
      timestamp: nowStr_(),
      actor_id: (ctx && ctx.user && ctx.user.email) || (ctx && ctx.actor) || 'system',
      entity_type: entityType,
      entity_id: entityId || '',
      action_type: action,
      before_json: before ? truncJson_(before) : '',
      after_json: after ? truncJson_(after) : '',
      request_id: (ctx && ctx.requestId) || '',
      result: result || 'SUCCESS',
      row_version: 1,
      is_deleted: false
    };
    sh.appendRow(headers.map(function (h) {
      var v = rec[h];
      return (typeof v === 'string') ? guardFormula_(v) : v;
    }));
    invalidate_('AuditLogs');
  } catch (e) {
    console.error('Audit 寫入失敗：' + e.message); // 稽核失敗不應吞掉主操作錯誤，但也不中斷已完成的寫入
  }
}

function auditDenied_(actor, table, action) {
  audit_({ actor: actor || 'anonymous' }, table, '', 'DENIED', null, { attempted: action }, 'FAILED');
}

function truncJson_(o) {
  var s = JSON.stringify(o);
  return s.length > 40000 ? s.substring(0, 40000) + '…(truncated)' : s;
}

function getAuditLogs_(filters) {
  filters = filters || {};
  var rows = Repo_.list('AuditLogs', {
    where: function (r) {
      if (filters.entityType && r.entity_type !== filters.entityType) return false;
      if (filters.entityId && r.entity_id !== filters.entityId) return false;
      if (filters.actor && r.actor_id !== filters.actor) return false;
      if (filters.from && r.timestamp < filters.from) return false;
      if (filters.to && r.timestamp.substring(0, 10) > filters.to) return false;
      return true;
    }
  });
  rows.sort(function (a, b) { return a.timestamp < b.timestamp ? 1 : -1; });
  return rows.slice(0, Math.min(Number(filters.limit) || 200, 1000));
}
