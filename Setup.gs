/**
 * Setup.gs — 建立資料庫、格式、驗證規則與示範資料（Demo / Planned）
 *
 * 在 Apps Script 編輯器選擇 setupDatabase 執行：
 *  1. 若 Script Properties 尚未設定 SPREADSHEET_ID：
 *     - 若此專案綁定於試算表 → 使用該試算表；
 *     - 否則建立新試算表「YearEnd_PMO_2027_Database」。
 *  2. 建立 20 張工作表、英文欄位代碼、凍結標題列、下拉選單、日期／數字驗證與條件格式。
 *  3. 匯入示範資料（只在工作表為空時匯入；不會覆蓋既有資料）。
 *  4. 將執行者 Email 建立為 Admin。
 *
 * ⚠ 所有 Actual 欄位（實際日期、實際支出、驗收結果）皆保持空白或 Pending；
 *   示範資料以 [Demo] 標示，計畫值以 Planned 表示，非正式核准資料。
 */

function setupDatabase() {
  var props = PropertiesService.getScriptProperties();
  var ss, id = props.getProperty(APP.PROP_SS_ID) || APP.DEFAULT_SPREADSHEET_ID || '';
  if (id) {
    props.setProperty(APP.PROP_SS_ID, id);
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create(APP.SS_NAME);
    props.setProperty(APP.PROP_SS_ID, ss.getId());
  }
  ss.setSpreadsheetTimeZone(APP.TZ);
  ss.setSpreadsheetLocale('zh_TW');

  Object.keys(TABLES).forEach(function (t, idx) { ensureSheet_(ss, t, idx); });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('工作表1');
  if (def && ss.getSheets().length > Object.keys(TABLES).length) ss.deleteSheet(def);

  seedDemoData_();
  var email = Session.getEffectiveUser().getEmail();
  console.log('完成。資料庫：' + ss.getUrl() + '\nAdmin：' + email);
  return ss.getUrl();
}

/** 只設定（或更換）資料庫 ID，不建立資料。Spreadsheet ID 只能由編輯器設定，前端無法修改。 */
function setSpreadsheetId(id) {
  if (!id) throw new Error('請提供 Spreadsheet ID');
  SpreadsheetApp.openById(id); // 驗證可開啟
  PropertiesService.getScriptProperties().setProperty(APP.PROP_SS_ID, id);
}

/** 安裝每週五 18:00（台北）自動快照觸發器 */
function installWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'weeklySnapshotJob') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weeklySnapshotJob').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(18).inTimezone(APP.TZ).create();
}

/** 新增授權使用者（於編輯器執行，例如 addUser('a@b.com','王小明','PM','R001')） */
function addUser(email, name, role, resourceId) {
  var ctx = { user: { email: Session.getEffectiveUser().getEmail(), permissions: ['*:*'], role: 'Admin' }, requestId: uuid_() };
  return Repo_.create('Users', { email: email, display_name: name || email, role: role || 'Viewer', resource_id: resourceId || '', active: true }, ctx);
}

function ensureSheet_(ss, table, idx) {
  var headers = headersOf_(table);
  var sh = ss.getSheetByName(table);
  if (!sh) { sh = ss.insertSheet(table, idx); }
  var existing = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
  if (existing.join('') === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
    if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]); // 向後相容：補欄位
  }
  var cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, cur.length).setFontWeight('bold').setBackground('#0F172A').setFontColor('#FFFFFF');
  // 第 1 列加上中文註解（UI 名稱）
  sh.getRange(1, 1, 1, cur.length).setNotes([cur.map(function (h) { return LABELS[h] || h; })]);
  sh.setTabColor(table === 'AuditLogs' ? '#64748B' : '#2563EB');

  var maxRows = Math.max(sh.getMaxRows(), 500);
  if (sh.getMaxRows() < maxRows) sh.insertRowsAfter(sh.getMaxRows(), maxRows - sh.getMaxRows());
  var fields = schemaOf_(table);
  var rules = [];
  fields.forEach(function (f) {
    var col = cur.indexOf(f.name) + 1;
    if (col < 1) return;
    var rng = sh.getRange(2, col, maxRows - 1, 1);
    var dv = null;
    if (f.type === 'enum') dv = SpreadsheetApp.newDataValidation().requireValueInList(ENUMS[f.arg], true).setAllowInvalid(false).build();
    else if (f.type === 'date') { dv = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build(); rng.setNumberFormat('yyyy-mm-dd'); }
    else if (f.type === 'pct') dv = SpreadsheetApp.newDataValidation().requireNumberBetween(0, 100).setAllowInvalid(false).build();
    else if (f.type === 'money') { dv = SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build(); rng.setNumberFormat('"NT$"#,##0'); }
    else if (f.name === 'probability' || f.name === 'impact') dv = SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).setAllowInvalid(false).build();
    else if (f.type === 'bool') dv = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    else if (f.type === 'datetime' || f.type === 'time' || f.type === 'id' || f.type === 'ref' || f.type === 'refs') rng.setNumberFormat('@');
    if (dv) rng.setDataValidation(dv);
    if (/status|result|severity/.test(f.name) && f.type === 'enum') {
      var ab = String.fromCharCode(64 + Math.min(col, 26));
      if (col <= 26) {
        [['Completed', '#D1FAE5'], ['Achieved', '#D1FAE5'], ['Passed', '#D1FAE5'], ['Closed', '#E2E8F0'], ['Delayed', '#FEE2E2'], ['Blocked', '#FEE2E2'],
          ['Failed', '#FEE2E2'], ['Critical', '#FEE2E2'], ['High', '#FEF3C7'], ['At Risk', '#FEF3C7'], ['In Progress', '#DBEAFE']].forEach(function (p) {
          rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(p[0]).setBackground(p[1]).setRanges([rng]).build());
        });
      }
    }
  });
  if (rules.length) sh.setConditionalFormatRules(rules);
  var prot = sh.getRange(1, 1, 1, cur.length).protect().setDescription('欄位代碼請勿修改');
  prot.setWarningOnly(true);
}

