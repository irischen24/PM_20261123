/**
 * DashboardService.gs — Dashboard 即時計算（所有 KPI 皆由 Sheets 資料計算，無寫死數值）
 *
 * 計算規則摘要（詳見 README「管理邏輯」）：
 *  - 加權完成率：只聚合葉節點工作包，Σ(完成率 × 權重) / Σ權重；無權重時採等權重並明確標示。
 *  - S-Curve Baseline：葉節點「計畫完成日」到達時累加其權重（步階式）。
 *  - S-Curve Actual：僅以「實際完成日」認列完成權重；無任何實績時不畫線並回傳提示。
 *  - S-Curve Forecast：已完成者用實際完成日；未完成且未逾期者用計畫完成日；
 *    已逾期者以「狀態日 + 剩餘工期（工期 × (1 − 完成率)，至少 1 工作日）」推估。
 *  - EVM：BAC 只含已連結工作包的成本基準（應變準備金不分配至工作包，不計入 PMB）；
 *    PV 依工作包計畫期間線性分配；EV = 工作包預算 × 完成率；AC = 實際支出。
 */

var OPEN_ISSUE_STATUSES = ['Open', 'In Progress', 'Blocked'];

function effectiveStatus_(w, statusDate) {
  if (w.status === 'Cancelled') return 'Cancelled';
  if (w.actual_end_date) return 'Completed';
  if (w.status === 'Blocked') return 'Blocked';
  if (w.planned_end_date && diffDays_(w.planned_end_date, statusDate) > 0) return 'Delayed';
  if (w.actual_start_date || Number(w.percent_complete) > 0 || w.status === 'In Progress') return 'In Progress';
  return 'Not Started';
}

