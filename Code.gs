/**
 * Code.gs — Web App 入口與公開 API
 *
 * 前端以 google.script.run 呼叫本檔「不帶底線」的函式。
 * Apps Script 規則：名稱以 _ 結尾的函式無法從前端呼叫，因此所有內部函式皆以 _ 結尾。
 * 每個公開函式都經過 handle_()：辨識使用者 → 授權 → 執行 → 統一回傳 {ok, data | error, requestId}。
 */

function doGet() {
  var t = HtmlService.createTemplateFromFile('Index');
  t.appName = APP.FULL_NAME;
  return t.evaluate()
    .setTitle('YearEnd PMO｜企業尾牙專案管理系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** HTML 範本 include（伺服器端 scriptlet 使用） */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function handle_(fn, perm) {
  var requestId = uuid_();
  try {
    var user = currentUser_();
    if (perm) authorize_(user, perm[0], perm[1]);
    var data = fn({ user: user, requestId: requestId });
    return JSON.parse(JSON.stringify({ ok: true, data: data, requestId: requestId })); // 確保可序列化
  } catch (e) {
    var code = e.appCode || 'SERVER_ERROR';
    if (!e.appCode) console.error(e.stack || e);
    return { ok: false, error: { code: code, message: e.appCode ? e.message : '伺服器錯誤：' + e.message, details: e.details || null }, requestId: requestId };
  }
}

function assertProject_(projectId) {
  var id = projectId || APP.DEFAULT_PROJECT_ID;
  if (!/^[A-Za-z0-9._\-]+$/.test(id)) throw appError_('VALIDATION', '專案編號格式錯誤');
  return id;
}

function assertTable_(table, allowAudit) {
  if (CRUD_TABLES.indexOf(table) < 0 && !(allowAudit && table === 'AuditLogs')) throw appError_('BAD_TABLE', '不允許的資料表：' + table);
  return table;
}

/* ===================== Bootstrap ===================== */

/** 前端啟動時呼叫：使用者、權限、專案清單、Schema 與列舉 */
function getBootstrap() {
  return handle_(function (ctx) {
    var schema = {};
    CRUD_TABLES.concat(['AuditLogs']).forEach(function (t) {
      schema[t] = { label: TABLES[t].label, code: TABLES[t].code, key: TABLES[t].key, immutable: !!TABLES[t].immutable,
        fields: schemaOf_(t).map(function (f) { return { name: f.name, type: f.type, enumKey: f.arg, required: f.required, system: !!f.system, label: LABELS[f.name] || f.name }; }) };
    });
    var res = can_(ctx.user, 'read', 'Resources') ? Repo_.list('Resources').map(function (r) { return { id: r.resource_id, name: r.name, role: r.role }; }) : [];
    return {
      app: { name: APP.FULL_NAME, version: APP.VERSION, tz: APP.TZ, currency: APP.CURRENCY },
      user: { email: ctx.user.email, name: ctx.user.display_name, role: ctx.user.role, resourceId: ctx.user.resource_id },
      permissions: permissionSummary_(ctx.user),
      projects: Repo_.list('Projects').map(function (p) { return { id: p.project_id, name: p.project_name, status: p.project_status }; }),
      defaultProjectId: APP.DEFAULT_PROJECT_ID,
      schema: schema, enums: ENUMS, resources: res
    };
  });
}

/* ===================== Dashboard ===================== */

function getDashboardData(projectId, filters) {
  return handle_(function (ctx) { return computeDashboard_(assertProject_(projectId), filters || {}, ctx.user); }, ['read', 'WBS']);
}

/* ===================== Generic CRUD ===================== */

function listRecords(table, projectId, filters) {
  return handle_(function (ctx) {
    assertTable_(table, true);
    authorize_(ctx.user, 'read', table);
    if (table === 'AuditLogs') return getAuditLogs_(filters || {});
    var opts = { projectId: projectId ? assertProject_(projectId) : null, includeDeleted: !!(filters && filters.includeDeleted && ctx.user.role === 'Admin') };
    var rows = Repo_.list(table, opts);
    if (table === 'WBS') rows = wbsRollup_(rows).rows.map(function (r) { r.effective_status = effectiveStatus_(r, todayStr_()); return r; });
    return rows;
  });
}

function createRecord(table, payload) {
  return handle_(function (ctx) { return saveRecord_(ctx, assertTable_(table), null, payload); });
}

function updateRecord(table, id, payload) {
  return handle_(function (ctx) { return saveRecord_(ctx, assertTable_(table), String(id), payload); });
}

function deleteRecord(table, id, rowVersion) {
  return handle_(function (ctx) { return deleteRecord_(ctx, assertTable_(table), String(id), rowVersion); });
}

function restoreRecord(table, id) {
  return handle_(function (ctx) { assertTable_(table); authorize_(ctx.user, 'admin', '*'); return Repo_.restore(table, String(id), ctx); });
}

/* ===================== Spec F2 named methods ===================== */

function getProjects() { return listRecords('Projects'); }
function getWbs(projectId) { return listRecords('WBS', projectId); }
function createWbs(payload) { return createRecord('WBS', payload); }
function updateWbs(id, payload) { return updateRecord('WBS', id, payload); }
function deleteWbs(id, rowVersion) { return deleteRecord('WBS', id, rowVersion); }
function getMilestones(projectId) { return listRecords('Milestones', projectId); }
function updateMilestone(id, payload) { return updateRecord('Milestones', id, payload); }
function getResources(projectId) { return listRecords('Resources', projectId); }
function getRaci(projectId) { return listRecords('RACI', projectId); }
function getCosts(projectId) { return listRecords('Costs', projectId); }
function getIssues(projectId, filters) { return listRecords('Issues', projectId, filters); }
function createIssue(payload) { return createRecord('Issues', payload); }
function updateIssue(id, payload) { return updateRecord('Issues', id, payload); }
function getRisks(projectId) { return listRecords('Risks', projectId); }
function createRisk(payload) { return createRecord('Risks', payload); }
function getRequirements(projectId) { return listRecords('Requirements', projectId); }
function getMeetings(projectId) { return listRecords('Communications', projectId); }
function createMeeting(payload) { return createRecord('Communications', payload); }
function getAcceptanceChecklist(projectId) { return listRecords('Acceptance', projectId); }
function updateAcceptance(id, payload) { return updateRecord('Acceptance', id, payload); }
function getDocuments(projectId) { return listRecords('Documents', projectId); }
function getWeeklyPerformance(projectId) { return listRecords('WeeklySnapshots', projectId); }
function getAuditLogs(filters) { return listRecords('AuditLogs', null, filters); }

function submitChangeRequest(payload) {
  payload = payload || {};
  payload.implementation_status = 'Submitted';
  return createRecord('Changes', payload);
}

/** decision：'Approved' | 'Rejected'（需 approve:Changes 權限；流程須先經 Impact Analysis） */
function approveChangeRequest(id, decision, rowVersion) {
  return handle_(function (ctx) {
    if (['Approved', 'Rejected'].indexOf(decision) < 0) throw appError_('VALIDATION', 'decision 必須是 Approved 或 Rejected');
    authorize_(ctx.user, 'approve', 'Changes');
    return saveRecord_(ctx, 'Changes', String(id), { implementation_status: decision, row_version: rowVersion });
  });
}

function getTraceabilityMatrix(projectId) {
  return handle_(function () {
    var pid = assertProject_(projectId);
    var reqs = Repo_.list('Requirements', { projectId: pid });
    var wbs = Repo_.list('WBS', { projectId: pid });
    var acc = Repo_.list('Acceptance', { projectId: pid });
    var wbsById = {}; wbs.forEach(function (w) { wbsById[w.wbs_id] = w; });
    var rows = reqs.map(function (r) {
      var w = splitIds_(r.linked_wbs_ids), dlv = splitIds_(r.linked_deliverable_ids), tests = splitIds_(r.linked_test_ids);
      return { requirement_id: r.requirement_id, description: r.requirement_description, status: r.status,
        wbs: w.map(function (id) { return wbsById[id] ? wbsById[id].wbs_code + ' ' + wbsById[id].task_name : id + '（不存在）'; }),
        deliverables: dlv, acceptance: acc.filter(function (a) { return tests.indexOf(a.acceptance_id) >= 0; }).map(function (a) { return { id: a.acceptance_id, item: a.acceptance_item, result: a.result }; }),
        gap: !dlv.length ? '缺少交付成果' : !tests.length ? '缺少驗收' : '' };
    });
    var covered = {}; reqs.forEach(function (r) { splitIds_(r.linked_deliverable_ids).concat(splitIds_(r.linked_wbs_ids)).forEach(function (id) { covered[id] = true; }); });
    var orphanDeliverables = wbs.filter(function (w) { return w.deliverable && Number(w.level) >= 3 && !covered[w.wbs_id]; })
      .map(function (w) { return { id: w.wbs_id, code: w.wbs_code, deliverable: w.deliverable }; });
    return { rows: rows, coveragePct: reqs.length ? round_(rows.filter(function (r) { return !r.gap; }).length / reqs.length * 100, 1) : null, orphanDeliverables: orphanDeliverables };
  }, ['read', 'Requirements']);
}

function createWeeklySnapshot(projectId) {
  return handle_(function (ctx) { return createWeeklySnapshot_(ctx, assertProject_(projectId)); });
}

function approveBaseline(projectId, version) {
  return handle_(function (ctx) { return approveWbsBaseline_(ctx, assertProject_(projectId), version); });
}

function convertRiskToIssue(riskId) {
  return handle_(function (ctx) { return convertRiskToIssue_(ctx, String(riskId)); });
}

/** 健康檢查：部署後驗證身分、權限與資料庫連線 */
function healthCheck() {
  return handle_(function (ctx) {
    var counts = {};
    Object.keys(TABLES).forEach(function (t) { counts[t] = readTable_(t).rows.length; });
    return { user: ctx.user.email, role: ctx.user.role, spreadsheetName: ss_().getName(), rowCounts: counts, serverTime: nowStr_() };
  });
}
