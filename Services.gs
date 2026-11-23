/**
 * Services.gs — 領域規則（WBS、里程碑、成本、問題、風險、變更、快照、設定）
 * 每張表可註冊 beforeSave(rec, before, ctx) 進行商業規則驗證與衍生欄位計算。
 * 所有規則都在後端執行；前端驗證僅為使用者體驗。
 */

/* ---------------- Settings ---------------- */

var SETTINGS_CACHE_ = null;

function settings_() {
  if (SETTINGS_CACHE_) return SETTINGS_CACHE_;
  var map = {};
  Repo_.list('Settings').forEach(function (r) { map[r.setting_key] = r.setting_value; });
  var json = function (k, d) { try { return map[k] ? JSON.parse(map[k]) : d; } catch (e) { return d; } };
  var numv = function (k, d) { var n = Number(map[k]); return isFinite(n) && map[k] !== '' ? n : d; };
  SETTINGS_CACHE_ = {
    raw: map,
    timezone: map.TIMEZONE || APP.TZ,
    currency: map.CURRENCY || APP.CURRENCY,
    calendar: { workdays: json('WORKDAYS', [1, 2, 3, 4, 5]), holidays: json('HOLIDAYS', []) },
    highRiskScore: numv('RISK_HIGH_SCORE', 15),
    mediumRiskScore: numv('RISK_MEDIUM_SCORE', 8),
    schedYellow: numv('HEALTH_SCHEDULE_YELLOW_PCT', -5),
    schedRed: numv('HEALTH_SCHEDULE_RED_PCT', -15),
    costYellow: numv('HEALTH_COST_YELLOW_PCT', 5),
    costRed: numv('HEALTH_COST_RED_PCT', 10),
    msDelayRed: numv('HEALTH_MILESTONE_DELAY_RED_DAYS', 3),
    highRiskYellowCount: numv('HEALTH_HIGH_RISK_YELLOW_COUNT', 1),
    upcomingDays: numv('UPCOMING_WINDOW_DAYS', 14),
    issueSlaDays: json('ISSUE_SLA_DAYS', { Critical: 1, High: 3, Medium: 7, Low: 14 }),
    statusDateOverride: map.STATUS_DATE_OVERRIDE || ''
  };
  return SETTINGS_CACHE_;
}

/* ---------------- Hooks registry ---------------- */

var HOOKS_ = {
  WBS: { beforeSave: wbsBeforeSave_ },
  Risks: { beforeSave: riskBeforeSave_ },
  Issues: { beforeSave: issueBeforeSave_ },
  Milestones: { beforeSave: milestoneBeforeSave_ },
  Costs: { beforeSave: costBeforeSave_ },
  RACI: { beforeSave: raciBeforeSave_ },
  Changes: { beforeSave: changeBeforeSave_ },
  Acceptance: { beforeSave: acceptanceBeforeSave_ },
  Users: { beforeSave: userBeforeSave_ },
  Projects: { beforeSave: projectBeforeSave_ }
};

/** 泛用儲存入口：權限 → 規則 → Repo */
function saveRecord_(ctx, table, id, payload) {
  if (CRUD_TABLES.indexOf(table) < 0) throw appError_('BAD_TABLE', '不允許的資料表：' + table);
  authorize_(ctx.user, 'write', table);
  payload = payload || {};
  var before = id ? Repo_.get(table, id) : null;
  if (id && !before) throw appError_('NOT_FOUND', '找不到資料：' + id);
  if (id && isBlank_(payload.row_version)) throw appError_('VALIDATION', '缺少 row_version，無法確認資料版本（請重新整理後再編輯）');
  var merged = {};
  if (before) for (var k in before) merged[k] = before[k];
  for (var k2 in payload) merged[k2] = payload[k2];
  if (!id && TABLES[table].cols.indexOf('project_id:') >= 0 && isBlank_(merged.project_id)) merged.project_id = APP.DEFAULT_PROJECT_ID;
  var hook = HOOKS_[table] && HOOKS_[table].beforeSave;
  if (hook) hook(merged, before, ctx);
  // 只把 payload 欄位與 hook 衍生欄位寫回（不覆寫未變更欄位）
  if (id) return Repo_.update(table, id, merged, ctx);
  return Repo_.create(table, merged, ctx);
}

