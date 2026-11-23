const { makeEnv } = require('./harness');
const env = makeEnv({ verbose: false });
const results = [];
const t = (name, fn) => { try { const r = fn(); results.push(['PASS', name, r || '']); } catch (e) { results.push(['FAIL', name, e.message]); } };
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
t('setupDatabase 建立 20 張工作表', () => { env.setupDatabase(); ok(Object.keys(env.__sheets).length === 20, Object.keys(env.__sheets).length); });
env.__reset();
t('重複執行 setup 不覆蓋資料', () => { const n = env.__sheets.WBS.data.length; env.setupDatabase(); env.__reset(); ok(env.__sheets.WBS.data.length === n); return 'WBS rows ' + (n - 1); });
t('getBootstrap（Admin）', () => { const r = env.getBootstrap(); ok(r.ok, JSON.stringify(r.error)); ok(r.data.user.role === 'Admin'); return r.data.projects.length + ' project(s)'; });
let dash;
t('getDashboardData KPI 由資料計算', () => {
  const r = env.getDashboardData('YEP-2027-001', { statusDate: '2026-11-23' }); ok(r.ok, JSON.stringify(r.error)); dash = r.data;
  const k = dash.kpis; ok(k.totalWorkPackages === 33, 'WP ' + k.totalWorkPackages); ok(k.plannedBudget === 600000); ok(k.actualCost === 0);
  ok(k.completionPct === 0); ok(k.openIssues === 2); ok(k.highRisks === 1, 'high ' + k.highRisks);
  return JSON.stringify(k);
});
t('權重合計 100、成本分類加總一致', () => { ok(dash.cost.costBaseline === 600000); ok(dash.cost.consistent); ok(dash.evm.BAC === 570000, dash.evm.BAC); });
t('S-Curve：無實績不畫 Actual', () => { ok(dash.sCurve.hasActual === false); ok(dash.sCurve.actual.every(v => v === null)); ok(dash.sCurve.baseline[dash.sCurve.baseline.length - 1] === 100); return 'end ' + dash.sCurve.plannedFinish; });
t('EVM 分母為 0 → N/A(null)', () => { ok(dash.evm.CPI === null); ok(dash.evm.EAC === null); });
t('狀態日 2026-12-15 → 逾期與 Delayed、Health 非 Green', () => {
  env.__reset(); const r = env.getDashboardData('YEP-2027-001', { statusDate: '2026-12-15' }); ok(r.ok, JSON.stringify(r.error));
  ok(r.data.kpis.overdueTasks > 0); ok(r.data.sCurve.variance < 0); ok(r.data.health.overall !== 'Green');
  return `overdue ${r.data.kpis.overdueTasks}, planned ${r.data.sCurve.plannedAtStatus}%, variance ${r.data.sCurve.variance}, health ${r.data.health.overall}, forecastFinish ${r.data.sCurve.forecastFinish}`;
});
let wbs;
t('updateWbs 寫回 Sheets（填實際開始＋進度）', () => {
  env.__reset(); wbs = env.getWbs('YEP-2027-001').data.find(w => w.wbs_code === '1.1.1');
  const r = env.updateWbs(wbs.wbs_id, { actual_start_date: '2026-11-23', percent_complete: 50, status: 'In Progress', row_version: wbs.row_version });
  ok(r.ok, JSON.stringify(r.error)); ok(r.data.row_version === 2);
  const raw = env.__sheets.WBS.data; const h = raw[0]; const row = raw.find(x => x[0] === wbs.wbs_id); ok(row[h.indexOf('percent_complete')] === 50);
});
t('樂觀鎖：舊版本 → CONFLICT', () => { env.__reset(); const r = env.updateWbs(wbs.wbs_id, { percent_complete: 60, row_version: 1 }); ok(!r.ok && r.error.code === 'CONFLICT', JSON.stringify(r)); });
t('未來實際完成日被拒', () => { env.__reset(); const r = env.updateWbs(wbs.wbs_id, { actual_end_date: '2099-01-01', row_version: 2 }); ok(!r.ok && r.error.code === 'VALIDATION', JSON.stringify(r)); return r.error.message; });
t('循環相依被拒', () => {
  env.__reset(); const a = env.getWbs('YEP-2027-001').data.find(w => w.wbs_code === '1.1.1');
  const r = env.updateWbs(a.wbs_id, { dependency_ids: 'WBS-113', row_version: a.row_version }); ok(!r.ok && /循環/.test(r.error.message), JSON.stringify(r)); return r.error.message;
});
t('公式注入被中和', () => {
  env.__reset(); const r = env.createIssue({ title: '=HYPERLINK("http://x")', severity: 'Low', priority: 'Low', status: 'Open' }); ok(r.ok, JSON.stringify(r.error));
  ok(r.data.title === '=HYPERLINK("http://x")', 'roundtrip ' + r.data.title); return 'stored with leading apostrophe; API returns original text';
});
t('Risk 分數與嚴重度自動計算', () => { env.__reset(); const r = env.createRisk({ risk_description: 'test', probability: 4, impact: 4, status: 'Open' }); ok(r.ok, JSON.stringify(r.error)); ok(r.data.risk_score === 16 && r.data.severity === 'High'); });
t('Risk 轉 Issue 保留雙向關聯', () => { env.__reset(); const r = env.convertRiskToIssue('RK01'); ok(r.ok, JSON.stringify(r.error)); env.__reset(); const rk = env.getRisks('YEP-2027-001').data.find(x => x.risk_id === 'RK01'); ok(rk.linked_issue_id === r.data.issue_id && r.data.linked_risk_id === 'RK01'); });
t('RACI 重複 A 被拒', () => { env.__reset(); const r = env.createRecord('RACI', { deliverable_id: 'WBS-121', resource_id: 'R003', responsibility_type: 'A' }); ok(!r.ok && /只能有一位 A/.test(r.error.message), JSON.stringify(r)); });
t('變更流程：Draft 不可直接 Approved', () => {
  env.__reset(); const c = env.submitChangeRequest({ change_title: '增加 10 人', request_date: '2026-11-23' }); ok(c.ok, JSON.stringify(c.error));
  env.__reset(); const a = env.approveChangeRequest(c.data.change_id, 'Approved', c.data.row_version); ok(!a.ok, 'should fail from Submitted');
  env.__reset(); const b = env.updateRecord('Changes', c.data.change_id, { implementation_status: 'Impact Analysis', row_version: c.data.row_version }); ok(b.ok, JSON.stringify(b.error));
  env.__reset(); const d = env.approveChangeRequest(c.data.change_id, 'Approved', b.data.row_version); ok(d.ok, JSON.stringify(d.error)); ok(JSON.parse(d.data.history_json).length === 3);
});
t('Soft delete + 無法刪除有子項的 WBS', () => {
  env.__reset(); const p = env.getWbs('YEP-2027-001').data.find(w => w.wbs_code === '1.1'); const r = env.deleteWbs(p.wbs_id, p.row_version); ok(!r.ok);
  env.__reset(); const is = env.getIssues('YEP-2027-001').data.find(x => x.issue_id === 'IS02'); const d = env.deleteRecord('Issues', 'IS02', is.row_version); ok(d.ok && d.data.is_deleted === true);
  env.__reset(); ok(!env.getIssues('YEP-2027-001').data.some(x => x.issue_id === 'IS02'));
});
t('核准基準後鎖定計畫日期', () => {
  env.__reset(); const a = env.approveBaseline('YEP-2027-001', 'v1'); ok(a.ok, JSON.stringify(a.error));
  env.__reset(); const w = env.getWbs('YEP-2027-001').data.find(x => x.wbs_code === '1.2.1');
  const r = env.updateWbs(w.wbs_id, { planned_end_date: '2026-12-31', row_version: w.row_version }); ok(!r.ok && r.error.code === 'BASELINE_LOCKED', JSON.stringify(r));
  env.__reset(); const d = env.getDashboardData('YEP-2027-001', {}).data; ok(d.sCurve.baselineApproved === true); return 'baseline ' + d.project.baseline_version;
});
t('每週快照不可覆寫', () => { env.__reset(); const a = env.createWeeklySnapshot('YEP-2027-001'); ok(a.ok, JSON.stringify(a.error)); env.__reset(); const b = env.createWeeklySnapshot('YEP-2027-001'); ok(!b.ok && b.error.code === 'DUPLICATE'); return a.data.week_ending; });
t('Audit Log 有紀錄', () => { env.__reset(); const r = env.getAuditLogs({ limit: 500 }); ok(r.ok); ok(r.data.some(x => x.action_type === 'UPDATE') && r.data.some(x => x.action_type === 'BASELINE')); return r.data.length + ' logs'; });
t('未授權帳號被拒', () => { env.__setEmail('stranger@example.com'); const r = env.getDashboardData('YEP-2027-001'); ok(!r.ok && r.error.code === 'FORBIDDEN'); });
t('無法取得 Email → UNAUTHENTICATED', () => { env.__setEmail(''); const r = env.getBootstrap(); ok(!r.ok && r.error.code === 'UNAUTHENTICATED'); });
t('Viewer 不能寫入', () => {
  env.__setEmail('admin@example.com'); env.addUser('viewer@example.com', 'V', 'Viewer', ''); env.__setEmail('viewer@example.com');
  const r = env.createIssue({ title: 'x', severity: 'Low', priority: 'Low', status: 'Open' }); ok(!r.ok && r.error.code === 'FORBIDDEN', JSON.stringify(r));
  const d = env.getDashboardData('YEP-2027-001'); ok(d.ok, JSON.stringify(d.error)); ok(d.data.recentActivities.length === 0);
});
t('不允許的資料表名稱', () => { env.__setEmail('admin@example.com'); const r = env.listRecords('../Secret'); ok(!r.ok && r.error.code === 'BAD_TABLE'); });
t('回傳值可序列化（無 Date 物件）', () => { env.__reset(); const r = env.getDashboardData('YEP-2027-001'); ok(JSON.stringify(r).indexOf('"20') > 0); ok(!/T\d\d:\d\d:\d\d\.\d{3}Z/.test(JSON.stringify(r))); });
results.forEach(r => console.log(r[0].padEnd(5), r[1], r[2] ? '→ ' + String(r[2]).substring(0, 220) : ''));
console.log('\n' + results.filter(r => r[0] === 'PASS').length + '/' + results.length + ' passed');