/* ============================ Seed Data ============================ */

function seedDemoData_() {
  var ctx = { user: { email: Session.getEffectiveUser().getEmail() || 'setup', permissions: ['*:*'], role: 'Admin' }, actor: 'setup', requestId: 'SETUP-' + uuid_() };
  var put = function (table, rows) {
    if (readTable_(table).rows.length) { console.log(table + ' 已有資料，略過示範資料'); return; }
    var sh = sheet_(table), headers = readTable_(table).headers, fields = schemaOf_(table);
    var fmap = {}; fields.forEach(function (f) { fmap[f.name] = f; });
    var now = nowStr_();
    var values = rows.map(function (r) {
      if (fmap.created_at && !r.created_at) r.created_at = now;
      if (fmap.updated_at && !r.updated_at) r.updated_at = now;
      r.row_version = 1; r.is_deleted = false;
      return headers.map(function (h) {
        if (!fmap[h]) return '';
        if (h === 'row_version' || h === 'is_deleted') return r[h];
        return toCell_(r[h], fmap[h], table);
      });
    });
    if (values.length) sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
    invalidate_(table);
    audit_(ctx, table, '', 'SETUP', null, { seeded: values.length }, 'SUCCESS');
  };

  var P = APP.DEFAULT_PROJECT_ID;

  put('Roles', Object.keys(DEFAULT_ROLES).map(function (k) { return { role: k, description: DEFAULT_ROLES[k].description, permissions: DEFAULT_ROLES[k].permissions }; }));

  put('Settings', [
    ['TIMEZONE', 'Asia/Taipei', '系統時區'],
    ['CURRENCY', 'TWD', '幣別'],
    ['PROJECT_STATUS_OPTIONS', JSON.stringify(ENUMS.PROJECT_STATUS), '專案狀態選項（參考用；驗證以 Config.gs ENUMS 為準）'],
    ['ISSUE_STATUS_OPTIONS', JSON.stringify(ENUMS.ISSUE_STATUS), '問題狀態選項'],
    ['RISK_HIGH_SCORE', '15', '風險分數 ≥ 此值為 High（P×I，1–25）'],
    ['RISK_MEDIUM_SCORE', '8', '風險分數 ≥ 此值為 Medium'],
    ['HEALTH_SCHEDULE_YELLOW_PCT', '-5', '進度差異（百分點）≤ 此值為 Yellow'],
    ['HEALTH_SCHEDULE_RED_PCT', '-15', '進度差異（百分點）≤ 此值為 Red'],
    ['HEALTH_COST_YELLOW_PCT', '5', '完工預估超出預算 ≥ 此 % 為 Yellow'],
    ['HEALTH_COST_RED_PCT', '10', '完工預估超出預算 ≥ 此 % 為 Red'],
    ['HEALTH_MILESTONE_DELAY_RED_DAYS', '3', '里程碑延誤超過此天數為 Red'],
    ['HEALTH_HIGH_RISK_YELLOW_COUNT', '1', '高風險數量 ≥ 此值為 Yellow'],
    ['UPCOMING_WINDOW_DAYS', '14', 'Upcoming Milestones 視窗（天）'],
    ['ISSUE_SLA_DAYS', JSON.stringify({ Critical: 1, High: 3, Medium: 7, Low: 14 }), '問題處理 SLA（天）'],
    ['WORKDAYS', '[1,2,3,4,5]', '工作日（0=週日…6=週六）'],
    ['HOLIDAYS', '[]', '國定假日清單 ["2027-01-01",…]：請依行政院人事行政總處公告填入（含 2027 春節）'],
    ['STATUS_DATE_OVERRIDE', '', '留空＝以今天為狀態日；填日期可檢視特定狀態日'],
    ['AUTHORIZED_USERS', '見 Users 工作表', '授權使用者以 Users 工作表管理'],
    ['ROLE_DEFINITIONS', '見 Roles 工作表', '角色權限以 Roles 工作表管理']
  ].map(function (r) { return { setting_key: r[0], setting_value: r[1], description: r[2] }; }));

  put('Projects', [{
    project_id: P, project_name: '2027 企業尾牙', theme: '同心協力・共創未來',
    project_description: '[Demo] 中型科技公司（教學情境）年度尾牙。活動 2027-01-22 18:00–21:00，預計 120 人。以上為規劃假設，尚未通過正式審核。',
    sponsor_id: 'R009', pm_id: 'R001', start_date: '2026-11-23', planned_end_date: '2027-02-05', event_date: '2027-01-22', participants: 120,
    baseline_version: 'v1.0-draft', total_budget: 600000, project_status: 'Planning', methodology: 'Hybrid'
  }]);

  put('Resources', [
    ['R001', '專案經理（待指定）', '管理部', 'Project Manager', 40, 24, 900],
    ['R002', '行政總務負責人（待指定）', '行政部', 'Venue & Logistics Lead', 40, 20, 600],
    ['R003', '財務負責人（待指定）', '財務部', 'Finance Controller', 40, 6, 750],
    ['R004', '節目統籌（待指定）', '人資部', 'Program Lead', 40, 16, 650],
    ['R005', '視聽技術負責人（待指定）', '資訊部', 'AV / IT Lead', 40, 10, 700],
    ['R006', '人資活動窗口（待指定）', '人資部', 'Participant Services', 40, 14, 600],
    ['R007', '採購負責人（待指定）', '採購部', 'Procurement', 40, 8, 650],
    ['R008', '公關攝影窗口（待指定）', '公關部', 'PR & Media', 40, 6, 600],
    ['R009', '專案發起人（待指定）', '總經理室', 'Project Sponsor', 40, 2, 1500]
  ].map(function (r) {
    return { resource_id: r[0], name: r[1], department: r[2], role: r[3], capacity_hours_per_week: r[4], allocated_hours: r[5], hourly_rate: r[6],
      availability_status: 'Available', project_id: P, notes: '[Demo] 工時與時薪為規劃假設' };
  }));

  // WBS：[code, name, deliverable, owner, start, end, deps(codes), weight, acceptance, priority]
  var L2 = [
    ['1.1', '專案治理成果', 'R001'], ['1.2', '場地與餐飲交付成果', 'R002'], ['1.3', '節目、表揚及抽獎成果', 'R004'],
    ['1.4', '參與者服務成果', 'R006'], ['1.5', '視聽設備與現場執行成果', 'R005'], ['1.6', '預算、風險及追蹤成果', 'R003'], ['1.7', '驗收與結案成果', 'R001']
  ];
  var L3 = [
    ['1.1.1', '專案章程與目標確認', '核准之專案章程', 'R001', '2026-11-23', '2026-11-26', '', 3, 'Sponsor 簽核章程，含目標、範圍、預算上限 NT$600,000', 'High'],
    ['1.1.2', '利害關係人登錄與溝通計畫', '利害關係人登錄表、溝通計畫', 'R001', '2026-11-24', '2026-11-27', '1.1.1', 2, '列出所有關鍵利害關係人與溝通頻率，PM 核可', 'Medium'],
    ['1.1.3', '專案啟動會議', '啟動會議紀錄', 'R001', '2026-11-27', '2026-11-27', '1.1.2', 2, '會議紀錄含決議與行動項目，48 小時內發布', 'High'],
    ['1.1.4', '範圍說明書與 WBS 基準核定', '範圍說明書、WBS 字典', 'R001', '2026-11-30', '2026-12-04', '1.1.3', 4, 'Sponsor 核准範圍與 WBS 基準 v1.0', 'High'],
    ['1.2.1', '場地需求定義與候選清單', '場地需求規格、3 家候選場地', 'R002', '2026-11-26', '2026-12-02', '1.1.1', 3, '容量 ≥ 130 人、交通便利、無障礙設施、報價在預算內', 'High'],
    ['1.2.2', '場地勘查與比較評估', '場勘紀錄與評分表', 'R002', '2026-12-03', '2026-12-08', '1.2.1', 3, '每家候選場地皆有評分、照片與檔期確認', 'High'],
    ['1.2.3', '場地簽約與訂金支付', '已簽署場地合約', 'R007', '2026-12-09', '2026-12-11', '1.2.2', 4, '合約經財務審閱、訂金付款完成並留存紀錄', 'Critical'],
    ['1.2.4', '菜單規劃與試菜', '確認菜單（含素食／過敏選項）', 'R002', '2026-12-14', '2026-12-23', '1.2.3', 4, '試菜評分 ≥ 4/5，特殊飲食需求覆蓋率 100%', 'High'],
    ['1.2.5', '餐飲合約與最終桌數確認', '餐飲合約、桌數確認單', 'R007', '2027-01-04', '2027-01-12', '1.2.4,1.4.3', 4, '桌數 = 報名人數 + 5% 緩衝，合約金額在預算內', 'Critical'],
    ['1.3.1', '節目主題與流程設計', '活動主流程 Run-down v1', 'R004', '2026-12-07', '2026-12-18', '1.1.4', 4, '主流程經 Sponsor 確認，總時長 18:00–21:00', 'High'],
    ['1.3.2', '主持人遴選與簽約', '主持人合約', 'R004', '2026-12-14', '2026-12-24', '1.3.1', 3, '合約簽署，腳本交付時程明確', 'Medium'],
    ['1.3.3', '年度表揚名單與獎座', '表揚名單、獎座', 'R006', '2026-12-07', '2027-01-08', '1.1.4', 3, '名單經主管核定，獎座文字校對無誤', 'Medium'],
    ['1.3.4', '員工表演節目徵選與排練', '表演節目清單、排練紀錄', 'R004', '2026-12-14', '2027-01-15', '1.3.1', 3, '每個節目至少 2 次排練，時長符合流程表', 'Medium'],
    ['1.3.5', '抽獎規則與獎品採購', '抽獎辦法、獎品清單與驗收單', 'R007', '2026-12-14', '2027-01-08', '1.3.1', 4, '抽獎規則公告，獎品驗收且總額在預算內', 'High'],
    ['1.3.6', '主流程定稿與主持腳本', 'Run-down 定稿、主持腳本', 'R004', '2026-12-21', '2026-12-25', '1.3.2', 2, '分秒流程表定稿並經 Sponsor 確認', 'High'],
    ['1.4.1', '邀請函與報名系統建置', '電子邀請函、報名表單', 'R006', '2026-12-07', '2026-12-14', '1.1.4', 3, '測試報名成功率 100%，含飲食需求與交通欄位', 'Medium'],
    ['1.4.2', '報名開放與催報', '報名名單（進行中）', 'R006', '2026-12-15', '2027-01-06', '1.4.1', 3, '報名回覆率 ≥ 95%', 'Medium'],
    ['1.4.3', '報名截止與名單確認', '最終參加名單', 'R006', '2027-01-06', '2027-01-08', '1.4.2', 2, '名單經各部門主管確認', 'High'],
    ['1.4.4', '交通與座位安排', '座位表、交通資訊', 'R002', '2027-01-11', '2027-01-15', '1.4.3', 3, '座位表無重複／遺漏，交通資訊已發送', 'Medium'],
    ['1.4.5', '報到流程與名牌製作', '報到動線、名牌', 'R006', '2027-01-12', '2027-01-19', '1.4.3', 2, '報到演練每人 ≤ 30 秒', 'Medium'],
    ['1.5.1', '視聽需求規格與廠商選定', '視聽需求規格書、比價紀錄', 'R005', '2026-12-14', '2026-12-24', '1.2.3', 3, '規格涵蓋音響、投影、麥克風與備援', 'High'],
    ['1.5.2', '視聽合約與設備清單確認', '視聽合約、設備清單', 'R007', '2026-12-28', '2027-01-08', '1.5.1', 2, '合約簽署，設備清單與規格書一致', 'High'],
    ['1.5.3', '攝影與影像紀錄安排', '攝影服務合約、拍攝清單', 'R008', '2026-12-21', '2027-01-08', '1.3.1', 2, '拍攝清單涵蓋表揚、抽獎與團體照', 'Low'],
    ['1.5.4', '現場佈置與動線規劃', '場佈圖、動線圖', 'R002', '2027-01-05', '2027-01-15', '1.2.3,1.4.4', 3, '消防通道淨空，經場地方書面確認', 'High'],
    ['1.5.5', '技術與流程彩排', '彩排紀錄、問題清單', 'R005', '2027-01-19', '2027-01-20', '1.5.2,1.3.6,1.5.4', 4, '全流程彩排完成，重大問題 0 項', 'Critical'],
    ['1.5.6', '活動當日執行與撤場', '活動執行紀錄、撤場清點表', 'R001', '2027-01-22', '2027-01-22', '1.5.5', 6, '依 Run-down 執行，零重大安全事故，設備清點無短缺', 'Critical'],
    ['1.6.1', '預算基準編製與核准', '核准之成本基準', 'R003', '2026-11-30', '2026-12-11', '1.1.3', 3, '總額 ≤ NT$600,000，含應變準備金，Sponsor 核准', 'Critical'],
    ['1.6.2', '風險登錄與應變計畫', '風險登錄表', 'R001', '2026-11-30', '2026-12-11', '1.1.3', 2, '所有高風險皆有負責人與應變計畫', 'High'],
    ['1.6.3', '每週進度與成本追蹤', '每週狀態報告（含快照）', 'R001', '2026-12-07', '2027-01-22', '1.6.1', 3, '每週五產出快照與狀態報告', 'Medium'],
    ['1.6.4', '安全與緊急應變計畫', '緊急應變計畫', 'R002', '2027-01-05', '2027-01-15', '1.2.3', 2, '含醫療、疏散、聯絡窗口，經場地方確認', 'High'],
    ['1.7.1', '滿意度問卷設計與發放', '滿意度問卷與統計結果', 'R006', '2027-01-12', '2027-01-26', '1.4.3', 2, '回收率 ≥ 70%，平均滿意度可計算（目標 ≥ 4.3/5）', 'Medium'],
    ['1.7.2', '供應商驗收與付款結算', '驗收單、付款紀錄', 'R003', '2027-01-25', '2027-01-29', '1.5.6', 3, '所有合約項目完成驗收，發票齊全', 'High'],
    ['1.7.3', '結案報告與經驗學習', '結案報告、Lessons Learned', 'R001', '2027-01-26', '2027-02-05', '1.7.1,1.7.2', 4, '活動後 10 個工作天內完成並經 Sponsor 核准', 'High']
  ];
  var idOf = function (code) { return 'WBS-' + code.replace(/\./g, ''); };
  var cal = { workdays: [1, 2, 3, 4, 5], holidays: [] };
  var wbsRows = [{ wbs_id: 'WBS-1', project_id: P, parent_wbs_id: '', level: 1, wbs_code: '1', task_name: '2027 企業尾牙', deliverable: '成功舉辦之 2027 尾牙活動',
    owner_id: 'R001', planned_start_date: '2026-11-23', planned_end_date: '2027-02-05', status: 'Not Started', priority: 'High', baseline_version: 'v1.0-draft' }];
  L2.forEach(function (x) {
    var kids = L3.filter(function (k) { return k[0].indexOf(x[0] + '.') === 0; });
    wbsRows.push({ wbs_id: idOf(x[0]), project_id: P, parent_wbs_id: 'WBS-1', level: 2, wbs_code: x[0], task_name: x[1], owner_id: x[2],
      deliverable: x[1], planned_start_date: kids.map(function (k) { return k[4]; }).sort()[0],
      planned_end_date: kids.map(function (k) { return k[5]; }).sort().pop(), status: 'Not Started', priority: 'High', baseline_version: 'v1.0-draft',
      task_description: '[Planned] 第二層交付成果彙總' });
  });
  L3.forEach(function (k) {
    wbsRows.push({ wbs_id: idOf(k[0]), project_id: P, parent_wbs_id: idOf(k[0].split('.').slice(0, 2).join('.')), level: 3, wbs_code: k[0], task_name: k[1],
      task_description: '[Planned] 示範工作包', deliverable: k[2], acceptance_criteria: k[8], owner_id: k[3], planned_start_date: k[4], planned_end_date: k[5],
      duration_days: workingDaysBetween_(k[4], k[5], cal), percent_complete: 0, task_weight: k[7],
      dependency_ids: k[6] ? k[6].split(',').map(idOf).join(',') : '', priority: k[9], status: 'Not Started', baseline_version: 'v1.0-draft' });
  });
  put('WBS', wbsRows);

  put('Milestones', [
    ['MS01', '專案啟動', '2026-11-27', 'R001', '1.1.3', '啟動會議完成且紀錄發布'],
    ['MS02', '場地及預算確認', '2026-12-11', 'R002', '1.2.3,1.6.1', '場地合約簽署、成本基準核准'],
    ['MS03', '主流程與節目確認', '2026-12-25', 'R004', '1.3.1,1.3.6', 'Run-down 定稿並經 Sponsor 確認'],
    ['MS04', '報名及採購確認', '2027-01-08', 'R006', '1.4.3,1.3.5,1.5.2', '最終名單確認，主要採購合約完成'],
    ['MS05', '流程與技術彩排', '2027-01-20', 'R005', '1.5.5', '全流程彩排完成，重大問題 0 項'],
    ['MS06', '尾牙活動舉辦', '2027-01-22', 'R001', '1.5.6', '活動依流程完成，零重大安全事故'],
    ['MS07', '財務結算及專案結案', '2027-02-05', 'R001', '1.7.2,1.7.3', '活動後 10 個工作天內完成結案（基準日未計入國定假日，請於 Settings 補登 2027 春節假期後重新確認）']
  ].map(function (m) {
    return { milestone_id: m[0], project_id: P, milestone_name: m[1], baseline_date: m[2], forecast_date: '', actual_date: '', owner_id: m[3],
      status: 'Planned', linked_wbs_ids: m[4].split(',').map(idOf).join(','), acceptance_criteria: m[5], description: '[Planned] 基準日為規劃假設' };
  }));

  put('Costs', [
    ['C01', '餐飲', '[Planned] 餐飲（120 人，約 12 桌）', 360000, '1.2.5', '2027-01-12'],
    ['C02', '場地', '[Planned] 場地租借', 60000, '1.2.3', '2026-12-11'],
    ['C03', '視聽設備', '[Planned] 音響、投影與麥克風', 45000, '1.5.2', '2027-01-08'],
    ['C04', '主持與節目', '[Planned] 主持人與表演', 35000, '1.3.2', '2026-12-24'],
    ['C05', '抽獎紀念品', '[Planned] 抽獎獎品與紀念品', 40000, '1.3.5', '2027-01-08'],
    ['C06', '攝影', '[Planned] 攝影與影像紀錄', 15000, '1.5.3', '2027-01-08'],
    ['C07', '行政物資', '[Planned] 名牌、佈置與文具', 15000, '1.4.5', '2027-01-19'],
    ['C08', '應變準備金', '[Planned] 應變準備金（Contingency Reserve，不分配至工作包）', 30000, '', '']
  ].map(function (c) {
    return { cost_id: c[0], project_id: P, category: c[1], description: c[2], baseline_budget: c[3], wbs_id: c[4] ? idOf(c[4]) : '',
      committed_amount: '', actual_amount: '', forecast_amount: '', payment_status: 'Not Committed', due_date: c[5] };
  }));

  put('Risks', [
    ['RK01', '理想場地檔期被其他公司搶訂（尾牙旺季）', 'Venue', 3, 5, 'R002', 'Mitigate', '12/08 前完成場勘並保留 2 家備選', '改用備選場地並調整預算', '首選場地未於 12/09 回覆檔期'],
    ['RK02', '餐飲食安或特殊飲食需求未被滿足', 'Vendor', 2, 5, 'R002', 'Mitigate', '試菜並確認過敏原標示、素食比例', '現場備用餐點與醫療聯絡窗口', '試菜評分 < 4 或報名表飲食需求未回收'],
    ['RK03', '報名人數變動造成桌數誤差', 'People', 4, 3, 'R006', 'Mitigate', '設定報名截止與 +5% 緩衝', '與餐廳約定最終桌數調整期限', '截止前 3 天回覆率 < 85%'],
    ['RK04', '視聽設備當日故障', 'Technical', 3, 4, 'R005', 'Mitigate', '彩排完整測試並要求備援設備', '備用麥克風與筆電、廠商技師駐場', '彩排出現設備問題'],
    ['RK05', '寒流或天候影響出席與交通', 'Weather', 2, 3, 'R002', 'Accept', '活動前 3 天追蹤天氣並提醒交通', '調整報到時間與接駁', '中央氣象署發布低溫特報'],
    ['RK06', '結案期間鄰近農曆春節，結算與報告延誤', 'Schedule', 4, 2, 'R003', 'Mitigate', '活動前預先準備驗收單與報告範本', '提前與供應商約定發票期限', '1/26 前未收到供應商發票'],
    ['RK07', '物價上漲造成預算超支', 'Budget', 3, 4, 'R003', 'Mitigate', '早期鎖定報價並保留應變準備金', '動用應變準備金或縮減非核心項目', '任一類別承諾金額 > 基準 95%'],
    ['RK08', '主持人臨時無法出席', 'People', 2, 4, 'R004', 'Transfer', '合約約定替代主持人條款', '啟用內部備援主持人', '活動前 7 天主持人未確認腳本']
  ].map(function (r) {
    var score = r[3] * r[4];
    return { risk_id: r[0], project_id: P, risk_description: '[Demo] ' + r[1], category: r[2], probability: r[3], impact: r[4], risk_score: score,
      severity: score >= 20 ? 'Critical' : score >= 15 ? 'High' : score >= 8 ? 'Medium' : 'Low', owner_id: r[5], response_strategy: r[6],
      mitigation_action: r[7], contingency_plan: r[8], trigger: r[9], status: 'Open', review_date: '2026-12-04' };
  }));

  put('Issues', [
    { issue_id: 'IS01', project_id: P, title: '[Demo] 專案發起人與專案經理尚未正式指定', description: '[Demo] 示範問題：專案章程簽核需先確認 Sponsor 與 PM。',
      category: 'Resource', severity: 'High', priority: 'High', owner_id: 'R009', reporter_id: 'R001', status: 'Open', created_date: '2026-11-23',
      due_date: '2026-11-26', linked_wbs_id: 'WBS-111' },
    { issue_id: 'IS02', project_id: P, title: '[Demo] 120 人飲食需求調查欄位尚未定義', description: '[Demo] 示範問題：報名表需包含素食、過敏原欄位。',
      category: 'Scope', severity: 'Medium', priority: 'Medium', owner_id: 'R006', reporter_id: 'R002', status: 'Open', created_date: '2026-11-23',
      due_date: '2026-12-07', linked_wbs_id: 'WBS-141' }
  ]);

  var raci = [];
  L3.forEach(function (k) {
    var d = idOf(k[0]), owner = k[3];
    raci.push({ deliverable_id: d, resource_id: owner, responsibility_type: 'R' });
    raci.push({ deliverable_id: d, resource_id: owner === 'R001' ? 'R009' : 'R001', responsibility_type: 'A' });
    if (owner !== 'R003' && /合約|預算|採購|付款/.test(k[1] + k[2])) raci.push({ deliverable_id: d, resource_id: 'R003', responsibility_type: 'C' });
    if (owner !== 'R001' && owner !== 'R009') raci.push({ deliverable_id: d, resource_id: 'R009', responsibility_type: 'I' });
  });
  put('RACI', raci.map(function (r, i) { r.raci_id = 'RACI-' + ('00' + (i + 1)).slice(-3); r.project_id = P; return r; }));

  put('Requirements', [
    ['REQ-001', 'Sponsor', '活動須於 2027-01-22 18:00–21:00 舉辦', 'Critical', '1.5.6', 'ACC-06'],
    ['REQ-002', 'Sponsor', '總支出不超過 NT$600,000', 'Critical', '1.6.1', 'ACC-02'],
    ['REQ-003', '員工代表', '提供素食與過敏原友善餐點', 'High', '1.2.4,1.2.5', 'ACC-03'],
    ['REQ-004', '人資部', '年度表揚與抽獎流程公開透明', 'High', '1.3.3,1.3.5', 'ACC-04'],
    ['REQ-005', '行政部', '活動零重大安全事故，具緊急應變計畫', 'Critical', '1.6.4,1.5.4', 'ACC-05'],
    ['REQ-006', 'Sponsor', '活動滿意度平均 ≥ 4.3／5', 'High', '1.7.1', 'ACC-07'],
    ['REQ-007', 'Sponsor', '活動後 10 個工作天內完成結案報告', 'Medium', '1.7.3', 'ACC-08']
  ].map(function (r) {
    var ids = r[4].split(',').map(idOf).join(',');
    return { requirement_id: r[0], project_id: P, source: r[1], stakeholder_id: '', requirement_description: '[Demo] ' + r[2], priority: r[3],
      acceptance_criteria: r[2], status: 'Draft', linked_wbs_ids: ids, linked_deliverable_ids: ids, linked_test_ids: r[5], version: 'v1.0-draft' };
  }));

  put('Acceptance', [
    ['ACC-01', '1.1.1', '專案章程簽核', 'R009', '2026-11-26', true],
    ['ACC-02', '1.6.1', '成本基準核准（≤ NT$600,000）', 'R009', '2026-12-11', true],
    ['ACC-03', '1.2.4', '菜單與特殊飲食覆蓋確認', 'R001', '2026-12-23', true],
    ['ACC-04', '1.3.6', 'Run-down 定稿（含表揚與抽獎）', 'R009', '2026-12-25', true],
    ['ACC-05', '1.6.4', '緊急應變計畫確認', 'R001', '2027-01-15', true],
    ['ACC-06', '1.5.5', '技術與流程彩排通過', 'R001', '2027-01-20', true],
    ['ACC-07', '1.7.1', '滿意度調查結果（目標 ≥ 4.3）', 'R009', '2027-01-26', false],
    ['ACC-08', '1.7.3', '結案報告核准', 'R009', '2027-02-05', true]
  ].map(function (a) {
    return { acceptance_id: a[0], project_id: P, deliverable_id: idOf(a[1]), acceptance_item: a[2], acceptance_criteria: '依 WBS 驗收標準', reviewer_id: a[3],
      planned_review_date: a[4], actual_review_date: '', result: 'Pending', is_critical: a[5] };
  }));

  put('Communications', [
    ['MTG-01', '專案啟動會議（Kick-off）', '2026-11-27', '14:00', '15:30', '專案目標、範圍、角色、里程碑與溝通機制'],
    ['MTG-02', '每週進度會議 #1', '2026-12-04', '10:00', '10:45', '進度、風險、問題、決策事項'],
    ['MTG-03', '場地與預算確認會議', '2026-12-11', '14:00', '15:00', '場地簽約、成本基準核准'],
    ['MTG-04', '每週進度會議 #2', '2026-12-18', '10:00', '10:45', '進度、風險、問題、決策事項']
  ].map(function (m) {
    return { meeting_id: m[0], project_id: P, meeting_title: m[1], meeting_date: m[2], start_time: m[3], end_time: m[4], organizer_id: 'R001',
      attendee_ids: 'R001,R002,R003,R004,R005,R006,R007,R008', agenda: '[Planned] ' + m[5], meeting_status: 'Scheduled' };
  }));

  put('Documents', [
    ['Project Charter', '專案章程', 'R001', '2026-11-26'], ['Scope Statement', '範圍說明書', 'R001', '2026-12-04'],
    ['Project Management Plan', '專案管理計畫', 'R001', '2026-12-04'], ['Requirements', '需求清單', 'R001', '2026-12-04'],
    ['WBS Dictionary', 'WBS 字典', 'R001', '2026-12-04'], ['Risk Register', '風險登錄表', 'R001', '2026-12-11'],
    ['Change Log', '變更紀錄', 'R001', '2026-12-04'], ['Status Report', '每週狀態報告', 'R001', '2026-12-04'],
    ['Meeting Minutes', '啟動會議紀錄', 'R001', '2026-11-27'], ['Vendor Contracts', '供應商合約彙整', 'R007', '2027-01-12'],
    ['Acceptance Report', '驗收報告', 'R003', '2027-01-29'], ['Project Closure Report', '結案報告', 'R001', '2027-02-05'],
    ['Lessons Learned', '經驗學習紀錄', 'R001', '2027-02-05']
  ].map(function (d, i) {
    return { document_id: 'DOC-' + ('0' + (i + 1)).slice(-2), project_id: P, document_category: d[0], document_name: d[1], document_version: 'v0.1',
      owner_id: d[2], reviewer_id: 'R009', status: 'Not Started', planned_delivery_date: d[3] };
  }));

  put('Execution', [
    ['活動前場勘', '1.5.4', '2027-01-15 14:00', '2027-01-15 16:00', 'R002', '動線、消防通道、電源位置確認'],
    ['供應商到場', '1.5.6', '2027-01-22 13:00', '2027-01-22 14:00', 'R007', '餐飲、視聽、攝影廠商皆完成報到'],
    ['設備安裝', '1.5.6', '2027-01-22 14:00', '2027-01-22 15:30', 'R005', '音響、投影、燈光安裝完成'],
    ['音響及視訊測試', '1.5.5', '2027-01-22 15:30', '2027-01-22 16:00', 'R005', '所有麥克風、投影片、影片播放正常'],
    ['主持彩排', '1.5.5', '2027-01-22 16:00', '2027-01-22 17:00', 'R004', '主持人與表演者走位完成'],
    ['參加者報到', '1.4.5', '2027-01-22 17:15', '2027-01-22 18:00', 'R006', '報到率 ≥ 95%'],
    ['正式活動', '1.5.6', '2027-01-22 18:00', '2027-01-22 21:00', 'R001', '依 Run-down 進行'],
    ['撤場與清點', '1.5.6', '2027-01-22 21:00', '2027-01-22 22:30', 'R002', '設備清點無短缺、場地復原']
  ].map(function (e, i) {
    return { execution_id: 'EX-' + ('0' + (i + 1)).slice(-2), project_id: P, wbs_id: idOf(e[1]), event_stage: e[0], planned_start: e[2], planned_end: e[3],
      owner_id: e[4], completion_percent: 0, go_no_go_criteria: e[5], result: 'Pending', notes: '[Planned]' };
  }));

  put('Estimates', [
    ['參加者服務（人數驅動）', 'Average', 120, 0.25, '每位參加者約 0.25 小時（報名、座位、報到）'],
    ['供應商管理', 'High', 6, 8, '每家供應商約 8 小時（詢價、簽約、驗收）'],
    ['節目單元', 'Average', 8, 6, '每個節目單元約 6 小時（設計、排練、協調）'],
    ['場地與現場需求', 'High', 1, 40, '場地全案約 40 小時（場勘、佈置、應變）'],
    ['專案治理與報告', 'Average', 9, 4, '每週約 4 小時，共 9 週']
  ].map(function (e, i) {
    var hrs = e[2] * e[3];
    return { estimate_id: 'EST-' + ('0' + (i + 1)).slice(-2), project_id: P, component_name: e[0], estimation_method: 'EventComplexity', complexity_level: e[1],
      quantity: e[2], unit_effort_hours: e[3], estimated_hours: hrs, estimated_cost: Math.round(hrs * 650),
      assumptions: '[Demo] ' + e[4] + '；平均時薪 NT$650 為假設值。Event Complexity 與 Function Point 計量意義不同，不可混用。' };
  }));

  var email = Session.getEffectiveUser().getEmail();
  if (email) put('Users', [{ user_id: 'U001', email: email, display_name: '系統管理員', role: 'Admin', resource_id: 'R001', active: true }]);
  SETTINGS_CACHE_ = null;
}