function deleteRecord_(ctx, table, id, rowVersion) {
  if (CRUD_TABLES.indexOf(table) < 0) throw appError_('BAD_TABLE', '不允許的資料表：' + table);
  authorize_(ctx.user, 'delete', table);
  if (table === 'WBS') {
    var kids = Repo_.list('WBS', { where: function (r) { return r.parent_wbs_id === id; } });
    if (kids.length) throw appError_('VALIDATION', '此 WBS 仍有 ' + kids.length + ' 個子項目，請先刪除或移動子項目。');
    var dependents = Repo_.list('WBS', { where: function (r) { return splitIds_(r.dependency_ids).indexOf(id) >= 0; } });
    if (dependents.length) throw appError_('VALIDATION', '下列工作依賴此項目：' + dependents.map(function (d) { return d.wbs_code; }).join(', '));
    var w = Repo_.get('WBS', id);
    if (w && w.approved_at) throw appError_('BASELINE_LOCKED', '已核准基準的工作包不可直接刪除，請提出變更請求。');
  }
  if (table === 'Users' && Repo_.get('Users', id) && Repo_.get('Users', id).email === ctx.user.email) {
    throw appError_('VALIDATION', '不能刪除自己的帳號。');
  }
  return Repo_.softDelete(table, id, rowVersion, ctx);
}

/* ---------------- Projects ---------------- */

function projectBeforeSave_(r) {
  if (r.start_date && r.planned_end_date && diffDays_(r.start_date, r.planned_end_date) < 0) {
    throw appError_('VALIDATION', '計畫完成日不可早於開始日');
  }
}

/* ---------------- WBS ---------------- */

