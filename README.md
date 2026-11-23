# YearEnd PMO｜Enterprise Project Management System — 第一階段

2027 企業尾牙專案管理系統（YEP-2027-001）。後端用 Google Apps Script，資料存在 Google Sheets，前端是 HtmlService 單頁應用（SPA）。

> 這是**第一階段**的交付：資料庫 Schema、初始化腳本、示範資料、後端 Service、權限與稽核，以及連接真實資料的 Dashboard 首頁。其他模組目前都能用泛用資料表讀寫，但甘特圖、RACI 矩陣、活動當日時序表這些專屬視圖要到第 2、3 階段才會做。這一版**不是**整套系統的完成版。

---

## 1. 檔案結構

```text
YearEnd-PMO/
├── appsscript.json      # 時區 Asia/Taipei、V8、OAuth 範圍、Web App 部署設定
├── Config.gs            # 全域設定、列舉、20 張資料表 Schema（DSL）、中文欄位標籤
├── Utils.gs             # 日期／工作日曆、型別、公式注入防護、錯誤物件
├── Database.gs          # 共用 CRUD Repository（LockService、row_version 樂觀鎖、Soft Delete）
├── Auth.gs              # 使用者識別、角色權限（Users / Roles 工作表）
├── AuditService.gs      # 稽核紀錄（只新增，不能改）
├── Services.gs          # 領域規則：WBS、里程碑、成本、RACI、問題、風險、變更、驗收、快照
├── DashboardService.gs  # Dashboard 即時計算：KPI、S-Curve、EVM、健康度…
├── Code.gs              # doGet、公開 API（google.script.run）
├── Setup.gs             # setupDatabase()、示範資料、觸發器、addUser()
├── Index.html           # 版面骨架（Sidebar / Topbar）
├── Styles.html          # 設計系統（淺色／深色、RWD）
├── Scripts.html         # 前端 SPA：Dashboard、泛用資料表、表單、圖表
└── README.md
```

**和原本建議的結構不同之處，以及原因**

- 原本建議每個模組各一個 Service 檔（IssueService、RiskService…）。現在改成「共用 CRUD Repository（Database.gs）＋各表的 `beforeSave` 規則 Hook（Services.gs）」。原因是 18 張以上的表，CRUD 邏輯幾乎一樣，拆成十幾個檔只會重複程式碼。各表的商業規則仍然集中寫在 Hook 裡，要新增一張表只需要改 Config.gs 的一行 Schema。
- 原本建議 Dashboard.html、WBS.html 等每頁一個 HTML 檔。現在合併成 `Scripts.html`，所有頁面由同一個 SPA 路由切換。HtmlService 的 include 會把所有檔案合成一頁，拆檔不會讓載入變快；集中管理則可以共用元件（表格、表單、Modal）。
- 另外新增了 `Users`、`Roles` 兩張表（D19、D20），讓權限不用寫死在 HTML 裡。

## 2. Google Sheets Schema

試算表名稱：`YearEnd_PMO_2027_Database`。第 1 列是固定的英文欄位代碼（滑鼠移到儲存格上會出現中文註解）。每張表最後都會自動加上兩個系統欄位：`row_version`（樂觀鎖版本）和 `is_deleted`（Soft Delete）。

| 代碼 | 工作表 | 主鍵 | 說明 |
|---|---|---|---|
| D01 | Projects | project_id | 另外加了 theme、event_date、participants |
| D02 | WBS | wbs_id | 樹狀結構、權重、相依、基準鎖定 |
| D03 | Milestones | milestone_id | |
| D04 | Resources | resource_id | |
| D05 | RACI | raci_id | `deliverable_id` 指向 WBS 的 `wbs_id`（交付成果定義在工作包上） |
| D06 | Costs | cost_id | |
| D07 | Issues | issue_id | 另外加了 `linked_risk_id`（風險轉問題時的關聯） |
| D08 | Estimates | estimate_id | EventComplexity／FunctionPoint 分開，不可混用 |
| D09 | Requirements | requirement_id | |
| D10 | Changes | change_id | 另外加了 `history_json`（流程歷程） |
| D11 | Risks | risk_id | 另外加了 `linked_issue_id` |
| D12 | Communications | meeting_id | |
| D13 | Acceptance | acceptance_id | 另外加了 `is_critical`（關鍵驗收） |
| D14 | Documents | document_id | |
| D15 | Execution | execution_id | |
| D16 | WeeklySnapshots | snapshot_id | 另外加了 in_progress／not_started／delayed／blocked 計數，C3 趨勢圖需要 |
| D17 | AuditLogs | log_id | 只新增 |
| D18 | Settings | setting_key | 門檻、工作日、假日 |
| D19 | Users | user_id | email → 角色 → resource_id |
| D20 | Roles | role | 權限字串 |