function computeDashboard_(projectId, filters, user) {
  filters = filters || {};
  var s = settings_();
  var project = Repo_.get('Projects', projectId);
  if (!project) throw appError_('NOT_FOUND', '找不到專案：' + projectId);
  var statusDate = filters.statusDate || s.statusDateOverride || todayStr_();
  if (!parseDate_(statusDate)) throw appError_('VALIDATION', '狀態日格式錯誤');

  var resources = Repo_.list('Resources');
  var resName = {}; resources.forEach(function (r) { resName[r.resource_id] = r.name; });

  /* ---------- WBS ---------- */
  var wbsAll = Repo_.list('WBS', { projectId: projectId });
  var roll = wbsRollup_(wbsAll);
  var leaves = roll.leaves;
  leaves.forEach(function (l) {
    l.effective_status = effectiveStatus_(l, statusDate);
    l.overdue_days = (l.effective_status === 'Delayed') ? diffDays_(l.planned_end_date, statusDate) : 0;
  });
  var W = leaves.reduce(function (a, l) { return a + roll.weightOf(l); }, 0);
  var completionPct = W > 0 ? round_(leaves.reduce(function (a, l) {
    return a + roll.weightOf(l) * (num_(l.percent_complete) || 0) / 100; }, 0) / W * 100, 1) : 0;
  var statusCounts = groupCount_(leaves, 'effective_status', ENUMS.WBS_STATUS);
  var overdue = leaves.filter(function (l) { return l.effective_status === 'Delayed' || (l.effective_status === 'Blocked' && l.planned_end_date && diffDays_(l.planned_end_date, statusDate) > 0); });
  var baselineApproved = leaves.length > 0 && leaves.every(function (l) { return !!l.approved_at; });

  /* ---------- S-Curve ---------- */
  var cal = s.calendar;
  var fcDate = function (l) {
    if (l.actual_end_date) return l.actual_end_date;
    if (!l.planned_end_date) return null;
    if (diffDays_(l.planned_end_date, statusDate) <= 0) return l.planned_end_date;
    var remain = Math.max(1, Math.ceil((num_(l.duration_days) || 1) * (1 - (num_(l.percent_complete) || 0) / 100)));
    return addWorkingDays_(statusDate, remain, cal);
  };
  leaves.forEach(function (l) { l.forecast_end = fcDate(l); });
  var plannedEnds = leaves.map(function (l) { return l.planned_end_date; }).filter(String).sort();
  var fcEnds = leaves.map(function (l) { return l.forecast_end; }).filter(Boolean).sort();
  var start = filters.from || project.start_date;
  var endCandidates = [project.planned_end_date, plannedEnds[plannedEnds.length - 1], fcEnds[fcEnds.length - 1]].filter(Boolean).sort();
  var end = filters.to || endCandidates[endCandidates.length - 1];
  var hasActual = leaves.some(function (l) { return !!l.actual_end_date; });
  var cum = function (dateField, d) {
    if (W <= 0) return 0;
    var w = 0;
    leaves.forEach(function (l) { var v = l[dateField]; if (v && v <= d) w += roll.weightOf(l); });
    return round_(w / W * 100, 1);
  };
  var labels = [], base = [], act = [], fc = [];
  var nDays = Math.max(0, diffDays_(start, end) || 0);
  for (var i = 0; i <= nDays && i <= 800; i++) {
    var d = addDays_(start, i);
    labels.push(d);
    base.push(cum('planned_end_date', d));
    act.push(hasActual && d <= statusDate ? cum('actual_end_date', d) : null);
    fc.push(d >= statusDate ? cum('forecast_end', d) : null);
  }
  var plannedAtStatus = cum('planned_end_date', statusDate);
  var actualAtStatus = cum('actual_end_date', statusDate);
  var forecastAtStatus = actualAtStatus;
  var variance = round_(actualAtStatus - plannedAtStatus, 1);
  var forecastFinish = fcEnds[fcEnds.length - 1] || '';
  var plannedFinish = plannedEnds[plannedEnds.length - 1] || '';
  var varianceLevel = variance <= s.schedRed ? 'Critical' : variance <= s.schedYellow ? 'Warning' : 'OK';

  /* ---------- Costs & EVM ---------- */
  var costs = Repo_.list('Costs', { projectId: projectId });
  var wbsById = {}; wbsAll.forEach(function (w) { wbsById[w.wbs_id] = w; });
  var lineForecast = function (c) {
    var f = num_(c.forecast_amount);
    return Math.max(f !== null ? f : (num_(c.baseline_budget) || 0), num_(c.committed_amount) || 0, num_(c.actual_amount) || 0);
  };
  var costBaseline = sum_(costs, 'baseline_budget');
  var committed = sum_(costs, 'committed_amount');
  var actualCost = sum_(costs, 'actual_amount');
  var fac = costs.reduce(function (a, c) { return a + lineForecast(c); }, 0);
  var plannedBudget = num_(project.total_budget) || costBaseline;
  var catMap = {};
  costs.forEach(function (c) {
    var k = c.category || '其他';
    catMap[k] = catMap[k] || { category: k, baseline: 0, committed: 0, actual: 0, forecast: 0 };
    catMap[k].baseline += num_(c.baseline_budget) || 0;
    catMap[k].committed += num_(c.committed_amount) || 0;
    catMap[k].actual += num_(c.actual_amount) || 0;
    catMap[k].forecast += lineForecast(c);
  });
  var breakdown = ENUMS.COST_CATEGORY.filter(function (k) { return catMap[k]; }).map(function (k) { return catMap[k]; });

  var pmbLines = costs.filter(function (c) { return c.wbs_id && wbsById[c.wbs_id]; });
  var BAC = sum_(pmbLines, 'baseline_budget');
  var plannedFraction = function (w, d) {
    if (!w.planned_start_date || !w.planned_end_date) return 0;
    if (d < w.planned_start_date) return 0;
    if (d >= w.planned_end_date) return 1;
    var total = diffDays_(w.planned_start_date, w.planned_end_date) + 1;
    return (diffDays_(w.planned_start_date, d) + 1) / total;
  };
  var PV = 0, EV = 0;
  pmbLines.forEach(function (c) {
    var w = wbsById[c.wbs_id], b = num_(c.baseline_budget) || 0;
    PV += b * plannedFraction(w, statusDate);
    EV += b * (num_(w.rollup_percent) || 0) / 100;
  });
  PV = Math.round(PV); EV = Math.round(EV);
  var AC = actualCost;
  var CPI = AC > 0 ? round_(safeDiv_(EV, AC), 2) : null;
  var SPI = PV > 0 ? round_(safeDiv_(EV, PV), 2) : null;
  var EAC = (CPI && CPI > 0) ? Math.round(BAC / CPI) : null;
  var evm = {
    baselineApproved: baselineApproved, BAC: BAC, PV: PV, EV: EV, AC: AC, CPI: CPI, SPI: SPI,
    CV: AC > 0 || EV > 0 ? EV - AC : null, SV: PV > 0 || EV > 0 ? EV - PV : null,
    EAC: EAC, ETC: EAC !== null ? EAC - AC : null, VAC: EAC !== null ? BAC - EAC : null,
    eacMethod: 'EAC = BAC ÷ CPI（假設目前成本效率延續至完工；AC = 0 時不適用，顯示 N/A）',
    note: baselineApproved ? '' : 'WBS 基準尚未核准：EVM 數值僅供參考，不可作為正式績效報告。'
  };

  /* ---------- Issues ---------- */
  var issues = Repo_.list('Issues', { projectId: projectId });
  var openIssues = issues.filter(function (x) { return OPEN_ISSUE_STATUSES.indexOf(x.status) >= 0; });
  var overdueIssues = openIssues.filter(function (x) { return x.due_date && x.due_date < statusDate; });
  var aging = { '0–3 天': 0, '4–7 天': 0, '8–14 天': 0, '15 天以上': 0 };
  openIssues.forEach(function (x) {
    var age = Math.max(0, diffDays_(x.created_date, statusDate) || 0);
    x.age_days = age;
    var sla = s.issueSlaDays[x.severity];
    x.sla_breached = sla !== undefined && age > sla;
    aging[age <= 3 ? '0–3 天' : age <= 7 ? '4–7 天' : age <= 14 ? '8–14 天' : '15 天以上']++;
  });

  /* ---------- Risks ---------- */
  var risks = Repo_.list('Risks', { projectId: projectId });
  var activeRisks = risks.filter(function (r) { return r.status !== 'Closed'; });
  var matrix = [];
  for (var p = 5; p >= 1; p--) {
    var row = [];
    for (var im = 1; im <= 5; im++) {
      var cell = activeRisks.filter(function (r) { return Number(r.probability) === p && Number(r.impact) === im; });
      row.push({ p: p, i: im, score: p * im, count: cell.length, ids: cell.map(function (r) { return r.risk_id; }) });
    }
    matrix.push(row);
  }
  var highRisks = activeRisks.filter(function (r) { return Number(r.risk_score) >= s.highRiskScore; });

  /* ---------- Milestones ---------- */
  var milestones = Repo_.list('Milestones', { projectId: projectId }).map(function (m) {
    var ref = m.forecast_date || m.baseline_date;
    var delay = 0;
    if (m.actual_date) delay = diffDays_(m.baseline_date, m.actual_date);
    else if (m.forecast_date) delay = diffDays_(m.baseline_date, m.forecast_date);
    else if (m.baseline_date < statusDate) delay = diffDays_(m.baseline_date, statusDate);
    m.delay_days = Math.max(0, delay || 0);
    m.health = m.actual_date ? (m.delay_days > 0 ? 'Achieved Late' : 'Achieved')
      : m.delay_days > s.msDelayRed ? 'Critical' : m.delay_days > 0 ? 'Warning' : 'OK';
    m.days_to_go = m.actual_date ? null : diffDays_(statusDate, ref);
    m.owner_name = resName[m.owner_id] || m.owner_id;
    return m;
  }).sort(function (a, b) { return a.baseline_date < b.baseline_date ? -1 : 1; });
  var upcoming = milestones.filter(function (m) { return !m.actual_date && m.days_to_go !== null && m.days_to_go >= 0 && m.days_to_go <= s.upcomingDays; });

  /* ---------- Acceptance / Changes / Meetings ---------- */
  var acceptance = Repo_.list('Acceptance', { projectId: projectId });
  var changes = Repo_.list('Changes', { projectId: projectId });
  var pendingChanges = changes.filter(function (c) { return ['Submitted', 'Impact Analysis'].indexOf(c.implementation_status) >= 0; });
  var meetings = Repo_.list('Communications', { projectId: projectId });
  var weekStart = addDays_(statusDate, -((Number(Utilities.formatDate(parseDate_(statusDate), APP.TZ, 'u')) + 6) % 7));
  var calEnd = addDays_(weekStart, 13);
  var calendar = [];
  meetings.forEach(function (m) {
    if (m.meeting_date >= weekStart && m.meeting_date <= calEnd && m.meeting_status !== 'Cancelled') {
      calendar.push({ date: m.meeting_date, time: m.start_time + (m.end_time ? '–' + m.end_time : ''), title: m.meeting_title, type: 'meeting', id: m.meeting_id });
    }
  });
  milestones.forEach(function (m) {
    var dte = m.forecast_date || m.baseline_date;
    if (!m.actual_date && dte >= weekStart && dte <= calEnd) calendar.push({ date: dte, time: '', title: '里程碑：' + m.milestone_name, type: 'milestone', id: m.milestone_id });
  });
  leaves.forEach(function (l) {
    if (l.effective_status !== 'Completed' && l.planned_end_date >= weekStart && l.planned_end_date <= calEnd) {
      calendar.push({ date: l.planned_end_date, time: '', title: '到期：' + l.wbs_code + ' ' + l.task_name, type: 'deadline', id: l.wbs_id });
    }
  });
  calendar.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });

  var in7 = addDays_(statusDate, 7);
  var reminders = [];
  leaves.filter(function (l) { return l.effective_status !== 'Completed' && l.effective_status !== 'Cancelled' && l.planned_end_date >= statusDate && l.planned_end_date <= in7; })
    .forEach(function (l) { reminders.push({ kind: '工作即將到期', title: l.wbs_code + ' ' + l.task_name, date: l.planned_end_date, owner: resName[l.owner_id] || l.owner_id, ref: { table: 'WBS', id: l.wbs_id } }); });
  pendingChanges.forEach(function (c) { reminders.push({ kind: '待核准變更', title: c.change_title, date: c.request_date, owner: resName[c.requester_id] || c.requester_id, ref: { table: 'Changes', id: c.change_id } }); });
  acceptance.filter(function (a) { return a.result === 'Pending' && a.planned_review_date && a.planned_review_date <= in7; })
    .forEach(function (a) { reminders.push({ kind: '待驗收', title: a.acceptance_item, date: a.planned_review_date, owner: resName[a.reviewer_id] || a.reviewer_id, ref: { table: 'Acceptance', id: a.acceptance_id } }); });
  overdueIssues.forEach(function (x) { reminders.push({ kind: '逾期問題', title: x.title, date: x.due_date, owner: resName[x.owner_id] || x.owner_id, ref: { table: 'Issues', id: x.issue_id } }); });
  reminders.sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  var in21 = addDays_(statusDate, 21);
  var timeline = leaves.filter(function (l) { return l.planned_end_date >= statusDate && l.planned_end_date <= in21 && l.effective_status !== 'Cancelled'; })
    .sort(function (a, b) { return a.planned_start_date < b.planned_start_date ? -1 : 1; })
    .slice(0, 12).map(function (l) {
      return { id: l.wbs_id, code: l.wbs_code, name: l.task_name, deliverable: l.deliverable, start: l.planned_start_date, end: l.planned_end_date,
        status: l.effective_status, owner: resName[l.owner_id] || l.owner_id, pct: num_(l.percent_complete) || 0 };
    });

  /* ---------- Health ---------- */
  var dims = [];
  var schedLevel = plannedAtStatus === 0 && overdue.length === 0 ? 'Green' : (variance <= s.schedRed ? 'Red' : variance <= s.schedYellow || overdue.length > 0 ? 'Yellow' : 'Green');
  dims.push({ name: '進度', level: schedLevel, reason: '已交付 ' + actualAtStatus + '% vs 計畫 ' + plannedAtStatus + '%（差異 ' + variance + ' pt），逾期 ' + overdue.length + ' 項' });
  var costVarPct = plannedBudget > 0 ? round_((fac - plannedBudget) / plannedBudget * 100, 1) : 0;
  dims.push({ name: '成本', level: costVarPct >= s.costRed ? 'Red' : costVarPct >= s.costYellow ? 'Yellow' : 'Green',
    reason: '完工預估 NT$' + fac.toLocaleString() + '，相對預算 ' + (costVarPct > 0 ? '+' : '') + costVarPct + '%' });
  var critRisk = activeRisks.some(function (r) { return Number(r.risk_score) >= 20; });
  dims.push({ name: '風險', level: critRisk ? 'Red' : highRisks.length >= s.highRiskYellowCount ? 'Yellow' : 'Green',
    reason: '高風險 ' + highRisks.length + ' 項' + (critRisk ? '，含極高風險（≥20）' : '') });
  var failedCritical = acceptance.some(function (a) { return a.result === 'Failed' && a.is_critical; });
  var critIssue = openIssues.some(function (x) { return x.severity === 'Critical'; });
  dims.push({ name: '品質／安全', level: failedCritical || critIssue ? 'Red' : overdueIssues.length ? 'Yellow' : 'Green',
    reason: (critIssue ? '有未結 Critical 問題；' : '') + (failedCritical ? '關鍵驗收未通過；' : '') + '逾期問題 ' + overdueIssues.length + ' 項' });
  var msRed = milestones.some(function (m) { return m.health === 'Critical'; });
  var msYellow = milestones.some(function (m) { return m.health === 'Warning'; });
  dims.push({ name: '里程碑', level: msRed ? 'Red' : msYellow ? 'Yellow' : 'Green',
    reason: msRed ? '有里程碑延誤超過 ' + s.msDelayRed + ' 天' : msYellow ? '有里程碑出現延誤' : '里程碑均在基準內' });
  var rank = { Green: 0, Yellow: 1, Red: 2 };
  var overall = dims.reduce(function (a, d) { return rank[d.level] > rank[a] ? d.level : a; }, 'Green');

  /* ---------- Snapshots (歷史趨勢只來自 WeeklySnapshots) ---------- */
  var snaps = Repo_.list('WeeklySnapshots', { projectId: projectId }).sort(function (a, b) { return a.week_ending < b.week_ending ? -1 : 1; });

  /* ---------- Activities / My tasks ---------- */
  var recent = [];
  if (user && can_(user, 'read', 'AuditLogs')) {
    recent = getAuditLogs_({ limit: 8 }).filter(function (l) { return l.action_type !== 'DENIED'; }).map(function (l) {
      return { at: l.timestamp, actor: l.actor_id, action: l.action_type, entity: l.entity_type, id: l.entity_id };
    });
  }
  var myTasks = (user && user.resource_id) ? leaves.filter(function (l) {
    return l.owner_id === user.resource_id && l.effective_status !== 'Completed' && l.effective_status !== 'Cancelled';
  }).sort(function (a, b) { return a.planned_end_date < b.planned_end_date ? -1 : 1; }).slice(0, 8).map(function (l) {
    return { id: l.wbs_id, code: l.wbs_code, name: l.task_name, end: l.planned_end_date, status: l.effective_status, pct: num_(l.percent_complete) || 0 };
  }) : [];

  return {
    generatedAt: nowStr_(), statusDate: statusDate,
    project: project,
    weightMode: roll.equalWeights ? 'equal' : 'weighted',
    kpis: {
      completionPct: completionPct, totalWorkPackages: leaves.length,
      completedWorkPackages: statusCounts['Completed'] || 0, overdueTasks: overdue.length,
      plannedBudget: plannedBudget, actualCost: actualCost, committedCost: committed,
      budgetUtilizationPct: plannedBudget > 0 ? round_(actualCost / plannedBudget * 100, 1) : null,
      openIssues: openIssues.length, highRisks: highRisks.length, upcomingMilestones: upcoming.length
    },
    wbsStatusCounts: statusCounts,
    overdueList: overdue.map(function (l) { return { id: l.wbs_id, code: l.wbs_code, name: l.task_name, end: l.planned_end_date, days: l.overdue_days, owner: resName[l.owner_id] || l.owner_id }; }),
    sCurve: {
      labels: labels, baseline: base, actual: act, forecast: fc, hasActual: hasActual,
      baselineApproved: baselineApproved, baselineVersion: project.baseline_version || '',
      plannedAtStatus: plannedAtStatus, actualAtStatus: actualAtStatus, forecastAtStatus: forecastAtStatus,
      variance: variance, varianceLevel: varianceLevel, plannedFinish: plannedFinish, forecastFinish: forecastFinish,
      forecastMethod: '已完成：實際完成日；未逾期：計畫完成日；已逾期：狀態日 + 剩餘工期（工期 × (1 − 完成率)，至少 1 工作日）'
    },
    wbsTrend: snaps.map(function (x) {
      return { week: x.week_ending, completed: x.completed_task_count, inProgress: x.in_progress_count, notStarted: x.not_started_count, delayed: x.delayed_count, blocked: x.blocked_count };
    }),
    cost: {
      plannedBudget: plannedBudget, costBaseline: costBaseline, committed: committed, actual: actualCost,
      forecastAtCompletion: fac, budgetVariance: plannedBudget - fac, breakdown: breakdown,
      trend: snaps.map(function (x) { return { week: x.week_ending, pv: x.planned_value, ev: x.earned_value, ac: x.actual_cost }; }),
      consistent: Math.abs(breakdown.reduce(function (a, b) { return a + b.baseline; }, 0) - costBaseline) < 1
    },
    evm: evm,
    issues: {
      byStatus: groupCount_(issues, 'status', ENUMS.ISSUE_STATUS),
      bySeverity: groupCount_(openIssues, 'severity', ENUMS.SEVERITY),
      open: openIssues.length, closed: issues.length - openIssues.length, overdue: overdueIssues.length,
      aging: aging, trend: snaps.map(function (x) { return { week: x.week_ending, open: x.open_issue_count }; })
    },
    risks: { matrix: matrix, high: highRisks.length, active: activeRisks.length,
      top: activeRisks.sort(function (a, b) { return b.risk_score - a.risk_score; }).slice(0, 5).map(function (r) {
        return { id: r.risk_id, desc: r.risk_description, score: r.risk_score, severity: r.severity, owner: resName[r.owner_id] || r.owner_id };
      }) },
    milestones: milestones, upcomingMilestones: upcoming,
    calendar: calendar, reminders: reminders.slice(0, 10), timeline: timeline,
    health: { overall: overall, dimensions: dims },
    recentActivities: recent, myTasks: myTasks,
    badges: { Issues: openIssues.length, Risks: highRisks.length, Changes: pendingChanges.length, WBS: overdue.length,
      Acceptance: acceptance.filter(function (a) { return a.result === 'Pending'; }).length, Milestones: upcoming.length }
  };
}