function wbsBeforeSave_(r, before, ctx) {
  var all = Repo_.list('WBS', { projectId: r.project_id });
  var byId = {}; all.forEach(function (w) { byId[w.wbs_id] = w; });

  // 階層
  if (r.parent_wbs_id) {
    var p = byId[r.parent_wbs_id];
    if (!p) throw appError_('VALIDATION', '上層 WBS 不存在：' + r.parent_wbs_id);
    if (r.wbs_id && r.parent_wbs_id === r.wbs_id) throw appError_('VALIDATION', 'WBS 不可以自己為上層');
    r.level = Number(p.level) + 1;
    // 防止把父層掛到自己的子孫底下
    var cur = p, guard = 0;
    while (cur && guard++ < 50) {
      if (r.wbs_id && cur.wbs_id === r.wbs_id) throw appError_('VALIDATION', '上層設定會造成循環階層');
      cur = byId[cur.parent_wbs_id];
    }
  } else if (isBlank_(r.level)) { r.level = 1; }
  if (r.level > 6) throw appError_('VALIDATION', 'WBS 最多 6 層');

  // 日期與工期
  if (r.planned_start_date && r.planned_end_date) {
    var dd = diffDays_(r.planned_start_date, r.planned_end_date);
    if (dd < 0) throw appError_('VALIDATION', '計畫完成日不可早於計畫開始日');
    r.duration_days = workingDaysBetween_(r.planned_start_date, r.planned_end_date, settings_().calendar);
  }
  if (r.actual_start_date && r.actual_end_date && diffDays_(r.actual_start_date, r.actual_end_date) < 0) {
    throw appError_('VALIDATION', '實際完成日不可早於實際開始日');
  }
  var today = todayStr_();
  ['actual_start_date', 'actual_end_date'].forEach(function (f) {
    if (r[f] && diffDays_(today, r[f]) > 0) throw appError_('VALIDATION', LABELS[f] + '不可是未來日期（實績只能依實際紀錄填寫）');
  });

  // 實際完成：需 confirmActual 權限；完成時進度 = 100
  var actualChanged = !before ? !!r.actual_end_date : (r.actual_end_date !== before.actual_end_date);
  if (actualChanged && r.actual_end_date) {
    authorize_(ctx.user, 'confirmActual', 'WBS');
    r.percent_complete = 100;
    r.status = 'Completed';
  }
  if (r.status === 'Completed' && !r.actual_end_date) {
    throw appError_('VALIDATION', '狀態設為 Completed 時必須填寫實際完成日（由有權限者確認）');
  }
  if (r.actual_end_date && r.status !== 'Completed') r.status = 'Completed';
  if (r.percent_complete !== '' && r.percent_complete !== null && Number(r.percent_complete) > 0 && !r.actual_start_date
      && (!before || Number(before.percent_complete || 0) === 0)) {
    // 有進度但沒有實際開始日：要求補填，避免 Actual 曲線缺漏
    throw appError_('VALIDATION', '填寫完成率前請先填寫實際開始日');
  }
  if (Number(r.percent_complete) === 100 && !r.actual_end_date) {
    throw appError_('VALIDATION', '完成率 100% 需同時填寫實際完成日');
  }
  if (!isBlank_(r.task_weight) && Number(r.task_weight) < 0) throw appError_('VALIDATION', '權重不可為負數');

  // 相依：存在性與循環檢查（DFS）
  var deps = splitIds_(r.dependency_ids);
  deps.forEach(function (d) {
    if (!byId[d]) throw appError_('VALIDATION', '前置工作不存在：' + d);
    if (d === r.wbs_id) throw appError_('VALIDATION', '工作不可依賴自己');
  });
  if (r.wbs_id && deps.length) {
    var graph = {}; all.forEach(function (w) { graph[w.wbs_id] = splitIds_(w.dependency_ids); });
    graph[r.wbs_id] = deps;
    var visiting = {}, done = {};
    var dfs = function (n) {
      if (visiting[n]) throw appError_('VALIDATION', '前置工作設定形成循環相依（含 ' + (byId[n] ? byId[n].wbs_code : n) + '）');
      if (done[n]) return;
      visiting[n] = true;
      (graph[n] || []).forEach(dfs);
      visiting[n] = false; done[n] = true;
    };
    dfs(r.wbs_id);
  }

  // 基準鎖定
  if (before && before.approved_at) {
    WBS_BASELINE_FIELDS.forEach(function (f) {
      if (String(r[f] === undefined ? '' : r[f]) !== String(before[f] === undefined ? '' : before[f]) && !ctx.baselineChange) {
        throw appError_('BASELINE_LOCKED', '「' + (LABELS[f] || f) + '」屬於已核准基準（' + before.baseline_version + '），需透過核准的變更請求修改。');
      }
    });
    if (r.approved_at !== before.approved_at && !ctx.baselineChange) throw appError_('BASELINE_LOCKED', '核准時間不可直接修改');
  } else if (!ctx.baselineChange) {
    r.approved_at = before ? before.approved_at : '';
  }

  // 衍生狀態：已過計畫完成日且未完成 → Delayed（Blocked / Cancelled 保持不變）
  if (r.status !== 'Completed' && r.status !== 'Blocked' && r.status !== 'Cancelled' && r.planned_end_date
      && diffDays_(r.planned_end_date, today) > 0) {
    r.status = 'Delayed';
  }
}

/** 依 Parent = Σ(Child% × w) / Σw 計算整棵樹（只聚合葉節點，避免重複計算） */
function wbsRollup_(rows) {
  var byId = {}, kids = {};
  rows.forEach(function (r) { byId[r.wbs_id] = r; kids[r.wbs_id] = []; });
  rows.forEach(function (r) { if (r.parent_wbs_id && kids[r.parent_wbs_id]) kids[r.parent_wbs_id].push(r.wbs_id); });
  var leaves = rows.filter(function (r) { return kids[r.wbs_id].length === 0 && r.status !== 'Cancelled'; });
  var anyWeight = leaves.some(function (l) { return num_(l.task_weight) > 0; });
  var weightOf = function (l) { return anyWeight ? (num_(l.task_weight) || 0) : 1; };
  var memo = {};
  var calc = function (id) {
    if (memo[id]) return memo[id];
    var r = byId[id], ch = kids[id];
    var res;
    if (!ch.length) {
      res = r.status === 'Cancelled' ? { w: 0, ew: 0 } : { w: weightOf(r), ew: weightOf(r) * (num_(r.percent_complete) || 0) / 100 };
    } else {
      res = ch.map(calc).reduce(function (a, b) { return { w: a.w + b.w, ew: a.ew + b.ew }; }, { w: 0, ew: 0 });
    }
    memo[id] = res;
    return res;
  };
  rows.forEach(function (r) {
    var c = calc(r.wbs_id);
    r.rollup_percent = c.w > 0 ? round_(c.ew / c.w * 100, 1) : 0;
    r.rollup_weight = c.w;
    r.is_leaf = kids[r.wbs_id].length === 0;
    r.child_count = kids[r.wbs_id].length;
  });
  return { rows: rows, leaves: leaves, weightOf: weightOf, equalWeights: !anyWeight };
}