完整欄位與型別請看 `Config.gs` 的 `TABLES`。`setupDatabase()` 會依型別自動建立以下設定：

- 下拉選單（enum）
- 日期驗證與 `yyyy-mm-dd` 格式
- 金額 ≥ 0、以 `NT$` 顯示
- 百分比 0–100、機率與影響 1–5
- 勾選框
- 凍結標題列、狀態欄的條件格式
- 標題列保護（只警告，不阻擋）

## 3. 部署步驟

1. **建立專案**：到 <https://script.google.com> 新增專案，命名為 `YearEnd PMO`。也可以先建一份空白試算表，再從「擴充功能 → Apps Script」建立綁定的專案。
2. **新增檔案**：把每個 `.gs` 用「＋ → 指令碼」新增，名稱照抄（不用打副檔名）；把每個 `.html` 用「＋ → HTML」新增，名稱必須是 `Index`、`Styles`、`Scripts`。
3. **appsscript.json**：到「專案設定」勾選「在編輯器中顯示 appsscript.json」，然後用本專案的內容整份取代。
4. **初始化**：在編輯器上方選 `setupDatabase` 並執行，第一次執行會要求授權。
   - 已預設使用你的試算表 `1VOrrbgMmHFSg_EXUL_nzFOH8t6bL2aGGraRrI6paek0`（`Config.gs` 的 `DEFAULT_SPREADSHEET_ID`）。若清空此值：專案綁定在試算表上時使用該試算表；否則會自動建立 `YearEnd_PMO_2027_Database`。
   - Spreadsheet ID 存在「專案設定 → 指令碼屬性 → `SPREADSHEET_ID`」。前端沒有任何方法能修改它。
   - 要改用另一份試算表時，在編輯器執行 `setSpreadsheetId('新ID')`，再執行 `setupDatabase()`。
5. **授權**：會請求這些權限：Sheets（讀寫）、userinfo.email（辨識使用者）、script.scriptapp（建立每週觸發器）。
6. **補登假日**：在 Settings 的 `HOLIDAYS` 填入 2027 年國定假日（請依人事行政總處公告）。尤其是 **2027 春節**：MS07 的基準日 2027-02-05 只用「週一到週五」推算，還沒扣掉春節假期，請補登後重新確認。
7. **部署**：選「部署 → 新增部署作業 → 類型：網頁應用程式」，設定方式見下方第 4 節。
8. **加入使用者**：執行 `setupDatabase()` 的人會自動成為 Admin。其他人可以在編輯器執行 `addUser('email','姓名','PM','R001')`，或在系統的 User Roles 頁新增。`resource_id` 要對應 Resources 表，「My Tasks」才會顯示該人員的工作。
9. **每週快照**：在編輯器執行 `installWeeklyTrigger()`，之後每週五 18:00（台北時間）會自動產生快照。
10. **驗證讀取**：開啟 Web App 網址。Dashboard 應顯示 33 個工作包、計畫預算 NT$600,000、未結問題 2 件、高風險 1 項（以示範資料、狀態日 2026-11-23 計算）。也可以在編輯器執行 `healthCheck()` 查看各表筆數。
11. **驗證寫入**：
    - 進 WBS 頁，編輯 1.1.1：填實際開始日 → 把完成率改成 50 → 儲存，Sheets 對應列應該立刻更新，`row_version` 會 +1。
    - 反過來，在 Sheets 直接改某個工作包的完成率，回到系統按「重新整理」，畫面應顯示新值。
12. **權限與錯誤情境**：
    - 用一個不在 Users 表裡的帳號開啟，應看到「尚未被授權」。
    - 用 Viewer 帳號開啟，畫面不會出現新增／儲存按鈕；即使直接呼叫 API，後端也會回傳 FORBIDDEN。
    - 儲存衝突：開兩個分頁編輯同一筆資料，先在 A 分頁儲存，再在 B 分頁儲存，B 會收到「資料已被其他人修改」，而且表單裡的輸入會保留。
    - 讀取失敗：暫時把 `SPREADSHEET_ID` 改成錯誤值，Dashboard 應顯示錯誤狀態和「重試」按鈕，而不是空白頁。