/** 核准 WBS 基準：鎖定基準欄位並記錄版本、核准時間 */
function approveWbsBaseline_(ctx, projectId, version) {
  authorize_(ctx.user, 'baseline', 'WBS');
  if (!/^v\d+(\.\d+)?$/.test(version || '')) throw appError_('VALIDATION', '基準版本格式須為 v1、v1.1 …');
  var rows = Repo_.list('WBS', { projectId: projectId });
  var missing = rows.filter(function (r) { return !r.planned_start_date || !r.planned_end_date; });
  if (missing.length) throw appError_('VALIDATION', '仍有 ' + missing.length + ' 個工作缺少計畫日期，無法核准基準');
  var stamp = nowStr_();
  ctx.baselineChange = true;
  rows.forEach(function (r) {
    if (r.approved_at && r.baseline_version === version) return;
    Repo_.update('WBS', r.wbs_id, { baseline_version: version, approved_at: stamp }, ctx, { skipVersion: true, action: 'BASELINE' });
  });
  var proj = Repo_.get('Projects', projectId);
  if (proj) Repo_.update('Projects', projectId, { baseline_version: version }, ctx, { skipVersion: true, action: 'BASELINE' });
  return { version: version, approvedAt: stamp, count: rows.length };
}

/* ---------------- Milestones ---------------- */

function milestoneBeforeSave_(r) {
  if (r.actual_date && diffDays_(todayStr_(), r.actual_date) > 0) throw appError_('VALIDATION', '里程碑實際日不可為未來日期');
  if (r.actual_date) r.status = 'Achieved';
  else if (r.status === 'Achieved') throw appError_('VALIDATION', '狀態 Achieved 需填寫實際達成日');
  splitIds_(r.linked_wbs_ids).forEach(function (id) {
    if (!Repo_.get('WBS', id)) throw appError_('VALIDATION', '關聯 WBS 不存在：' + id);
  });
}

/* ---------------- Costs ---------------- */

function costBeforeSave_(r) {
  if (r.wbs_id && !Repo_.get('WBS', r.wbs_id)) throw appError_('VALIDATION', '關聯 WBS 不存在：' + r.wbs_id);
  if (r.paid_date && !r.actual_amount) throw appError_('VALIDATION', '已填付款日但缺少實際支出金額');
}

/* ---------------- RACI ---------------- */

function raciBeforeSave_(r) {
  if (!Repo_.get('WBS', r.deliverable_id)) throw appError_('VALIDATION', '交付成果（WBS）不存在：' + r.deliverable_id);
  if (!Repo_.get('Resources', r.resource_id)) throw appError_('VALIDATION', '人員不存在：' + r.resource_id);
  if (r.responsibility_type === 'A') {
    var dupA = Repo_.list('RACI', { where: function (x) {
      return x.deliverable_id === r.deliverable_id && x.responsibility_type === 'A' && x.raci_id !== r.raci_id;
    } });
    if (dupA.length) throw appError_('VALIDATION', '每個交付成果只能有一位 A（目前已有 ' + dupA[0].resource_id + '）');
  }
  var same = Repo_.list('RACI', { where: function (x) {
    return x.deliverable_id === r.deliverable_id && x.resource_id === r.resource_id && x.raci_id !== r.raci_id;
  } });
  if (same.length) throw appError_('VALIDATION', '同一人員對同一交付成果只能有一種角色，請直接修改既有紀錄');
}

/* ---------------- Issues ---------------- */

function issueBeforeSave_(r, before) {
  if (!r.created_date) r.created_date = todayStr_();
  if (r.due_date && diffDays_(r.created_date, r.due_date) < 0) throw appError_('VALIDATION', '到期日不可早於建立日');
  if ((r.status === 'Resolved' || r.status === 'Closed')) {
    if (!r.resolved_date) r.resolved_date = todayStr_();
    if (r.status === 'Closed' && isBlank_(r.corrective_action)) throw appError_('VALIDATION', '結案前請填寫矯正措施');
  } else if (before && (before.status === 'Resolved' || before.status === 'Closed')) {
    r.resolved_date = ''; // 重新開啟
  }
  if (r.linked_wbs_id && !Repo_.get('WBS', r.linked_wbs_id)) throw appError_('VALIDATION', '關聯 WBS 不存在');
}

/* ---------------- Risks ---------------- */

function riskBeforeSave_(r) {
  var p = Number(r.probability), i = Number(r.impact);
  if (!(p >= 1 && p <= 5 && i >= 1 && i <= 5 && Math.floor(p) === p && Math.floor(i) === i)) {
    throw appError_('VALIDATION', '機率與影響需為 1–5 的整數');
  }
  var s = settings_();
  r.risk_score = p * i;
  r.severity = r.risk_score >= 20 ? 'Critical' : r.risk_score >= s.highRiskScore ? 'High' : r.risk_score >= s.mediumRiskScore ? 'Medium' : 'Low';
}

/** 風險轉為問題：建立 Issue 並雙向關聯，保留兩筆紀錄 */
function convertRiskToIssue_(ctx, riskId) {
  authorize_(ctx.user, 'write', 'Issues');
  authorize_(ctx.user, 'write', 'Risks');
  var risk = Repo_.get('Risks', riskId);
  if (!risk) throw appError_('NOT_FOUND', '找不到風險：' + riskId);
  if (risk.linked_issue_id) throw appError_('VALIDATION', '此風險已轉為問題：' + risk.linked_issue_id);
  var issue = saveRecord_(ctx, 'Issues', null, {
    project_id: risk.project_id, title: '[由風險轉入] ' + String(risk.risk_description).substring(0, 120),
    description: risk.risk_description, category: 'Other', severity: risk.severity || 'High', priority: 'High',
    owner_id: risk.owner_id, reporter_id: ctx.user.resource_id || '', status: 'Open', created_date: todayStr_(),
    corrective_action: risk.contingency_plan || '', linked_risk_id: risk.risk_id
  });
  Repo_.update('Risks', riskId, { status: 'Occurred', linked_issue_id: issue.issue_id }, ctx, { skipVersion: true });
  return issue;
}

/* ---------------- Changes ---------------- */

var CHANGE_FLOW_ = {
  'Draft': ['Submitted'],
  'Submitted': ['Impact Analysis', 'Rejected'],
  'Impact Analysis': ['Approved', 'Rejected'],
  'Approved': ['Implemented'],
  'Rejected': ['Closed'],
  'Implemented': ['Closed'],
  'Closed': []
};

function changeBeforeSave_(r, before, ctx) {
  if (!r.request_date) r.request_date = todayStr_();
  if (!before) {
    if (['Draft', 'Submitted'].indexOf(r.implementation_status) < 0) r.implementation_status = 'Draft';
    r.decision = 'Pending';
  } else if (r.implementation_status !== before.implementation_status) {
    var allowed = CHANGE_FLOW_[before.implementation_status] || [];
    if (allowed.indexOf(r.implementation_status) < 0) {
      throw appError_('VALIDATION', '流程不允許從「' + before.implementation_status + '」變更為「' + r.implementation_status + '」');
    }
    if (r.implementation_status === 'Approved' || r.implementation_status === 'Rejected') {
      authorize_(ctx.user, 'approve', 'Changes');
      r.decision = r.implementation_status;
      r.approver_id = ctx.user.resource_id || ctx.user.email;
      r.approval_date = todayStr_();
    }
  }
  var hist = [];
  try { hist = before && before.history_json ? JSON.parse(before.history_json) : []; } catch (e) { hist = []; }
  if (!before || r.implementation_status !== before.implementation_status) {
    hist.push({ at: nowStr_(), by: ctx.user.email, status: r.implementation_status });
  }
  r.history_json = JSON.stringify(hist);
}