13. **更新版本**：改完程式碼後，選「部署 → 管理部署作業 → 編輯（鉛筆圖示）→ 版本：新版本 → 部署」，網址不會變。如果要測試尚未發布的程式碼，用「測試部署作業」的 /dev 網址。

## 4. 部署身分（請務必閱讀）

系統以 `Session.getActiveUser().getEmail()` 辨識使用者。**取不到 Email 時一律拒絕存取**，不會猜測身分。

| 設定 | Email 能否取得 | 試算表權限 | 適用情境 |
|---|---|---|---|
| **以存取者身分執行**（`USER_ACCESSING`，本專案預設） | 可以，最可靠 | 每位使用者都需要試算表的**編輯權** | 一般 Gmail 帳號、跨網域使用 |
| 以我的身分執行（`USER_DEPLOYING`）＋「網域內所有人」 | 同一個 Workspace 網域內通常可以 | 只有部署者需要 | 公司 Google Workspace（**建議**） |
| 以我的身分執行＋「任何人」 | 跨網域的 Gmail 帳號通常**拿不到** | — | 本系統會拒絕這些使用者 |

**安全取捨**：使用 `USER_ACCESSING` 時，使用者本身就有試算表編輯權，可以繞過系統直接改 Sheets。這種情況下，資料完整性只能靠 Sheets 的資料驗證、版本紀錄和稽核來補強。如果有 Google Workspace，建議把 `appsscript.json` 改成 `"executeAs": "USER_DEPLOYING", "access": "DOMAIN"`，試算表只分享給部署者，所有寫入都會經過後端的驗證與授權。

## 5. 安全與資料完整性（F3 對照）

| # | 要求 | 實作方式 |
|---|---|---|
| 1 | 後端驗證 | `toCell_` 檢查型別、範圍、enum、日期、長度；各表 `beforeSave` 檢查商業規則 |
| 2 | 角色授權 | Roles 權限字串（如 `write:Issues`、`-read:AuditLogs`），每個 API 都經過 `handle_` → `authorize_` |
| 3 | Spreadsheet ID 防竄改 | 只從 Script Properties 讀取；API 不接受 ID 參數 |
| 4 | 競爭寫入 | `LockService.getScriptLock()`；寫入前再確認目標列的 key，避免有人手動排序造成錯列 |
| 5 | 覆寫衝突 | 每次更新都要帶 `row_version`，版本不符時回傳 CONFLICT |
| 6 | XSS | 前端所有輸出都經過 `esc()`；連結只接受 `https://` 並加上 `rel="noopener noreferrer"` |
| 7 | 公式注入 | 以 `= + - @` 等開頭的文字會加上 `'` 前綴；CSV 匯出也一樣 |
| 8 | 金鑰 | 前端沒有任何密鑰，全部用 `google.script.run` 呼叫 |
| 9 | 稽核 | 新增、修改、刪除、復原、基準核准、快照、拒絕存取都會記錄 before／after JSON |
| 10 | 刪除 | Soft Delete；Admin 可以呼叫 `restoreRecord` 復原 |
| 11 | 失敗訊息 | 統一回傳 `{ok:false, error:{code,message}}`，前端顯示錯誤並保留輸入 |
| 12 | 格式檢查 | 日期必須是 `YYYY-MM-DD`、時間 `HH:mm`、金額為非負整數、百分比 0–100、機率／影響 1–5 |

另外，名稱以 `_` 結尾的函式無法從前端呼叫，所以所有內部函式都以 `_` 結尾，只開放有授權包裝的 API。

## 6. 管理邏輯與計算規則

- **WBS 完成率**：只聚合最底層工作包，公式是 `Σ(完成率×權重)/Σ權重`。父層由子層計算，不會重複加總。完全沒有權重時才改用等權重，畫面會明確提示。
- **實際完成**：填寫實際完成日需要 `confirmActual:WBS` 權限，且不能是未來日期；填了之後完成率自動變成 100%、狀態變成 Completed。填完成率之前必須先填實際開始日。
- **衍生狀態**：工作超過計畫完成日還沒完成，就顯示為 Delayed（Blocked、Cancelled 除外）。Dashboard 以狀態日即時計算，所以表內舊的狀態值不會造成誤判。
- **Baseline**：由 PM 或 Admin 按「核准基準」後鎖定，會記錄版本、核准時間並寫入稽核。之後要修改計畫日期、權重、交付成果或驗收標準，都會回傳 `BASELINE_LOCKED`。示範資料的版本是 `v1.0-draft`，**還沒核准**，所以 S-Curve 的 Baseline 標示為「計畫版本」，EVM 也標示「僅供參考」。
- **S-Curve**
  - Baseline：工作包到達計畫完成日時，加上它的權重（步階式累計）。
  - Actual：只用實際完成日認列。完全沒有實績時不畫這條線，並顯示「尚無實際交付資料」。
  - Forecast：已完成的用實際完成日；未逾期的用計畫完成日；已逾期的用「狀態日＋剩餘工期（工期×(1−完成率)，至少 1 個工作日）」。
- **EVM**
  - BAC 只計算已連結到工作包的成本基準，共 NT$570,000。應變準備金 NT$30,000 不分配到工作包，不計入 PMB。
  - PV 依工作包的計畫期間線性分配；EV ＝ 工作包預算 × 完成率；AC ＝ 實際支出。
  - 分母為 0 時顯示 N/A。EAC ＝ BAC ÷ CPI，前提是「目前的成本效率會延續到完工」。
- **健康度**：同時看進度、成本、風險、品質／安全、里程碑五個面向，取最差的一項作為整體健康度。門檻都可以在 Settings 調整。
- **日期**：一律以 Asia/Taipei 計算。工期用工作日（依 Settings 的 `WORKDAYS`、`HOLIDAYS`），延誤天數用日曆天。
- **趨勢圖**：只使用 WeeklySnapshots 的資料。已存在的快照**不能覆寫**，也不會拿目前資料回填成假的歷史。

## 7. 測試結果（實際執行）

測試環境是 **Node.js ＋ 自製的 Apps Script 模擬層**（模擬 SpreadsheetApp、Session、Utilities 等；程式碼放在交付壓縮檔的 `test/` 資料夾）。**這不是真正的 Google 環境。**

**通過：26 項**

- setupDatabase 建立 20 張表；重複執行不會覆蓋既有資料
- KPI 由資料計算（33 個工作包、預算 NT$600,000、實際成本 0、未結問題 2、高風險 1）
- 成本分類加總 ＝ 600,000，BAC ＝ 570,000
- 沒有實績時不畫 Actual 曲線；EVM 分母為 0 時回傳 N/A
- 狀態日設為 2026-12-15：逾期 10 項、進度差異 −29 pt、健康度 Red
- WBS 更新會寫回 Sheets；舊版本更新回傳 CONFLICT
- 拒絕未來的實際日期、循環相依
- 公式字串會被中和
- 風險分數自動計算；風險轉問題保留雙向關聯
- 拒絕同一交付成果有兩位 A
- 變更流程不能跳過 Impact Analysis，歷程完整記錄
- Soft Delete 正常；有子項的 WBS 不能刪除
- 核准基準後計畫日期被鎖定
- 同一週的快照不能重複建立；稽核紀錄完整
- 未授權帳號、取不到 Email、Viewer 寫入、非法資料表名稱都會被拒絕
- 回傳值不含 Date 物件，可以正常序列化

**前端畫面（Playwright 截圖，後端資料是由上述模擬層產生的固定資料）**

- 1440px 桌面版 Dashboard、WBS 樹狀表、編輯表單、390px 手機版都能正常渲染，頁面沒有 JavaScript 錯誤。

**尚未測試**

- 在真正的 Google Apps Script／Sheets 環境部署與執行，包括授權流程、HtmlService iframe、LockService 實際競爭
- 不同部署模式下 `getActiveUser()` 的實際行為
- 從 cdnjs 載入 Chart.js（截圖時改用本機內嵌的 Chart.js 4.4.1）
- Sheets 資料驗證與條件格式的實際外觀
- 每週觸發器、大量資料下的效能

## 8. 示範資料原則

- 所有實際欄位（實際日期、實際支出、驗收結果、快照）都是**空白**或 `Pending`。
- 計畫值、問題、風險都標示 `[Demo]` 或 `[Planned]`；人員都標示「待指定」。
- 估算採 Event Complexity（尾牙專案預設）。單位工時與時薪是**示範假設**，不是標準值。Function Point 模式保留了欄位，但沒有自訂權重：使用時請依你採用的標準（例如 IFPUG）填入。

## 9. 後續階段

- **第 2 階段**：甘特圖、WBS 專屬編輯（拖拉、基準比較）、Issue Kanban、Milestone Timeline
- **第 3 階段**：RACI 矩陣與缺漏檢查視圖、Risk Register 專頁、成本明細與付款流程、Document／Drive 整合、活動當日即時時序表
- **第 4 階段**：在真正的 Google 環境做整合、權限、資料一致性與行動裝置測試，並撰寫操作手冊