/* ---------------- Acceptance ---------------- */

function acceptanceBeforeSave_(r) {
  if (r.result !== 'Pending' && !r.actual_review_date) r.actual_review_date = todayStr_();
  if (r.result === 'Passed' && isBlank_(r.evidence_link)) throw appError_('VALIDATION', '驗收通過需附上證據連結');
  if (r.actual_review_date && diffDays_(todayStr_(), r.actual_review_date) > 0) throw appError_('VALIDATION', '實際審查日不可為未來日期');
}

/* ---------------- Users ---------------- */

function userBeforeSave_(r, before) {
  var dup = Repo_.list('Users', { where: function (u) { return u.email === String(r.email).toLowerCase() && u.user_id !== r.user_id; } });
  if (dup.length) throw appError_('DUPLICATE', '此 Email 已有帳號');
  if (!Repo_.get('Roles', r.role)) throw appError_('VALIDATION', '角色不存在：' + r.role);
}

/* ---------------- Weekly Snapshot ---------------- */

/** 產生本週（週五為週結束日）快照；同週已存在則拒絕覆寫 */
function createWeeklySnapshot_(ctx, projectId, weekEnding) {
  authorize_(ctx.user, 'snapshot', 'WeeklySnapshots');
  var today = todayStr_();
  var we = weekEnding || weekEndingOf_(today);
  var exists = Repo_.list('WeeklySnapshots', { projectId: projectId, where: function (s) { return s.week_ending === we; } });
  if (exists.length) throw appError_('DUPLICATE', '週結束日 ' + we + ' 的快照已存在，歷史快照不可覆寫。');
  var d = computeDashboard_(projectId, {}, ctx.user);
  var c = d.wbsStatusCounts;
  return Repo_.create('WeeklySnapshots', {
    snapshot_id: 'SNAP-' + projectId + '-' + we,
    project_id: projectId, week_ending: we, baseline_version: d.project.baseline_version || '',
    planned_percent: d.sCurve.plannedAtStatus, actual_percent: d.kpis.completionPct,
    forecast_percent: d.sCurve.forecastAtStatus,
    completed_task_count: c['Completed'] || 0, in_progress_count: c['In Progress'] || 0, not_started_count: c['Not Started'] || 0,
    delayed_count: c['Delayed'] || 0, blocked_count: c['Blocked'] || 0, overdue_task_count: d.kpis.overdueTasks,
    open_issue_count: d.kpis.openIssues, high_risk_count: d.kpis.highRisks,
    planned_value: d.evm.PV, earned_value: d.evm.EV, actual_cost: d.evm.AC,
    cpi: d.evm.CPI === null ? '' : d.evm.CPI, spi: d.evm.SPI === null ? '' : d.evm.SPI, recorded_at: nowStr_()
  }, ctx);
}

function weekEndingOf_(dateStr) {
  var d = parseDate_(dateStr);
  var dow = Number(Utilities.formatDate(d, APP.TZ, 'u')); // 1..7
  return addDays_(dateStr, (5 - dow + 7) % 7); // 下一個（或當天）週五
}

/** 時間驅動觸發器呼叫（每週五 18:00）。以系統身分執行並寫入稽核 */
function weeklySnapshotJob() {
  var ctx = { user: { email: 'system:weekly-trigger', role: 'Admin', permissions: ['*:*'], resource_id: '' }, requestId: uuid_() };
  Repo_.list('Projects').forEach(function (p) {
    if (['Closed', 'Cancelled'].indexOf(p.project_status) >= 0) return;
    try { createWeeklySnapshot_(ctx, p.project_id); } catch (e) { console.warn(p.project_id + ': ' + e.message); }
  });
}
