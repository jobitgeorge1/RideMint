(() => {
if (window.__RIDEMINT_APP_LOADED__) {
  console.warn("RideMint app.js already loaded; skipping duplicate init.");
  return;
}
window.__RIDEMINT_APP_LOADED__ = true;

const APP_KEY = "ridemint-pro-config";
const FY_KEY = "ridemint-active-financial-year";
const DEFAULT_SUPABASE_URL = window.RIDEMINT_CONFIG?.SUPABASE_URL || "";
const DEFAULT_SUPABASE_ANON = window.RIDEMINT_CONFIG?.SUPABASE_ANON_KEY || "";
const DEFAULT_TAX_SETTINGS = {
  other_income: 0,
  super_contribution: 0,
  deduction_method: "logbook",
  cents_per_km_rate: 0.88,
  cents_per_km_cap: 5000
};
const VEHICLE_RUNNING_EXPENSE_CATEGORIES = new Set([
  "fuel",
  "maintenance",
  "insurance",
  "registration",
  "car wash",
  "cleaning service"
]);
const today = new Date().toISOString().slice(0, 10);

let supabase = null;
let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let db = { trips: [], fares: [], expenses: [], tolls: [], receipts: [], tax: null, platforms: [] };
let editing = { trips: null, fares: null, expenses: null, tolls: null };
let activeTab = "dashboard";
let activeReportKind = "executive";
let activeFinancialYear = localStorage.getItem(FY_KEY) || String(currentFinancialYearEnd());
let rowActionDelegatesBound = false;
let lastRefreshAt = 0;

const el = (id) => document.getElementById(id);

window.addEventListener("error", (evt) => {
  const msg = evt?.error?.message || evt?.message || "Unexpected app error.";
  if (el("configStatus")) setStatus("configStatus", `Startup error: ${msg}`, true);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

function boot() {
  if (el("buildTag")) el("buildTag").textContent = "Build: RM-2026-07-10a (JS active)";
  registerServiceWorker();
  setStatus("authStatus", "Login to continue.");
  ["tripForm", "expenseForm", "tollForm"].forEach((id) => {
    const f = el(id);
    if (f?.date) f.date.value = today;
  });
  if (el("fareForm")?.date) el("fareForm").date.value = weekRange(today).start;
  if (el("receiptDate")) el("receiptDate").value = today;
  if (el("summaryYear")) el("summaryYear").value = currentFinancialYearEnd();
  wireEvents();
  setupTabs();
  showAuthPage("login");
  loadConfigUI();
  syncConnectionInputs();
}

function wireEvents() {
  bindClick("saveConfigBtnAdmin", saveConfigFromAdmin);
  bindClick("signupBtn", signUp);
  bindClick("loginBtn", signIn);
  bindClick("goSignUpBtn", () => showAuthPage("signup"));
  bindClick("goLoginBtn", () => showAuthPage("login"));
  bindClick("logoutBtn", logout);

  bindSubmit("tripForm", onAddTrip);
  bindSubmit("fareForm", onAddFare);
  bindSubmit("expenseForm", onAddExpense);
  bindSubmit("tollForm", onAddToll);
  bindSubmit("taxForm", onSaveTax);

  bindClick("refreshSummaryBtn", renderReport);
  bindClick("reportPdfBtn", openReportPdfView);
  bindClick("reportExcelBtn", () => downloadReportWorkbook(activeReportKind));
  bindClick("reportCsvBtn", () => downloadReportCsv(activeReportKind));
  bindClick("reportFullWorkbookBtn", () => downloadReportWorkbook("full"));
  bindClick("printReportBtn", () => downloadReportWorkbook("full"));
  bindClick("printReportBtn2", () => downloadReportWorkbook("full"));
  bindClick("exportLogbookCsvBtn", exportLogbookCsv);
  bindClick("saveAdminRoleBtn", updateUserRole);
  bindClick("refreshAdminsBtn", loadAdminUsers);
  bindClick("addPlatformBtn", addPlatformOption);
  bindClick("refreshPlatformsBtn", loadPlatformOptions);
  bindClick("importWorkbookBtn", importWorkbook);
  bindClick("clearAllDataBtn", clearAllAccountData);
  bindClick("downloadAllReceiptsBtn", downloadAllReceiptsPdf);
  el("financialYearSelect")?.addEventListener("change", async (evt) => {
    activeFinancialYear = evt.target.value || "all";
    localStorage.setItem(FY_KEY, activeFinancialYear);
    if (activeFinancialYear !== "all" && el("summaryYear")) el("summaryYear").value = activeFinancialYear;
    if (supabase && currentUser) await loadTax();
    renderAll();
  });
  el("receiptCameraInput")?.addEventListener("change", onReceiptSelected);
  el("receiptUploadInput")?.addEventListener("change", onReceiptSelected);
  bindClick("tripCancelEditBtn", () => clearEdit("trips"));
  bindClick("fareCancelEditBtn", () => clearEdit("fares"));
  bindClick("expenseCancelEditBtn", () => clearEdit("expenses"));
  bindClick("tollCancelEditBtn", () => clearEdit("tolls"));
  bindFareFeeAutoCalc();
  bindFareWeekFields();
  bindTaxLivePreview();
  bindExpenseGstCalc();
  bindReportSwitcher();
  bindRowActionDelegates();
  bindAutoRefresh();
}

function bindReportSwitcher() {
  document.querySelectorAll(".report-switch").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeReportKind = btn.dataset.reportKind || "executive";
      updateReportSwitcher();
      renderReport();
    });
  });
}

function bindFareFeeAutoCalc() {
  const form = el("fareForm");
  if (!form || !form.platform_fee) return;
  const recalc = () => {
    const fee = n(form.platform_fee.value);
    const tip = n(form.tip_extra?.value);
    const gross = n(form.gross?.value);
    form.platform_fee_gst.value = (fee / 11).toFixed(2);
    if (form.net_payout) form.net_payout.value = round2(gross + tip - fee).toFixed(2);
  };
  form.platform_fee.addEventListener("input", recalc);
  form.gross?.addEventListener("input", recalc);
  form.tip_extra?.addEventListener("input", recalc);
  recalc();
}

function bindFareWeekFields() {
  const form = el("fareForm");
  if (!form?.date) return;
  form.date.addEventListener("input", updateFareWeekFields);
  updateFareWeekFields();
}

function bindTaxLivePreview() {
  const form = el("taxForm");
  if (!form) return;
  ["other_income", "super_contribution", "deduction_method", "cents_per_km_rate", "cents_per_km_cap"].forEach((name) => {
    form[name]?.addEventListener("input", () => {
      updateAutoTaxPct();
      renderTaxBreakdown();
    });
    form[name]?.addEventListener("change", () => {
      updateAutoTaxPct();
      renderTaxBreakdown();
    });
  });
}

function bindExpenseGstCalc() {
  const form = el("expenseForm");
  if (!form?.amount) return;
  const recalc = () => {
    const gstAmount = n(form.gst_amount?.value);
    const claimable = form.gst_claimable?.value === "true";
    const businessUsePct = currentBusinessUsePct();
    if (form.gst_credit) form.gst_credit.value = claimable ? round2(gstAmount * businessUsePct).toFixed(2) : "0.00";
  };
  form.amount.addEventListener("input", () => {
    if (!form.gst_amount.dataset.manual) form.gst_amount.value = round2(n(form.amount.value) / 11).toFixed(2);
    recalc();
  });
  form.category?.addEventListener("change", () => {
    if (form.is_vehicle_expense) form.is_vehicle_expense.value = isVehicleRunningExpense({ category: form.category.value }) ? "true" : "false";
  });
  form.gst_amount?.addEventListener("input", () => {
    form.gst_amount.dataset.manual = "true";
    recalc();
  });
  form.gst_claimable?.addEventListener("change", recalc);
  form.gst_amount.value = round2(n(form.amount.value) / 11).toFixed(2);
  recalc();
}

function saveConfigFromAdmin() {
  return saveConfig();
}

function bindClick(id, handler) {
  const node = el(id);
  if (!node) return;
  node.addEventListener("click", handler);
}

function bindSubmit(id, handler) {
  const node = el(id);
  if (!node) return;
  node.addEventListener("submit", handler);
}

function loadConfigUI() {
  const cfg = readConfigWithDefaults();
  if (!cfg?.url || !cfg?.anon) {
    setStatus("authStatus", "System config missing. Admin: login from a configured browser and set Settings.");
    return;
  }
  syncConnectionInputs();
  initSupabase(cfg.url, cfg.anon);
}

function syncConnectionInputs() {
  const cfg = readConfigWithDefaults();
  if (el("sbUrlAdmin")) el("sbUrlAdmin").value = cfg.url || "";
  if (el("sbAnonAdmin")) el("sbAnonAdmin").value = cfg.anon || "";
}

function readConfig() {
  try { return JSON.parse(localStorage.getItem(APP_KEY) || "{}"); } catch { return {}; }
}

function readConfigWithDefaults() {
  const c = readConfig();
  return {
    url: c.url || DEFAULT_SUPABASE_URL,
    anon: c.anon || DEFAULT_SUPABASE_ANON
  };
}

async function saveConfig() {
  const url = (el("sbUrlAdmin")?.value || "").trim();
  const anon = (el("sbAnonAdmin")?.value || "").trim();
  if (!url || !anon) return setStatus("settingsStatus", "Enter URL and anon key.", true);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    return setStatus("settingsStatus", "URL format should be https://<project-ref>.supabase.co", true);
  }
  if (!window.supabase?.createClient) {
    return setStatus("settingsStatus", "Supabase library failed to load. Check internet and reload.", true);
  }
  const btn = el("saveConfigBtnAdmin");
  btn.disabled = true;
  setStatus("settingsStatus", "Testing connection...");
  localStorage.setItem(APP_KEY, JSON.stringify({ url, anon }));
  syncConnectionInputs();
  const ok = await initSupabase(url, anon);
  btn.disabled = false;
  if (!ok) return;
  setStatus("settingsStatus", "Connection saved and verified.");
}

async function initSupabase(url, anon) {
  try {
    supabase = window.supabase.createClient(url, anon);
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    currentUser = data?.session?.user || null;
    supabase.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      if (currentUser) {
        await refreshAll(true);
      } else {
        currentProfile = null;
        isAdmin = false;
        db = { trips: [], fares: [], expenses: [], tolls: [], receipts: [], tax: null, platforms: [] };
        renderAll();
      }
      toggleApp();
    });
    toggleApp();
    if (currentUser) await refreshAll(true);
    return true;
  } catch (err) {
    const msg = err?.message || "Could not initialize Supabase.";
    setStatus("settingsStatus", `Connection failed: ${msg}`, true);
    supabase = null;
    currentUser = null;
    toggleApp();
    return false;
  }
}

async function signUp() {
  if (!supabase) return setStatus("authStatus", "Configure Supabase first.", true);
  const fullName = (el("signupFullName")?.value || "").trim();
  const email = el("signupEmail").value.trim();
  const password = el("signupPassword").value;
  const password2 = el("signupPassword2")?.value || "";
  if (!fullName) return setStatus("authStatus", "Enter full name.", true);
  if (password.length < 6) return setStatus("authStatus", "Password must be at least 6 characters.", true);
  if (password !== password2) return setStatus("authStatus", "Passwords do not match.", true);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName
      }
    }
  });
  if (error) return setStatus("authStatus", error.message, true);
  if (data?.session?.user) {
    currentProfile = await ensureProfile(data.session.user.id, fullName, email);
    currentUser = data.session.user;
    setAdminFlag();
    toggleApp();
    await refreshAll();
    return setStatus("authStatus", "Sign-up complete. You are now signed in.");
  }
  setStatus("authStatus", "Sign-up submitted. Check your email to confirm, then sign in. If you want instant signup, disable email confirmation in Supabase Auth settings.");
}

async function signIn() {
  if (!supabase) return setStatus("authStatus", "Configure Supabase first.", true);
  const email = el("loginEmail").value.trim();
  const password = el("loginPassword").value;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return setStatus("authStatus", error.message, true);
  currentUser = data.user;
  currentProfile = await ensureProfile(
    currentUser.id,
    currentUser.user_metadata?.full_name || "",
    currentUser.email || email
  );
  setAdminFlag();
  toggleApp();
  await refreshAll();
  setStatus("authStatus", "Signed in.");
}

async function ensureProfile(userId, fullName, email) {
  const payload = {
    id: userId,
    full_name: fullName || "",
    email: email || "",
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("profiles").upsert(payload, { onConflict: "id" });
  if (error) {
    setStatus("authStatus", `Profile save warning: ${error.message}`, true);
  }
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data || null;
}

async function logout() {
  if (!supabase) return;
  await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
  isAdmin = false;
  db = { trips: [], fares: [], expenses: [], tolls: [], receipts: [], tax: null, platforms: [] };
  editing = { trips: null, fares: null, expenses: null, tolls: null };
  toggleApp();
  renderAll();
}

function toggleApp() {
  el("appRoot").classList.toggle("hidden", !currentUser);
  el("logoutBtn").classList.toggle("hidden", !currentUser);
  el("printReportBtn").classList.toggle("hidden", !currentUser);
  el("authPages").classList.toggle("hidden", !!currentUser);
  applyAdminVisibility();
}

function showAuthPage(type) {
  el("loginPage").classList.toggle("hidden", type !== "login");
  el("signupPage").classList.toggle("hidden", type !== "signup");
}

function setupTabs() {
  const activate = (key) => {
    document.querySelectorAll(".tab, .nav-item-lite").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(`.tab[data-tab="${key}"], .nav-item-lite[data-tab="${key}"]`).forEach((x) => x.classList.add("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    const panel = el(`tab-${key}`);
    if (panel) panel.classList.remove("hidden");
    activeTab = key;
    updateSectionHeader(key);
  };
  document.querySelectorAll(".tab, .nav-item-lite").forEach((t) => {
    t.addEventListener("click", () => activate(t.dataset.tab));
  });
  activate("dashboard");
}

function updateSectionHeader(key) {
  const map = {
    dashboard: ["Dashboard", "Weekly Uber money view with GST, fees, tolls and tax."],
    logbook: ["Logbook", "ATO-compatible trip and odometer record."],
    income: ["Income", "Weekly Uber entries from Monday to Sunday."],
    expenses: ["Expenses", "Costs and claimable GST credits."],
    tolls: ["Tolls", "Track toll payments and reimbursements."],
    tax: ["Tax", "Tax inputs and calculated effective tax rate."],
    reports: ["Reports", "BAS, monthly, quarterly, and yearly summaries."],
    settings: ["Settings", "Admin controls and platform configuration."]
  };
  const [title, sub] = map[key] || ["Dashboard", ""];
  if (el("sectionTitle")) el("sectionTitle").textContent = title;
  if (el("sectionSubtitle")) el("sectionSubtitle").textContent = sub;
}

async function refreshAll(force = false) {
  const now = Date.now();
  if (!force && now - lastRefreshAt < 2000) return;
  lastRefreshAt = now;
  await loadProfile();
  applyAdminVisibility();
  await Promise.all([loadTable("trips"), loadTable("fares"), loadTable("expenses"), loadTable("tolls"), loadTable("receipts"), loadTax(), loadPlatformOptions()]);
  prefillTripStartOdo();
  renderAll();
  if (isAdmin) {
    await loadAdminUsers();
    renderPlatformsTable();
  }
}

async function loadProfile() {
  if (!currentUser) return;
  const { data } = await supabase.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
  currentProfile = data || null;
  setAdminFlag();
}

function setAdminFlag() {
  const role = (currentProfile?.role || "driver").toLowerCase();
  const email = (currentUser?.email || "").toLowerCase();
  isAdmin = role === "admin" || email === "jobitpgeorge@gmail.com";
}

function applyAdminVisibility() {
  const guard = el("settingsGuard");
  const body = el("adminSettingsBody");
  if (guard) guard.classList.toggle("hidden", isAdmin);
  if (body) body.classList.toggle("hidden", !isAdmin);
}

async function loadAdminUsers() {
  if (!isAdmin || !supabase) return;
  const { data, error } = await supabase
    .from("profiles")
    .select("email, full_name, role, updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) {
    return setStatus("settingsStatus", `Admin users load failed: ${error.message}`, true);
  }
  el("adminUsersTable").innerHTML = tableHtml(
    ["Name", "Email", "Role", "Updated"],
    (data || []).map((x) => [esc(x.full_name || ""), esc(x.email || ""), esc(x.role || "driver"), esc((x.updated_at || "").replace("T", " ").slice(0, 16))])
  );
  setStatus("settingsStatus", "Admin users loaded.");
}

async function updateUserRole() {
  if (!isAdmin || !supabase) return setStatus("settingsStatus", "Admin access required.", true);
  const email = (el("adminEmailInput").value || "").trim().toLowerCase();
  const role = (el("adminRoleInput").value || "driver").trim().toLowerCase();
  if (!email) return setStatus("settingsStatus", "Enter user email.", true);
  if (!["admin", "driver"].includes(role)) return setStatus("settingsStatus", "Invalid role.", true);
  const { error } = await supabase.from("profiles").update({ role, updated_at: new Date().toISOString() }).eq("email", email);
  if (error) return setStatus("settingsStatus", `Role update failed: ${error.message}`, true);
  setStatus("settingsStatus", `Role updated for ${email}: ${role}`);
  await loadAdminUsers();
}

async function loadTable(table) {
  const orderColumn = table === "receipts" ? "receipt_date" : "date";
  const { data, error } = await supabase.from(table).select("*").order(orderColumn, { ascending: false });
  if (error) return;
  db[table] = data || [];
}

async function loadTax() {
  const fy = taxFinancialYearKey();
  let { data, error } = await supabase.from("tax_settings").select("*").eq("financial_year", fy).limit(1).maybeSingle();
  if (!data && fy !== "all") {
    const fallback = await supabase.from("tax_settings").select("*").eq("financial_year", "all").limit(1).maybeSingle();
    if (fallback.data) data = { ...fallback.data, financial_year: fy, id: null };
  }
  if (error) setStatus("taxStatus", `Tax settings load warning: ${error.message}`, true);
  db.tax = normalizeTaxSettings(data);
  const form = el("taxForm");
  form.other_income.value = db.tax.other_income || 0;
  form.super_contribution.value = db.tax.super_contribution || 0;
  if (form.deduction_method) form.deduction_method.value = db.tax.deduction_method;
  if (form.cents_per_km_rate) form.cents_per_km_rate.value = db.tax.cents_per_km_rate;
  if (form.cents_per_km_cap) form.cents_per_km_cap.value = db.tax.cents_per_km_cap;
}

function updateAutoTaxPct() {
  const m = computeMetrics(readDraftTaxValues());
  if (el("autoTaxPct")) el("autoTaxPct").value = pct(m.effectiveTaxRate);
}

function prefillTripStartOdo() {
  const f = el("tripForm");
  if (!f || !f.odo_start || !db.trips.length) return;
  const lastEnd = db.trips.reduce((max, t) => Math.max(max, n(t.odo_end)), 0);
  if (!f.odo_start.value) f.odo_start.value = f2(lastEnd);
}

async function loadPlatformOptions() {
  if (!supabase) return;
  const { data, error } = await supabase.from("platform_options").select("*").order("is_default", { ascending: false }).order("name", { ascending: true });
  if (error) return;
  db.platforms = data || [];
  renderPlatformSelect();
}

function renderPlatformSelect() {
  const sel = el("platformSelect");
  if (!sel) return;
  const list = db.platforms.length ? db.platforms : [{ name: "Uber", is_default: true }];
  sel.innerHTML = list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  const def = list.find((p) => p.is_default) || list[0];
  if (def) sel.value = def.name;
}

function updateFareWeekFields() {
  const form = el("fareForm");
  if (!form?.date) return;
  const date = form.date.value || today;
  const week = weekRange(date);
  form.date.value = week.start;
  if (el("fareWeekStart")) el("fareWeekStart").value = week.start;
  if (el("fareWeekEnd")) el("fareWeekEnd").value = week.end;
  if (form.net_payout) form.net_payout.value = round2(n(form.gross?.value) + n(form.tip_extra?.value) - n(form.platform_fee?.value)).toFixed(2);
}

function renderPlatformsTable() {
  if (!el("platformsTable")) return;
  el("platformsTable").innerHTML = tableHtml(
    ["Platform", "Default", ""],
    db.platforms.map((x) => [esc(x.name), x.is_default ? "Yes" : "No", `<button class="del" data-platform-id="${x.id}">Delete</button>`])
  );
  document.querySelectorAll("[data-platform-id]").forEach((b) => {
    b.onclick = async () => {
      if (!isAdmin) return;
      await supabase.from("platform_options").delete().eq("id", b.dataset.platformId);
      await loadPlatformOptions();
      renderPlatformsTable();
    };
  });
}

async function addPlatformOption() {
  if (!isAdmin || !supabase) return setStatus("settingsStatus", "Admin access required.", true);
  const name = (el("platformNameInput").value || "").trim();
  const is_default = el("platformDefaultInput").value === "true";
  if (!name) return setStatus("settingsStatus", "Enter platform name.", true);
  if (is_default) await supabase.from("platform_options").update({ is_default: false });
  const { error } = await supabase.from("platform_options").insert({ name, is_default, created_by: currentUser.id });
  if (error) return setStatus("settingsStatus", `Platform add failed: ${error.message}`, true);
  el("platformNameInput").value = "";
  setStatus("settingsStatus", `Platform added: ${name}`);
  await loadPlatformOptions();
  renderPlatformsTable();
}

async function importWorkbook() {
  if (!supabase || !currentUser) return setStatus("importStatus", "Login required.", true);
  const file = el("importWorkbookFile")?.files?.[0];
  if (!file) return setStatus("importStatus", "Choose an Excel file first.", true);
  if (!window.XLSX) return setStatus("importStatus", "XLSX parser not loaded.", true);
  setStatus("importStatus", "Reading workbook...");
  try {
    const data = await file.arrayBuffer();
    const wb = window.XLSX.read(data, { type: "array" });
    const incomeRows = parseIncomeSheet(wb);
    const expenseRows = parseExpenseSheet(wb);
    const logbookRows = parseLogbookSheet(wb);
    const tollRows = parseTollSheet(wb);
    const schemaWarnings = new Set();

    const incomeResult = incomeRows.length ? await mergeRows("fares", incomeRows, fareImportKey, schemaWarnings) : { inserted: 0, updated: 0 };
    const expenseResult = expenseRows.length ? await mergeRows("expenses", expenseRows, expenseImportKey, schemaWarnings) : { inserted: 0, updated: 0 };
    const logbookResult = logbookRows.length ? await mergeRows("trips", logbookRows, tripImportKey, schemaWarnings) : { inserted: 0, updated: 0 };
    const tollResult = tollRows.length ? await mergeRows("tolls", tollRows, tollImportKey, schemaWarnings) : { inserted: 0, updated: 0 };
    await refreshAll();
    const warningText = schemaWarnings.size ? ` Missing DB columns skipped: ${Array.from(schemaWarnings).join(", ")}. Run the latest Supabase SQL to fully sync.` : "";
    setStatus(
      "importStatus",
      `Import synced. Income: +${incomeResult.inserted} / updated ${incomeResult.updated}, Expenses: +${expenseResult.inserted} / updated ${expenseResult.updated}, Logbook: +${logbookResult.inserted} / updated ${logbookResult.updated}, Tolls: +${tollResult.inserted} / updated ${tollResult.updated}.${warningText}`
    );
  } catch (err) {
    setStatus("importStatus", err?.message || "Import failed.", true);
  }
}

async function mergeRows(table, rows, keyFn, schemaWarnings = new Set()) {
  const { data: existing, error } = await supabase.from(table).select("*");
  if (error) throw new Error(`${cap(table)} lookup failed: ${error.message}`);
  const existingMap = new Map((existing || []).map((row) => [keyFn(row), row]));
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const key = keyFn(row);
    const match = existingMap.get(key);
    if (!match) {
      const insertError = await insertWithSchemaFallback(table, row, schemaWarnings);
      if (insertError) throw new Error(`${cap(table)} import failed: ${insertError.message}`);
      inserted += 1;
      continue;
    }
    const payload = changedPayload(match, row);
    if (Object.keys(payload).length) {
      const updateError = await updateWithSchemaFallback(table, match.id, payload, schemaWarnings);
      if (updateError) throw new Error(`${cap(table)} update failed: ${updateError.message}`);
      updated += 1;
    }
  }
  return { inserted, updated };
}

async function insertWithSchemaFallback(table, row, schemaWarnings) {
  const payload = { ...row };
  while (Object.keys(payload).length) {
    const { error } = await supabase.from(table).insert(payload);
    if (!error) return null;
    const missingColumn = parseMissingSchemaColumn(error);
    if (!missingColumn || !(missingColumn in payload)) return error;
    delete payload[missingColumn];
    schemaWarnings.add(`${table}.${missingColumn}`);
  }
  return new Error("All import columns were rejected by the current database schema.");
}

async function updateWithSchemaFallback(table, id, row, schemaWarnings) {
  const payload = { ...row };
  while (Object.keys(payload).length) {
    const { error } = await supabase.from(table).update(payload).eq("id", id);
    if (!error) return null;
    const missingColumn = parseMissingSchemaColumn(error);
    if (!missingColumn || !(missingColumn in payload)) return error;
    delete payload[missingColumn];
    schemaWarnings.add(`${table}.${missingColumn}`);
  }
  return null;
}

function parseMissingSchemaColumn(error) {
  const msg = error?.message || "";
  const match = msg.match(/Could not find the '([^']+)' column/i);
  return match?.[1] || "";
}

function changedPayload(existing, incoming) {
  const payload = {};
  Object.entries(incoming).forEach(([key, value]) => {
    if (key === "user_id") return;
    const current = existing[key];
    if (String(current ?? "") !== String(value ?? "")) payload[key] = value;
  });
  return payload;
}

function fareImportKey(row) { return [row.user_id, row.date, row.week_end, row.platform].join("|"); }
function expenseImportKey(row) { return [row.user_id, row.date, row.category, round2(row.amount)].join("|"); }
function tripImportKey(row) { return [row.user_id, row.date, round2(row.odo_start), round2(row.odo_end)].join("|"); }
function tollImportKey(row) { return [row.user_id, row.date, round2(row.amount)].join("|"); }

function parseIncomeSheet(wb) {
  const ws = wb.Sheets["Uber Income & GST"];
  if (!ws) return [];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rows
    .map((r) => ({
      user_id: currentUser.id,
      date: normalizeExcelDate(firstRowValue(r, ["From Date", "Date", "Week Start", "Start Date"])),
      week_end: normalizeExcelDate(firstRowValue(r, ["To Date", "Week End", "End Date"])) || addDays(normalizeExcelDate(firstRowValue(r, ["From Date", "Date", "Week Start", "Start Date"])), 6),
      platform: "Uber",
      gross: n(firstRowValue(r, ["Trip Gross Fare", "Gross Fare", "Fare"])),
      gst_included: true,
      platform_fee: n(firstRowValue(r, ["Uber Service Fee", "Platform Fee"])),
      platform_fee_gst: n(firstRowValue(r, ["GST on Uber Fee", "Platform Fee GST"])),
      tip_extra: n(firstRowValue(r, ["Tip/Extra", "Tip / Extra", "Tips"])),
      net_payout: n(firstRowValue(r, ["Net Payout", "Net"])) || round2(n(firstRowValue(r, ["Trip Gross Fare", "Gross Fare", "Fare"])) + n(firstRowValue(r, ["Tip/Extra", "Tip / Extra", "Tips"])) - n(firstRowValue(r, ["Uber Service Fee", "Platform Fee"])))
    }))
    .filter((x) => x.date && x.gross > 0);
}

function parseExpenseSheet(wb) {
  const ws = wb.Sheets["Expenses & GST Credits"];
  if (!ws) return [];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rows
    .map((r) => {
      const notes = [r["Supplier"], r["Notes"]].filter(Boolean).join(" | ");
      const category = String(firstRowValue(r, ["Expense Type", "Category", "Expense"]) || "Other");
      const vehicleRaw = firstRowValue(r, ["Vehicle Expense", "Vehicle Running Cost", "Is Vehicle Expense", "Expense Tax Type"]);
      return {
        user_id: currentUser.id,
        date: normalizeExcelDate(firstRowValue(r, ["Date", "Expense Date"])),
        category,
        is_vehicle_expense: vehicleRaw === "" || vehicleRaw == null ? isVehicleRunningExpense({ category }) : parseBoolish(vehicleRaw),
        amount: n(firstRowValue(r, ["Total Amount", "Amount"])),
        gst_amount: n(firstRowValue(r, ["GST Amount", "GST"])),
        gst_claimable: n(firstRowValue(r, ["GST Claimable", "Claimable GST"])) > 0,
        gst_credit: n(firstRowValue(r, ["GST Claimable", "Claimable GST"])),
        notes
      };
    })
    .filter((x) => x.date && x.amount > 0);
}

function parseLogbookSheet(wb) {
  const ws = wb.Sheets["Logbook"];
  if (!ws) return [];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rows
    .map((r) => {
      const purposeRaw = String(r["Purpose of Trip"] || "").toLowerCase();
      const purpose = purposeRaw.includes("uber") || purposeRaw.includes("ride") ? "Business" : "Private";
      return {
        user_id: currentUser.id,
        date: normalizeExcelDate(r["Date"]),
        purpose,
        odo_start: n(r["Start Odometer"]),
        odo_end: n(r["End Odometer"]),
        km: n(r["KM"]) || Math.max(0, n(r["End Odometer"]) - n(r["Start Odometer"])),
        from_location: "",
        to_location: "",
        notes: String(r["Notes"] || "")
      };
    })
    .filter((x) => x.date && x.odo_end > x.odo_start);
}

function parseTollSheet(wb) {
  const ws = wb.Sheets["Toll"];
  if (!ws) return [];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rows
    .map((r) => ({
      user_id: currentUser.id,
      date: normalizeExcelDate(r["Date"]),
      amount: n(r["Payment"] || r["Amount"]),
      reimbursed: false
    }))
    .filter((x) => x.date && x.amount > 0);
}

function normalizeExcelDate(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    const o = window.XLSX.SSF.parse_date_code(v);
    if (!o) return "";
    return `${o.y}-${String(o.m).padStart(2, "0")}-${String(o.d).padStart(2, "0")}`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function firstRowValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return "";
}

async function onAddTrip(e) {
  e.preventDefault();
  const f = e.target;
  const odo_start = n(f.odo_start.value), odo_end = n(f.odo_end.value);
  if (odo_end <= odo_start) return alert("End odometer must be greater than start.");
  const payload = {
    user_id: currentUser.id,
    date: f.date.value,
    purpose: f.purpose.value,
    odo_start,
    odo_end,
    km: +(odo_end - odo_start).toFixed(2),
    from_location: f.from_location.value,
    to_location: f.to_location.value,
    notes: f.notes.value
  };
  if (editing.trips) await supabase.from("trips").update(payload).eq("id", editing.trips);
  else await supabase.from("trips").insert(payload);
  clearEdit("trips");
  f.reset(); f.date.value = today;
  prefillTripStartOdo();
  await refreshAll();
}

async function onAddFare(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    user_id: currentUser.id,
    date: f.date.value,
    week_end: el("fareWeekEnd")?.value || addDays(f.date.value, 6),
    platform: f.platform.value,
    gross: n(f.gross.value),
    gst_included: f.gst_included.value === "true",
    platform_fee: n(f.platform_fee.value),
    platform_fee_gst: +(n(f.platform_fee.value) / 11).toFixed(2),
    tip_extra: n(f.tip_extra.value),
    net_payout: round2(n(f.gross.value) + n(f.tip_extra.value) - n(f.platform_fee.value))
  };
  if (editing.fares) await supabase.from("fares").update(payload).eq("id", editing.fares);
  else await supabase.from("fares").insert(payload);
  clearEdit("fares");
  f.reset(); f.date.value = weekRange(today).start;
  if (f.platform.options.length) f.platform.value = f.platform.options[0].value;
  f.platform_fee.value = 0;
  f.platform_fee_gst.value = "0.00";
  if (f.tip_extra) f.tip_extra.value = 0;
  if (f.net_payout) f.net_payout.value = "0.00";
  updateFareWeekFields();
  await refreshAll();
}

async function onAddExpense(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    user_id: currentUser.id,
    date: f.date.value,
    category: f.category.value,
    is_vehicle_expense: f.is_vehicle_expense.value === "true",
    amount: n(f.amount.value),
    gst_amount: n(f.gst_amount.value),
    gst_claimable: f.gst_claimable.value === "true",
    gst_credit: f.gst_claimable.value === "true" ? (n(f.gst_credit.value) || n(f.gst_amount.value)) : 0,
    notes: f.notes.value
  };
  const result = editing.expenses
    ? await supabase.from("expenses").update(payload).eq("id", editing.expenses)
    : await supabase.from("expenses").insert(payload);
  if (result?.error) {
    return alert(`Expense save failed: ${result.error.message}. Run the latest supabase.sql migration if this mentions is_vehicle_expense.`);
  }
  clearEdit("expenses");
  f.reset(); f.date.value = today;
  if (f.is_vehicle_expense) f.is_vehicle_expense.value = "true";
  if (f.gst_amount) { f.gst_amount.dataset.manual = ""; f.gst_amount.value = "0.00"; }
  if (f.gst_credit) f.gst_credit.value = "0.00";
  await refreshAll();
}

async function onAddToll(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    user_id: currentUser.id,
    date: f.date.value,
    amount: n(f.amount.value),
    reimbursed: f.reimbursed.value === "true"
  };
  if (editing.tolls) await supabase.from("tolls").update(payload).eq("id", editing.tolls);
  else await supabase.from("tolls").insert(payload);
  clearEdit("tolls");
  f.reset(); f.date.value = today;
  await refreshAll();
}

async function onSaveTax(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    user_id: currentUser.id,
    financial_year: taxFinancialYearKey(),
    other_income: n(f.other_income.value),
    super_contribution: n(f.super_contribution.value),
    deduction_method: validDeductionMethod(f.deduction_method?.value),
    cents_per_km_rate: n(f.cents_per_km_rate?.value || DEFAULT_TAX_SETTINGS.cents_per_km_rate),
    cents_per_km_cap: n(f.cents_per_km_cap?.value || DEFAULT_TAX_SETTINGS.cents_per_km_cap)
  };
  const { data } = await supabase.from("tax_settings").select("id").eq("financial_year", payload.financial_year).limit(1).maybeSingle();
  let result;
  if (data?.id) {
    result = await supabase.from("tax_settings").update(payload).eq("id", data.id);
  } else {
    result = await supabase.from("tax_settings").insert(payload);
  }
  if (result?.error) {
    return setStatus("taxStatus", `Tax settings save failed: ${result.error.message}. Run the latest supabase.sql migration if this mentions deduction_method or cents_per_km.`, true);
  }
  setStatus("taxStatus", "Tax settings saved.");
  await refreshAll();
}

function renderAll() {
  renderFinancialYearSelect();
  renderTripTable(); renderLogbookSummary(); renderIncomeSummaryTiles(); renderFareWeeklyTable(); renderExpenseSummaryTiles(); renderExpenseTable(); renderReceiptGrid(); renderTollTable(); renderKpis(); renderDashboardHero(); renderReport(); renderTaxBreakdown();
  updateAutoTaxPct();
}

function currentFinancialYearEnd(date = new Date()) {
  const month = date.getMonth() + 1;
  return month >= 7 ? date.getFullYear() + 1 : date.getFullYear();
}

function financialYearForDate(dateStr) {
  const d = parseLocalDate(dateStr || today);
  return d.getMonth() + 1 >= 7 ? d.getFullYear() + 1 : d.getFullYear();
}

function financialYearRange(fyEndYear) {
  const year = Number(fyEndYear);
  return { from: `${year - 1}-07-01`, to: `${year}-06-30`, label: `FY ${year - 1}-${String(year).slice(-2)}` };
}

function allDatedRows() {
  return [...db.trips, ...db.fares, ...db.expenses, ...db.tolls, ...db.receipts.map((x) => ({ date: x.receipt_date }))].filter((x) => x.date);
}

function availableFinancialYears() {
  const years = new Set(allDatedRows().map((x) => financialYearForDate(x.date)));
  years.add(currentFinancialYearEnd());
  return Array.from(years).sort((a, b) => b - a);
}

function isInActiveFinancialYear(dateStr) {
  if (activeFinancialYear === "all") return true;
  const range = financialYearRange(activeFinancialYear);
  return dateStr >= range.from && dateStr <= range.to;
}

function scopedRows(rows, dateKey = "date") {
  return activeFinancialYear === "all" ? rows : rows.filter((row) => isInActiveFinancialYear(row[dateKey]));
}

function scopedData() {
  return {
    trips: scopedRows(db.trips),
    fares: scopedRows(db.fares),
    expenses: scopedRows(db.expenses),
    tolls: scopedRows(db.tolls),
    receipts: scopedRows(db.receipts, "receipt_date"),
    tax: db.tax,
    platforms: db.platforms
  };
}

function taxFinancialYearKey() {
  return activeFinancialYear === "all" ? "all" : String(activeFinancialYear);
}

function renderFinancialYearSelect() {
  const select = el("financialYearSelect");
  if (!select) return;
  const years = availableFinancialYears();
  if (activeFinancialYear !== "all" && !years.includes(Number(activeFinancialYear))) activeFinancialYear = String(currentFinancialYearEnd());
  const options = [`<option value="all">Overall - all years</option>`].concat(years.map((year) => {
    const range = financialYearRange(year);
    return `<option value="${year}">${range.label}</option>`;
  }));
  select.innerHTML = options.join("");
  select.value = activeFinancialYear;
  if (activeFinancialYear !== "all" && el("summaryYear")) el("summaryYear").value = activeFinancialYear;
}

function renderTripTable() {
  const rows = scopedData().trips;
  el("tripTable").innerHTML = tableHtml(
    ["Date", "Purpose", "Start Odo", "End Odo", "KM", "Actions"],
    rows.map((x) => [x.date, x.purpose, f2(x.odo_start), f2(x.odo_end), f2(x.km), actionBtns("trips", x.id)])
  );
  bindRowActions();
}
function renderFareWeeklyTable() {
  const rows = weeklyFareSummaries();
  el("fareWeeklyTable").innerHTML = tableHtml(
    ["From", "To", "Trip Fare", "Tips", "Uber Fee", "Net Payout", "GST", "Actions"],
    rows.map((x) => [
      x.start,
      x.end,
      aud(x.gross),
      aud(x.tipExtra),
      aud(x.platformFees),
      aud(x.netPayout),
      aud(x.fareGst),
      actionBtns("fares", x.id)
    ])
  );
  if (el("dashboardWeeklyTable")) {
    el("dashboardWeeklyTable").innerHTML = tableHtml(
      ["Week", "Trip Fare", "Tips", "Net Payout", "GST Payable", "Tax Payable"],
      rows.slice(0, 8).map((x) => [esc(x.label), aud(x.gross), aud(x.tipExtra), aud(x.netPayout), aud(x.gstPayableShare), aud(x.taxPayableShare)])
    );
  }
}

function renderIncomeSummaryTiles() {
  if (!el("incomeSummaryTiles")) return;
  const m = computeMetrics();
  const tiles = [
    ["Total Income", aud(m.netPayout), "kpi-tone-3"],
    ["Gross Fare", aud(m.fareGross), "kpi-tone-1"],
    ["GST on Fares + Tips", aud(m.fareGst), "kpi-tone-4"],
    ["Total Tips", aud(m.tipExtra), "kpi-tone-2"],
    ["Platform Fees", aud(m.platformFees), "kpi-tone-5"],
    ["Fare After Fee", aud(m.fareAfterUberFee), "kpi-tone-1"]
  ];
  el("incomeSummaryTiles").innerHTML = tiles.map(([label, value, tone]) => `<article class="summary-tile ${tone}"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

function renderExpenseSummaryTiles() {
  if (!el("expenseSummaryTiles")) return;
  const m = computeMetrics();
  const tiles = [
    ["Total Expenses", aud(m.expenseTotal), "kpi-tone-3"],
    ["Business % Amount", aud(m.businessUseExpenseAmount), "kpi-tone-1"],
    ["Expense GST Credit", aud(m.expenseOnlyGstCredit), "kpi-tone-2"],
    ["Platform Fee GST", aud(m.platformFeeGst), "kpi-tone-4"],
    ["Business Use", pct(m.businessUsePct), "kpi-tone-5"],
    ["Vehicle Costs", aud(m.vehicleExpenseTotal), "kpi-tone-1"]
  ];
  el("expenseSummaryTiles").innerHTML = tiles.map(([label, value, tone]) => `<article class="summary-tile ${tone}"><span>${label}</span><strong>${value}</strong></article>`).join("");
}
function renderExpenseTable() {
  const rows = scopedData().expenses;
  const businessUsePct = currentBusinessUsePct();
  el("expenseTable").innerHTML = tableHtml(
    ["Date", "Category", "Tax Type", "Amount", "GST Credit", "Actions"],
    rows.map((x) => [x.date, esc(x.category), isVehicleRunningExpense(x) ? "Vehicle" : "Other", aud(x.amount), aud(expenseGstCreditValue(x, businessUsePct)), actionBtns("expenses", x.id)])
  );
  bindRowActions();
}

function renderReceiptGrid() {
  const grid = el("receiptGrid");
  if (!grid) return;
  const rows = scopedData().receipts || [];
  grid.innerHTML = rows.length ? rows.map((receipt) => `
    <article class="receipt-card">
      ${isPdfReceipt(receipt) ?
        `<div class="receipt-pdf-preview"><strong>PDF</strong><span>Receipt document</span></div>` :
        `<img src="${receipt.image_data}" alt="${esc(receipt.title || "Receipt")}" />`}
      <div class="receipt-info">
        <strong>${esc(receipt.title || "Receipt")}</strong>
        <span>${esc(receipt.receipt_date || receipt.created_at?.slice(0, 10) || "")}</span>
      </div>
      <div class="actions-row">
        <button type="button" class="receipt-pdf" data-id="${receipt.id}">PDF</button>
        ${delBtn("receipts", receipt.id)}
      </div>
    </article>
  `).join("") : `<div class="empty-chart">No receipts saved yet.</div>`;
}

function renderTollTable() {
  const rows = scopedData().tolls;
  el("tollTable").innerHTML = tableHtml(
    ["Date", "Amount", "Reimbursed", "Actions"],
    rows.map((x) => [x.date, aud(x.amount), x.reimbursed ? "Yes" : "No", actionBtns("tolls", x.id)])
  );
  bindRowActions();
}

async function onReceiptSelected(evt) {
  if (!currentUser || !supabase) return setStatus("receiptStatus", "Login required.", true);
  const file = evt.target.files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    evt.target.value = "";
    return setStatus("receiptStatus", "Receipt file must be 8 MB or smaller.", true);
  }
  setStatus("receiptStatus", "Scanning receipt...");
  try {
    const receiptData = file.type === "application/pdf" || /\.pdf$/i.test(file.name)
      ? await fileToDataUrl(file)
      : await scanReceiptImage(file);
    const title = (el("receiptTitle")?.value || file.name || "Receipt").trim();
    const receiptDate = el("receiptDate")?.value || today;
    const { error } = await supabase.from("receipts").insert({
      user_id: currentUser.id,
      receipt_date: receiptDate,
      title,
      image_data: receiptData
    });
    if (error) throw error;
    if (el("receiptTitle")) el("receiptTitle").value = "";
    evt.target.value = "";
    setStatus("receiptStatus", file.type === "application/pdf" ? "Receipt PDF saved." : "Receipt scanned and saved.");
    await refreshAll(true);
  } catch (err) {
    setStatus("receiptStatus", `Receipt save failed: ${err?.message || "Unknown error"}`, true);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function isPdfReceipt(receipt) {
  return String(receipt?.image_data || "").startsWith("data:application/pdf");
}

async function scanReceiptImage(file) {
  const bitmap = await loadReceiptBitmap(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const crop = detectReceiptBounds(ctx, canvas.width, canvas.height);
  const out = document.createElement("canvas");
  out.width = crop.w;
  out.height = crop.h;
  out.getContext("2d").drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return out.toDataURL("image/jpeg", 0.82);
}

function loadReceiptBitmap(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function detectReceiptBounds(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const corners = [sample(0, 0), sample(width - 1, 0), sample(0, height - 1), sample(width - 1, height - 1)];
  const bg = corners.reduce((a, c) => [a[0] + c[0] / 4, a[1] + c[1] / 4, a[2] + c[2] / 4], [0, 0, 0]);
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      const diff = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (diff > 70 && brightness > 35) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const foundArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  if (foundArea < width * height * 0.12) return { x: 0, y: 0, w: width, h: height };
  const pad = Math.round(Math.min(width, height) * 0.03);
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const right = Math.min(width, maxX + pad);
  const bottom = Math.min(height, maxY + pad);
  return { x, y, w: right - x, h: bottom - y };
}

function renderKpis() {
  const m = computeMetrics();
  const cards = [
    ["Net Payout", aud(m.netPayout), "kpi-tone-3"],
    ["Balance", aud(m.balance), "kpi-tone-2"],
    ["Rideshare Taxable Income", aud(m.rideshareTaxableIncome), "kpi-tone-1"],
    ["After Tax", aud(m.afterTaxIncome), "kpi-tone-3"],
    ["Fare After Fee", aud(m.fareAfterUberFee), "kpi-tone-1"],
    ["Tip / Extra", aud(m.tipExtra), "kpi-tone-2"],
    ["Income Tax Payable", aud(m.uberTaxPayable), "kpi-tone-5"],
    ["GST Payable", aud(m.gstPayable), "kpi-tone-4"],
    ["Tolls Tracked", aud(m.tollTotal), "kpi-tone-4"],
    ["Expenses", aud(m.expenseTotal), "kpi-tone-3"],
    ["Uber Trip KM", f2(m.businessKm), "kpi-tone-2"],
    ["Personal Trip KM", f2(m.personalKm), "kpi-tone-5"]
  ];
  el("kpiGrid").innerHTML = cards.map(([k, v, tone]) => `<article class="kpi ${tone}"><div class="key">${k}</div><div class="val">${v}</div></article>`).join("");
}

function renderDashboardHero() {
  const m = computeMetrics();
  const week = weeklyFareSummaries()[0];
  if (!el("dashboardHero")) return;
  el("dashboardHero").innerHTML = `
    <div class="eyebrow">Uber income overview</div>
    <div class="hero-value">${aud(m.netPayout)}</div>
    <div class="hero-sub">Estimated Uber money in after platform fees, GST, expenses and rideshare income tax. Tolls are tracked separately.</div>
    <div class="hero-metrics">
      <div class="hero-chip"><span>This Week</span><strong>${week ? aud(week.netPayout) : aud(0)}</strong></div>
      <div class="hero-chip"><span>GST Payable</span><strong>${aud(m.gstPayable)}</strong></div>
      <div class="hero-chip"><span>Income Tax Payable</span><strong>${aud(m.uberTaxPayable)}</strong></div>
      <div class="hero-chip"><span>Balance</span><strong>${aud(m.balance)}</strong></div>
    </div>
  `;
}

function renderLogbookSummary() {
  const m = computeMetrics();
  const rows = scopedData().trips;
  const ato = validateAtoLogbook(rows);
  if (!el("logbookSummary")) return;
  el("logbookSummary").innerHTML = `
    <div class="hero-metrics">
      <div class="hero-chip"><span>Total KM</span><strong>${f2(m.totalKm)}</strong></div>
      <div class="hero-chip"><span>Uber Trip KM</span><strong>${f2(m.businessKm)}</strong></div>
      <div class="hero-chip"><span>Business Use</span><strong>${pct(m.businessUsePct)}</strong></div>
      <div class="hero-chip"><span>Trips Logged</span><strong>${rows.length}</strong></div>
      <div class="hero-chip"><span>ATO Check</span><strong>${ato.ok ? "Ready" : "Needs Review"}</strong></div>
    </div>
    <div class="small-note">${esc(ato.message)}</div>
  `;
}

function validateAtoLogbook(trips) {
  if (!trips.length) return { ok: false, message: "No logbook entries in the selected financial-year view." };
  const missing = trips.filter((t) => !t.date || !t.purpose || n(t.odo_end) <= n(t.odo_start) || n(t.km) <= 0);
  const dates = trips.map((t) => t.date).filter(Boolean).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const spanDays = first && last ? Math.round((parseLocalDate(last) - parseLocalDate(first)) / 86400000) + 1 : 0;
  if (missing.length) return { ok: false, message: `${missing.length} entries need date, purpose, valid odometer readings, and positive kilometres.` };
  if (spanDays < 84) return { ok: false, message: `Entries cover ${spanDays} days. A logbook-method claim generally needs a representative continuous 12-week logbook period.` };
  return { ok: true, message: `Entries cover ${spanDays} days with dates, purpose, odometer readings, and kilometres present.` };
}

function normalizeTaxSettings(raw = {}) {
  return {
    ...DEFAULT_TAX_SETTINGS,
    ...(raw || {}),
    other_income: n(raw?.other_income ?? DEFAULT_TAX_SETTINGS.other_income),
    super_contribution: n(raw?.super_contribution ?? DEFAULT_TAX_SETTINGS.super_contribution),
    deduction_method: validDeductionMethod(raw?.deduction_method),
    cents_per_km_rate: n(raw?.cents_per_km_rate ?? DEFAULT_TAX_SETTINGS.cents_per_km_rate),
    cents_per_km_cap: n(raw?.cents_per_km_cap ?? DEFAULT_TAX_SETTINGS.cents_per_km_cap)
  };
}

function validDeductionMethod(value) {
  return value === "cents_per_km" ? "cents_per_km" : "logbook";
}

function deductionMethodLabel(value) {
  return value === "cents_per_km" ? "Cents per Uber kilometre" : "Logbook / business-use actual expenses";
}

function taxSettingsWithOverrides(overrides = {}) {
  return normalizeTaxSettings({ ...(db.tax || DEFAULT_TAX_SETTINGS), ...(overrides || {}) });
}

function isVehicleRunningExpense(row) {
  if (typeof row?.is_vehicle_expense === "boolean") return row.is_vehicle_expense;
  return VEHICLE_RUNNING_EXPENSE_CATEGORIES.has(String(row?.category || "").trim().toLowerCase());
}

function computeDeductionModel({ expenses, businessUsePct, businessKm, superContrib, taxSettings }) {
  const expenseTotal = sum(expenses, "amount");
  const vehicleExpenseTotal = expenses.reduce((a, x) => a + (isVehicleRunningExpense(x) ? n(x.amount) : 0), 0);
  const otherExpenseTotal = Math.max(0, expenseTotal - vehicleExpenseTotal);
  const cappedBusinessKm = Math.min(Math.max(0, businessKm), Math.max(0, n(taxSettings.cents_per_km_cap)));
  const centsPerKmDeduction = round2(cappedBusinessKm * Math.max(0, n(taxSettings.cents_per_km_rate)));
  const logbookDeduction = round2(expenseTotal * businessUsePct);
  const otherExpenseDeduction = round2(otherExpenseTotal * businessUsePct);
  const vehicleExpenseDeduction = taxSettings.deduction_method === "cents_per_km"
    ? centsPerKmDeduction
    : logbookDeduction;
  const deductibleExpenses = round2(vehicleExpenseDeduction + (taxSettings.deduction_method === "cents_per_km" ? otherExpenseDeduction : 0) + n(superContrib));
  return {
    deductionMethod: taxSettings.deduction_method,
    vehicleExpenseTotal,
    otherExpenseTotal,
    businessUseExpenses: taxSettings.deduction_method === "cents_per_km" ? otherExpenseDeduction : logbookDeduction,
    vehicleExpenseDeduction,
    otherExpenseDeduction,
    centsPerKmDeduction,
    centsPerKmRate: n(taxSettings.cents_per_km_rate),
    centsPerKmCap: n(taxSettings.cents_per_km_cap),
    cappedBusinessKm,
    deductibleExpenses
  };
}

function computeMetrics(overrides = {}, source = scopedData()) {
  const fareGross = sum(source.fares, "gross");
  const fareGst = source.fares.reduce((a, x) => a + gstFromFare(x), 0);
  const tipExtra = source.fares.reduce((a, x) => a + n(x.tip_extra), 0);
  const gstSalesTotal = fareGross + tipExtra;
  const platformFees = source.fares.reduce((a, x) => a + n(x.platform_fee), 0);
  const platformFeeGst = source.fares.reduce((a, x) => a + n(x.platform_fee_gst), 0);
  const fareAfterUberFee = round2(fareGross - platformFees);
  const netPayout = source.fares.reduce((a, x) => a + netPayoutForFare(x), 0);
  const totalKm = sum(source.trips, "km");
  const businessKm = source.trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  const personalKm = Math.max(0, totalKm - businessKm);
  const businessUsePct = totalKm > 0 ? businessKm / totalKm : 0;
  const expenseTotal = sum(source.expenses, "amount");
  const businessUseExpenseAmount = round2(expenseTotal * businessUsePct);
  const expenseOnlyGstCredit = source.expenses.reduce((a, x) => a + expenseGstCreditValue(x, businessUsePct), 0);
  const expenseGstCredit = expenseOnlyGstCredit;
  const tollTotal = sum(source.tolls, "amount");
  const reimbursedTolls = source.tolls.reduce((a, x) => a + (x.reimbursed ? x.amount : 0), 0);
  const gstPayable = Math.max(0, fareGst - expenseGstCredit);
  const taxSettings = taxSettingsWithOverrides(overrides);
  const otherIncome = n(taxSettings.other_income);
  const superContrib = n(taxSettings.super_contribution);
  const deduction = computeDeductionModel({ expenses: source.expenses, businessUsePct, businessKm, superContrib, taxSettings });
  const deductibleExpenses = deduction.deductibleExpenses;
  const rideshareTaxableIncome = Math.max(0, netPayout - gstPayable - deductibleExpenses);
  const taxableIncome = Math.max(0, rideshareTaxableIncome + otherIncome);
  const taxBreakdown = computeTaxBreakdown(rideshareTaxableIncome, otherIncome);
  const incomeTax = taxBreakdown.incomeTax;
  const medicare = taxBreakdown.medicare;
  const totalTax = taxBreakdown.totalTax;
  const uberTaxPayable = taxBreakdown.uberTaxPayable;
  const otherIncomeTaxPaid = taxBreakdown.otherIncomeTaxPaid;
  const slab = taxSlabForIncome(taxableIncome);

  const preTaxBalance = netPayout - gstPayable - expenseTotal;
  const dashboardTaxableIncome = rideshareTaxableIncome;
  const afterTaxIncome = netPayout - gstPayable - uberTaxPayable;
  const balance = netPayout - gstPayable - uberTaxPayable - expenseTotal;
  const inHand = balance;
  const rideshareEffectiveTaxRate = rideshareTaxableIncome > 0 ? uberTaxPayable / rideshareTaxableIncome : 0;

  const monthsActive = Math.max(1, distinctMonths([...source.fares, ...source.expenses, ...source.tolls].map((x) => x.date)).size);
  const monthlyAvgNet = inHand / monthsActive;
  const effectiveTaxRate = taxableIncome > 0 ? totalTax / taxableIncome : 0;
  const recommendedReserve = taxableIncome * effectiveTaxRate;

  return {
    fareGross,
    gstSalesTotal,
    fareGst,
    tipExtra,
    fareAfterUberFee,
    expenseTotal,
    businessUseExpenseAmount,
    expenseOnlyGstCredit,
    expenseGstCredit,
    tollTotal,
    reimbursedTolls,
    totalKm,
    businessKm,
    personalKm,
    businessUsePct,
    businessUseExpenses: deduction.businessUseExpenses,
    deductibleExpenses,
    deductionMethod: deduction.deductionMethod,
    vehicleExpenseTotal: deduction.vehicleExpenseTotal,
    vehicleExpenseDeduction: deduction.vehicleExpenseDeduction,
    otherExpenseDeduction: deduction.otherExpenseDeduction,
    centsPerKmDeduction: deduction.centsPerKmDeduction,
    centsPerKmRate: deduction.centsPerKmRate,
    centsPerKmCap: deduction.centsPerKmCap,
    cappedBusinessKm: deduction.cappedBusinessKm,
    rideshareTaxableIncome,
    taxableIncome,
    incomeTax,
    medicare,
    totalTax,
    uberTaxPayable,
    otherIncomeTaxPaid,
    gstPayable,
    preTaxBalance,
    dashboardTaxableIncome,
    afterTaxIncome,
    balance,
    inHand,
    rideshareEffectiveTaxRate,
    netPayout,
    monthlyAvgNet,
    recommendedReserve,
    effectiveTaxRate,
    platformFees,
    platformFeeGst,
    marginalRate: slab.rate,
    slabLabel: slab.label
  };
}

function renderReport(forceType = null) {
  const period = el("summaryPeriod").value;
  const year = Number(el("summaryYear").value || new Date().getFullYear());
  const reportKind = forceType || activeReportKind;
  activeReportKind = reportKind;
  updateReportSwitcher();
  const report = buildReportModel(reportKind, period, year);
  updateReportActionLabels(report);
  if (el("reportMeta")) el("reportMeta").textContent = `${report.title} | ${cap(period)} FY ending ${year} | ${report.exportLabel}`;
  el("reportArea").innerHTML = report.html;
}

function downloadReportWorkbook(reportType = "full") {
  if (!window.XLSX) return;
  const period = el("summaryPeriod").value;
  const year = Number(el("summaryYear").value || new Date().getFullYear());
  const buckets = bucketizeByPeriod(period, year);
  const reportRows = buckets.map((bucket) => {
    const metrics = computeForRange(bucket.from, bucket.to);
    return {
      Period: bucket.label,
      Fare: round2(metrics.fareGross),
      G1_Sales_Including_Tips: round2(metrics.gstSalesTotal),
      Expenses: round2(metrics.expenseTotal),
      GST_Collected: round2(metrics.fareGst),
      GST_Credits: round2(metrics.expenseGstCredit),
      GST_Payable: round2(metrics.gstPayable),
      Deduction_Method: deductionMethodLabel(metrics.deductionMethod),
      Deductible_Expenses: round2(metrics.deductibleExpenses),
      Cents_Per_KM_Deduction: round2(metrics.centsPerKmDeduction),
      Cents_Per_KM_Used: round2(metrics.cappedBusinessKm),
      Cents_Per_KM_Rate: round2(metrics.centsPerKmRate),
      Cents_Per_KM_Cap: round2(metrics.centsPerKmCap),
      Rideshare_Taxable_Income: round2(metrics.rideshareTaxableIncome),
      Total_Taxable_Income: round2(metrics.taxableIncome),
      Income_Tax_Payable: round2(metrics.uberTaxPayable),
      Estimated_PAYG_Tax_on_Other_Income: round2(metrics.otherIncomeTaxPaid),
      Tax_Medicare: round2(metrics.totalTax),
      Balance: round2(metrics.balance)
    };
  });

  const startDate = buckets[0]?.from || `${year}-01-01`;
  const endDate = buckets[buckets.length - 1]?.to || `${year}-12-31`;
  const rangeMetrics = computeForRange(startDate, endDate);
  const filterByRange = (rows) => rows.filter((row) => row.date >= startDate && row.date <= endDate);
  const fares = filterByRange(db.fares).map((row) => ({
    From_Date: row.date,
    To_Date: row.week_end || addDays(row.date, 6),
    Platform: row.platform,
    Trip_Gross_Fare: round2(row.gross),
    GST_On_Fare_and_Tips: round2(gstFromFare(row)),
    Platform_Fee: round2(row.platform_fee),
    Platform_Fee_GST: round2(row.platform_fee_gst),
    Tip_Extra: round2(row.tip_extra),
    Net_Payout: round2(netPayoutForFare(row))
  }));
  const expenses = filterByRange(db.expenses).map((row) => ({
    Date: row.date,
    Category: row.category,
    Tax_Type: isVehicleRunningExpense(row) ? "Vehicle running cost" : "Other business expense",
    Amount: round2(row.amount),
    GST_Claimable: row.gst_claimable ? "Yes" : "No",
    GST_Amount: round2(row.gst_amount || 0),
    GST_Credit: round2(expenseGstCreditValue(row, rangeMetrics.businessUsePct)),
    Notes: row.notes || ""
  }));
  const tolls = filterByRange(db.tolls).map((row) => ({
    Date: row.date,
    Amount: round2(row.amount),
    Reimbursed: row.reimbursed ? "Yes" : "No"
  }));
  const trips = filterByRange(db.trips).map((row) => ({
    Date: row.date,
    Purpose: row.purpose,
    Odo_Start: round2(row.odo_start),
    Odo_End: round2(row.odo_end),
    KM: round2(row.km),
    From: row.from_location || "",
    To: row.to_location || "",
    Notes: row.notes || ""
  }));

  const allMetrics = rangeMetrics;
  const overviewRows = [
    { Field: "Report Type", Value: reportType.toUpperCase() },
    { Field: "Summary Period", Value: cap(period) },
    { Field: "Year", Value: year },
    { Field: "Range Start", Value: startDate },
    { Field: "Range End", Value: endDate },
    { Field: "Generated At", Value: new Date().toLocaleString("en-AU") },
    { Field: "Trip Gross Fare", Value: round2(allMetrics.fareGross) },
    { Field: "Tip / Extra", Value: round2(allMetrics.tipExtra) },
    { Field: "Net Payout", Value: round2(allMetrics.netPayout) },
    { Field: "Other Income", Value: round2(n(db.tax?.other_income || 0)) },
    { Field: "Platform Fees", Value: round2(allMetrics.platformFees || 0) },
    { Field: "Expenses", Value: round2(allMetrics.expenseTotal) },
    { Field: "Business Use %", Value: round2(allMetrics.businessUsePct * 100) },
    { Field: "GST Payable", Value: round2(allMetrics.gstPayable) },
    { Field: "Deduction Method", Value: deductionMethodLabel(allMetrics.deductionMethod) },
    { Field: "Deductible Expenses", Value: round2(allMetrics.deductibleExpenses) },
    { Field: "Cents per KM Deduction", Value: round2(allMetrics.centsPerKmDeduction) },
    { Field: "Cents per KM Used", Value: round2(allMetrics.cappedBusinessKm) },
    { Field: "Cents per KM Rate", Value: round2(allMetrics.centsPerKmRate) },
    { Field: "Cents per KM Cap", Value: round2(allMetrics.centsPerKmCap) },
    { Field: "Rideshare Taxable Income", Value: round2(allMetrics.rideshareTaxableIncome) },
    { Field: "Total Taxable Income", Value: round2(allMetrics.taxableIncome) },
    { Field: "Income Tax Payable", Value: round2(allMetrics.uberTaxPayable) },
    { Field: "Estimated PAYG Tax on Other Income", Value: round2(allMetrics.otherIncomeTaxPaid) },
    { Field: "Tax + Medicare", Value: round2(allMetrics.totalTax) },
    { Field: "Effective Tax %", Value: round2(allMetrics.effectiveTaxRate * 100) },
    { Field: "Balance", Value: round2(allMetrics.balance) }
  ];
  const basRows = [{
    G1_Total_Sales: round2(allMetrics.gstSalesTotal),
    GST_on_Sales_1A: round2(allMetrics.fareGst),
    Expense_GST_Credits_1B: round2(allMetrics.expenseGstCredit),
    Platform_Fee_GST_Info: round2(allMetrics.platformFeeGst || 0),
    Net_GST_Payable: round2(allMetrics.gstPayable)
  }];
  const taxRows = [{
    Other_Income: round2(n(db.tax?.other_income || 0)),
    Super_Contribution: round2(n(db.tax?.super_contribution || 0)),
    Deduction_Method: deductionMethodLabel(allMetrics.deductionMethod),
    Deductible_Expenses: round2(allMetrics.deductibleExpenses),
    Vehicle_Expense_Deduction: round2(allMetrics.vehicleExpenseDeduction),
    Other_Expense_Deduction: round2(allMetrics.otherExpenseDeduction),
    Cents_Per_KM_Deduction: round2(allMetrics.centsPerKmDeduction),
    Cents_Per_KM_Used: round2(allMetrics.cappedBusinessKm),
    Cents_Per_KM_Rate: round2(allMetrics.centsPerKmRate),
    Cents_Per_KM_Cap: round2(allMetrics.centsPerKmCap),
    Rideshare_Taxable_Income: round2(allMetrics.rideshareTaxableIncome),
    Total_Taxable_Income: round2(allMetrics.taxableIncome),
    Income_Tax: round2(allMetrics.incomeTax),
    Medicare: round2(allMetrics.medicare),
    Total_Tax: round2(allMetrics.totalTax),
    Income_Tax_Payable: round2(allMetrics.uberTaxPayable),
    Estimated_PAYG_Tax_on_Other_Income: round2(allMetrics.otherIncomeTaxPaid),
    Marginal_Tax_Slab: allMetrics.slabLabel,
    Effective_Tax_Pct: round2(allMetrics.effectiveTaxRate * 100),
    Rideshare_Effective_Tax_Pct: round2(allMetrics.rideshareEffectiveTaxRate * 100),
    Balance: round2(allMetrics.balance)
  }];

  const weeklyRows = weeklyFareSummaries()
    .filter((x) => x.start >= startDate && x.start <= endDate)
    .map((x) => ({
      Week: x.label,
      Gross: x.gross,
      Tips: x.tipExtra,
      Platform_Fees: x.platformFees,
      Net_Payout: x.netPayout,
      GST_Payable_Share: x.gstPayableShare,
      Tax_Payable_Share: x.taxPayableShare
    }));
  const expenseByCategory = expenseCategoryBreakdown(startDate, endDate).map((row) => ({
    Category: row.category,
    Amount: round2(row.amount),
    GST_Credit: round2(row.gstCredit),
    Share_Pct: round2(row.share * 100)
  }));
  const logbookSummary = [{
    Total_KM: round2(rangeMetrics.totalKm || 0),
    Uber_KM: round2(rangeMetrics.businessKm || 0),
    Business_Use_Pct: round2((rangeMetrics.businessUsePct || 0) * 100),
    Trips_Logged: rangeMetrics.tripCount || 0
  }];

  const workbook = window.XLSX.utils.book_new();
  const reportSheets = {
    executive: [
      ["Overview", overviewRows],
      ["Period Summary", reportRows],
      ["Weekly Trend", weeklyRows],
      ["Expense Mix", expenseByCategory]
    ],
    bas: [
      ["BAS Summary", basRows],
      ["GST Ledger", reportRows.map((row) => ({
        Period: row.Period,
        G1_Sales_Including_Tips: row.G1_Sales_Including_Tips,
        GST_Collected: row.GST_Collected,
        Expense_GST_Credits: row.GST_Credits,
        GST_Payable: row.GST_Payable
      }))],
      ["Fares", fares],
      ["Expenses", expenses]
    ],
    tax: [
      ["Tax Summary", taxRows],
      ["Period Tax", reportRows.map((row) => ({
        Period: row.Period,
        Deduction_Method: row.Deduction_Method,
        Deductible_Expenses: row.Deductible_Expenses,
        Cents_Per_KM_Deduction: row.Cents_Per_KM_Deduction,
        Cents_Per_KM_Used: row.Cents_Per_KM_Used,
        Rideshare_Taxable_Income: row.Rideshare_Taxable_Income,
        Total_Taxable_Income: row.Total_Taxable_Income,
        Income_Tax_Payable: row.Income_Tax_Payable,
        Estimated_PAYG_Tax_on_Other_Income: row.Estimated_PAYG_Tax_on_Other_Income,
        Balance: row.Balance
      }))],
      ["Expenses", expenses]
    ],
    weekly: [
      ["Weekly Trend", weeklyRows],
      ["Fares", fares],
      ["Period Summary", reportRows]
    ],
    expenses: [
      ["Expense Mix", expenseByCategory],
      ["Expenses", expenses],
      ["BAS Credits", basRows]
    ],
    logbook: [
      ["Logbook Summary", logbookSummary],
      ["Logbook", trips]
    ],
    full: [
      ["Overview", overviewRows],
      ["Period Summary", reportRows],
      ["BAS Summary", basRows],
      ["Tax Summary", taxRows],
      ["Weekly Trend", weeklyRows],
      ["Expense Mix", expenseByCategory],
      ["Logbook Summary", logbookSummary],
      ["Fares", fares],
      ["Expenses", expenses],
      ["Tolls", tolls],
      ["Logbook", trips]
    ]
  };
  const selectedSheets = reportSheets[reportType] || reportSheets.full;
  selectedSheets.forEach(([name, rows]) => appendSheet(workbook, name, rows));

  const suffixMap = {
    executive: "executive-snapshot",
    bas: "bas-gst-ledger",
    tax: "tax-position",
    weekly: "weekly-earnings",
    expenses: "expense-breakdown",
    logbook: "logbook-compliance",
    full: "full-report"
  };
  const suffix = suffixMap[reportType] || "full-report";
  window.XLSX.writeFile(workbook, `ridemint-${suffix}-${year}.xlsx`);
}

function appendSheet(workbook, name, rows) {
  const safeRows = rows.length ? rows : [{ Message: "No data for selected report period." }];
  const sheet = window.XLSX.utils.json_to_sheet(safeRows);
  window.XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function buildReportModel(kind, period, year) {
  const buckets = bucketizeByPeriod(period, year);
  const startDate = buckets[0]?.from || `${year}-01-01`;
  const endDate = buckets[buckets.length - 1]?.to || `${year}-12-31`;
  const totals = computeForRange(startDate, endDate);
  const periodRows = buckets.map((bucket) => ({ label: bucket.label, ...computeForRange(bucket.from, bucket.to) }));
  const weeklyRows = weeklyFareSummaries().filter((x) => x.start >= startDate && x.start <= endDate);
  const expenseRows = expenseCategoryBreakdown(startDate, endDate);
  const reportMap = {
    executive: {
      title: "Executive Snapshot",
      exportLabel: "Excel snapshot, CSV summary, PDF/print view",
      html: renderExecutiveReport(period, year, totals, periodRows, weeklyRows, expenseRows)
    },
    bas: {
      title: "BAS & GST Ledger",
      exportLabel: "Excel BAS ledger, CSV GST ledger, PDF BAS view",
      html: renderBasReport(period, year, totals, periodRows)
    },
    tax: {
      title: "Tax Position",
      exportLabel: "Excel tax workbook, CSV tax periods, PDF tax view",
      html: renderTaxReport(period, year, totals, periodRows)
    },
    weekly: {
      title: "Weekly Earnings Trend",
      exportLabel: "Excel weekly trend, CSV weekly rows, PDF weekly trend",
      html: renderWeeklyTrendReport(period, year, totals, weeklyRows)
    },
    expenses: {
      title: "Expense Breakdown",
      exportLabel: "Excel expense mix, CSV expense categories, PDF expense report",
      html: renderExpenseReport(period, year, totals, expenseRows)
    },
    logbook: {
      title: "Logbook Compliance",
      exportLabel: "Excel logbook pack, CSV logbook rows, PDF compliance view",
      html: renderLogbookReport(period, year, totals, startDate, endDate)
    }
  };
  return reportMap[kind] || reportMap.executive;
}

function updateReportSwitcher() {
  document.querySelectorAll(".report-switch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.reportKind === activeReportKind);
  });
}

function updateReportActionLabels(report) {
  if (el("reportPdfBtn")) el("reportPdfBtn").textContent = `Open ${report.title} PDF`;
  if (el("reportExcelBtn")) el("reportExcelBtn").textContent = `Download ${report.title} Excel`;
  if (el("reportCsvBtn")) el("reportCsvBtn").textContent = `Download ${report.title} CSV`;
}

function renderExecutiveReport(period, year, totals, periodRows, weeklyRows, expenseRows) {
  return `
    <div class="report-header">
      <div>
        <h3>Executive Snapshot</h3>
        <div class="meta">${cap(period)} ${year} | Quick read of cash, GST, tax and operations.</div>
      </div>
    </div>
    <div class="report-kpis">
      ${reportKpi("Net Payout", aud(totals.netPayout))}
      ${reportKpi("Balance", aud(totals.balance))}
      ${reportKpi("GST Payable", aud(totals.gstPayable))}
      ${reportKpi("Income Tax Payable", aud(totals.uberTaxPayable))}
    </div>
    <div class="report-two-up">
      <section>
        <h4>Period Performance</h4>
        ${renderBarChart(periodRows.map((row) => ({ label: row.label, value: row.balance })), "Balance")}
      </section>
      <section>
        <h4>Expense Mix</h4>
        ${renderBarChart(expenseRows.map((row) => ({ label: row.category, value: row.amount })), "Expense")}
      </section>
    </div>
    <h4>Period Summary Table</h4>
    ${htmlTable(["Period", "Fare", "GST", "Tax", "Balance"], periodRows.map((row) => [row.label, aud(row.fareGross), aud(row.gstPayable), aud(row.uberTaxPayable), aud(row.balance)]))}
    <h4>Top Weekly Weeks</h4>
    ${htmlTable(["Week", "Gross", "Tips", "Net Payout"], weeklyRows.slice(0, 8).map((row) => [row.label, aud(row.gross), aud(row.tipExtra), aud(row.netPayout)]))}
  `;
}

function renderBasReport(period, year, totals, periodRows) {
  return `
    <div class="report-header">
      <div>
        <h3>BAS & GST Ledger</h3>
        <div class="meta">${cap(period)} ${year} | GST on sales, GST credits and BAS-ready period breakdown.</div>
      </div>
    </div>
    <div class="report-kpis">
      ${reportKpi("G1 Total Sales", aud(totals.gstSalesTotal))}
      ${reportKpi("1A GST on Sales", aud(totals.fareGst))}
      ${reportKpi("1B Expense GST Credits", aud(totals.expenseGstCredit))}
      ${reportKpi("Net GST Payable", aud(totals.gstPayable))}
    </div>
    <h4>GST Ledger by Period</h4>
    ${htmlTable(["Period", "G1 Sales", "GST on Sales", "Expense GST Credits", "GST Payable"], periodRows.map((row) => [row.label, aud(row.gstSalesTotal), aud(row.fareGst), aud(row.expenseGstCredit), aud(row.gstPayable)]))}
    <h4>GST Movement Chart</h4>
    ${renderDualBarChart(periodRows.map((row) => ({ label: row.label, left: row.fareGst, right: row.expenseGstCredit })), "Sales GST", "Credits")}
  `;
}

function renderTaxReport(period, year, totals, periodRows) {
  return `
    <div class="report-header">
      <div>
        <h3>Tax Position</h3>
        <div class="meta">${cap(period)} ${year} | Income tax, PAYG offset and effective tax position.</div>
      </div>
    </div>
    <div class="report-kpis">
      ${reportKpi("Rideshare Taxable Income", aud(totals.rideshareTaxableIncome))}
      ${reportKpi("Income Tax Payable", aud(totals.uberTaxPayable))}
      ${reportKpi("Estimated PAYG Tax", aud(totals.otherIncomeTaxPaid))}
      ${reportKpi("Effective Tax Rate", pct(totals.totalTax / Math.max(totals.taxableIncome, 1)))}
    </div>
    <div class="report-grid">
      ${line("Deduction Method", deductionMethodLabel(totals.deductionMethod))}
      ${line("Total Taxable Income", aud(totals.taxableIncome))}
      ${line("Rideshare Taxable Income", aud(totals.rideshareTaxableIncome))}
      ${line("Total Income-tax Deduction", aud(totals.deductibleExpenses))}
      ${totals.deductionMethod === "cents_per_km" ? line("Vehicle Deduction - Cents/KM", `${aud(totals.centsPerKmDeduction)} (${f2(totals.cappedBusinessKm)} km x ${aud(totals.centsPerKmRate)})`) : line("Actual Expense Deduction", aud(totals.vehicleExpenseDeduction))}
      ${totals.deductionMethod === "cents_per_km" ? line("Other Business Expense Deduction", aud(totals.otherExpenseDeduction)) : ""}
      ${line("Total Tax", aud(totals.totalTax))}
      ${line("Medicare Levy", aud(totals.medicare))}
      ${line("Current Slab", esc(taxSlabForIncome(totals.taxableIncome).label))}
    </div>
    <h4>Period Tax Table</h4>
    ${htmlTable(["Period", "Method", "Deduction", "Rideshare Taxable", "Total Taxable", "Income Tax Payable", "Estimated PAYG", "Balance"], periodRows.map((row) => [row.label, deductionMethodLabel(row.deductionMethod), aud(row.deductibleExpenses), aud(row.rideshareTaxableIncome), aud(row.taxableIncome), aud(row.uberTaxPayable), aud(row.otherIncomeTaxPaid), aud(row.balance)]))}
    <h4>Tax Trend</h4>
    ${renderBarChart(periodRows.map((row) => ({ label: row.label, value: row.uberTaxPayable })), "Tax")}
  `;
}

function renderWeeklyTrendReport(period, year, totals, weeklyRows) {
  return `
    <div class="report-header">
      <div>
        <h3>Weekly Earnings Trend</h3>
        <div class="meta">${cap(period)} ${year} | Weekly gross, tips, payout, GST and tax allocation.</div>
      </div>
    </div>
    <div class="report-kpis">
      ${reportKpi("Weeks Logged", String(weeklyRows.length))}
      ${reportKpi("Average Weekly Gross", aud(avg(weeklyRows.map((x) => x.gross))))}
      ${reportKpi("Average Weekly Net", aud(avg(weeklyRows.map((x) => x.netPayout))))}
      ${reportKpi("Best Week", aud(Math.max(0, ...weeklyRows.map((x) => x.netPayout))))}
    </div>
    <h4>Weekly Payout Chart</h4>
    ${renderBarChart(weeklyRows.map((row) => ({ label: row.start.slice(5), value: row.netPayout })), "Net")}
    <h4>Weekly Detail</h4>
    ${htmlTable(["Week", "Gross", "Tips", "Platform Fees", "Net Payout", "GST Share", "Tax Share"], weeklyRows.map((row) => [row.label, aud(row.gross), aud(row.tipExtra), aud(row.platformFees), aud(row.netPayout), aud(row.gstPayableShare), aud(row.taxPayableShare)]))}
  `;
}

function renderExpenseReport(period, year, totals, expenseRows) {
  return `
    <div class="report-header">
      <div>
        <h3>Expense Breakdown</h3>
        <div class="meta">${cap(period)} ${year} | Cost mix, GST credits and deductible profile.</div>
      </div>
    </div>
    <div class="report-kpis">
      ${reportKpi("Total Expenses", aud(totals.expenseTotal))}
      ${reportKpi("GST Credits", aud(totals.expenseGstCredit))}
      ${reportKpi("Business Use", pct(totals.businessUsePct))}
      ${reportKpi("Platform Fees", aud(totals.platformFees))}
    </div>
    <h4>Expense Category Chart</h4>
    ${renderBarChart(expenseRows.map((row) => ({ label: row.category, value: row.amount })), "Expense")}
    <h4>Expense Category Table</h4>
    ${htmlTable(["Category", "Amount", "GST Credit", "Share"], expenseRows.map((row) => [row.category, aud(row.amount), aud(row.gstCredit), pct(row.share)]))}
  `;
}

function renderLogbookReport(period, year, totals, startDate, endDate) {
  const rows = db.trips.filter((row) => row.date >= startDate && row.date <= endDate).slice(0, 20);
  return `
    <div class="report-header">
      <div>
        <h3>Logbook Compliance</h3>
        <div class="meta">${cap(period)} ${year} | KM evidence, business-use percentage and recent trip entries.</div>
      </div>
    </div>
    <div class="report-kpis">
      ${reportKpi("Total KM", f2(totals.totalKm || 0))}
      ${reportKpi("Uber KM", f2(totals.businessKm || 0))}
      ${reportKpi("Business Use", pct(totals.businessUsePct || 0))}
      ${reportKpi("Trips Logged", String(totals.tripCount || 0))}
    </div>
    <div class="report-grid">
      ${line("ATO Logbook Status", totals.tripCount ? "Entries present" : "No entries")}
      ${line("Business KM Ratio", pct(totals.businessUsePct || 0))}
      ${line("Date Range", `${startDate} to ${endDate}`)}
      ${line("Export Advice", "Keep supporting invoices and receipts")}
    </div>
    <h4>Recent Logbook Entries</h4>
    ${htmlTable(["Date", "Purpose", "Start Odo", "End Odo", "KM", "Notes"], rows.map((row) => [row.date, row.purpose, f2(row.odo_start), f2(row.odo_end), f2(row.km), esc(row.notes || "")]))}
    ${atoLogbookDeclaration()}
  `;
}

function reportKpi(label, value) {
  return `<div class="report-kpi"><span>${label}</span><strong>${value}</strong></div>`;
}

function htmlTable(headers, rows) {
  return `<table>${tableHtml(headers, rows)}</table>`;
}

function renderBarChart(rows, valueLabel) {
  if (!rows.length) return `<div class="empty-chart">No data for this report.</div>`;
  const max = Math.max(...rows.map((row) => n(row.value)), 1);
  return `<div class="bar-chart">${rows.map((row) => `
    <div class="bar-row">
      <div class="bar-label">${esc(row.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(n(row.value) / max) * 100}%"></div></div>
      <div class="bar-value">${aud(row.value)}</div>
    </div>
  `).join("")}</div><div class="chart-caption">${valueLabel}</div>`;
}

function renderDualBarChart(rows, leftLabel, rightLabel) {
  if (!rows.length) return `<div class="empty-chart">No data for this report.</div>`;
  const max = Math.max(...rows.flatMap((row) => [n(row.left), n(row.right)]), 1);
  return `<div class="dual-bar-chart">${rows.map((row) => `
    <div class="dual-row">
      <div class="bar-label">${esc(row.label)}</div>
      <div class="dual-track">
        <div class="bar-fill left" style="width:${(n(row.left) / max) * 100}%"></div>
        <div class="bar-fill right" style="width:${(n(row.right) / max) * 100}%"></div>
      </div>
      <div class="dual-values">${aud(row.left)} / ${aud(row.right)}</div>
    </div>
  `).join("")}</div><div class="chart-legend"><span class="legend left"></span>${leftLabel}<span class="legend right"></span>${rightLabel}</div>`;
}

function expenseCategoryBreakdown(startDate, endDate) {
  const rows = db.expenses.filter((row) => row.date >= startDate && row.date <= endDate);
  const businessUsePct = computeForRange(startDate, endDate).businessUsePct;
  const map = new Map();
  rows.forEach((row) => {
    const category = row.category || "Other";
    if (!map.has(category)) map.set(category, { category, amount: 0, gstCredit: 0 });
    const item = map.get(category);
    item.amount += n(row.amount);
    item.gstCredit += expenseGstCreditValue(row, businessUsePct);
  });
  const total = Array.from(map.values()).reduce((a, x) => a + x.amount, 0) || 1;
  return Array.from(map.values())
    .map((row) => ({ ...row, share: row.amount / total }))
    .sort((a, b) => b.amount - a.amount);
}

function downloadReportCsv(kind) {
  const period = el("summaryPeriod").value;
  const year = Number(el("summaryYear").value || new Date().getFullYear());
  const buckets = bucketizeByPeriod(period, year);
  const startDate = buckets[0]?.from || `${year}-01-01`;
  const endDate = buckets[buckets.length - 1]?.to || `${year}-12-31`;
  let headers = [];
  let rows = [];
  if (kind === "weekly") {
    headers = ["week", "gross", "tips", "platform_fees", "net_payout", "gst_share", "tax_share"];
    rows = weeklyFareSummaries().filter((row) => row.start >= startDate && row.start <= endDate).map((row) => [row.label, row.gross, row.tipExtra, row.platformFees, row.netPayout, row.gstPayableShare, row.taxPayableShare]);
  } else if (kind === "expenses") {
    headers = ["category", "amount", "gst_credit", "share_pct"];
    rows = expenseCategoryBreakdown(startDate, endDate).map((row) => [row.category, round2(row.amount), round2(row.gstCredit), round2(row.share * 100)]);
  } else if (kind === "logbook") {
    headers = ["date", "purpose", "odo_start", "odo_end", "km", "notes"];
    rows = db.trips.filter((row) => row.date >= startDate && row.date <= endDate).map((row) => [row.date, row.purpose, row.odo_start, row.odo_end, row.km, row.notes || ""]);
  } else {
    headers = ["period", "fare", "gst_collected", "gst_credits", "gst_payable", "deduction_method", "deductible_expenses", "cents_per_km_deduction", "cents_per_km_used", "rideshare_taxable_income", "total_taxable_income", "income_tax_payable", "balance"];
    rows = bucketizeByPeriod(period, year).map((bucket) => {
      const row = computeForRange(bucket.from, bucket.to);
      return [bucket.label, round2(row.fareGross), round2(row.fareGst), round2(row.expenseGstCredit), round2(row.gstPayable), deductionMethodLabel(row.deductionMethod), round2(row.deductibleExpenses), round2(row.centsPerKmDeduction), round2(row.cappedBusinessKm), round2(row.rideshareTaxableIncome), round2(row.taxableIncome), round2(row.uberTaxPayable), round2(row.balance)];
    });
  }
  const lines = [headers.join(",")].concat(rows.map((row) => row.map(csvCell).join(",")));
  downloadFile(`ridemint-${kind}-${year}.csv`, lines.join("\n"), "text/csv");
}

function openReportPdfView() {
  const report = buildReportModel(activeReportKind, el("summaryPeriod").value, Number(el("summaryYear").value || new Date().getFullYear()));
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!doctype html><html><head><title>${report.title}</title><style>
    body{font-family:Arial,sans-serif;padding:24px;color:#10233d}
    h3,h4{margin:0 0 10px} .meta{color:#5b6b7c;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}
    th,td{border:1px solid #d8e2ed;padding:8px;text-align:left}
    .report-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}
    .report-kpi{border:1px solid #d8e2ed;border-radius:12px;padding:10px}
    .report-kpi span{display:block;color:#60748a;font-size:12px}.report-kpi strong{display:block;font-size:18px;margin-top:4px}
    .bar-row,.dual-row{display:grid;grid-template-columns:140px 1fr 140px;gap:10px;align-items:center;margin:8px 0}
    .bar-track,.dual-track{height:12px;background:#edf4fb;border-radius:999px;overflow:hidden}
    .bar-fill{height:100%;background:#2563eb}.bar-fill.right{background:#14b8a6}.bar-fill.left{background:#2563eb}
  </style></head><body>${report.html}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

function currentBusinessUsePct() {
  const trips = scopedData().trips;
  const totalKm = sum(trips, "km");
  if (totalKm <= 0) return 0;
  const businessKm = trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  return businessKm / totalKm;
}

function expenseGstCreditValue(row, businessUsePct = currentBusinessUsePct()) {
  if (!row?.gst_claimable) return 0;
  const gstAmount = n(row.gst_amount);
  return gstAmount > 0 ? round2(gstAmount * businessUsePct) : 0;
}

function computeForRange(from, to) {
  const inRange = (d) => d >= from && d <= to;
  const fares = db.fares.filter((x) => inRange(x.date));
  const expenses = db.expenses.filter((x) => inRange(x.date));
  const tolls = db.tolls.filter((x) => inRange(x.date));
  const trips = db.trips.filter((x) => inRange(x.date));

  const fareGross = sum(fares, "gross");
  const fareGst = fares.reduce((a, x) => a + gstFromFare(x), 0);
  const tipExtra = fares.reduce((a, x) => a + n(x.tip_extra), 0);
  const gstSalesTotal = fareGross + tipExtra;
  const platformFees = fares.reduce((a, x) => a + n(x.platform_fee), 0);
  const platformFeeGst = fares.reduce((a, x) => a + n(x.platform_fee_gst), 0);
  const fareAfterUberFee = round2(fareGross - platformFees);
  const netPayout = fares.reduce((a, x) => a + netPayoutForFare(x), 0);
  const expenseTotal = sum(expenses, "amount");
  const tollTotal = sum(tolls, "amount");
  const reimbursedTolls = tolls.reduce((a, x) => a + (x.reimbursed ? x.amount : 0), 0);

  const totalKm = sum(trips, "km");
  const businessKm = trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  const tripCount = trips.length;
  const businessUsePct = totalKm > 0 ? businessKm / totalKm : 0;
  const businessUseExpenseAmount = round2(expenseTotal * businessUsePct);
  const expenseOnlyGstCredit = expenses.reduce((a, x) => a + expenseGstCreditValue(x, businessUsePct), 0);
  const expenseGstCredit = expenseOnlyGstCredit;
  const gstPayable = Math.max(0, fareGst - expenseGstCredit);
  const otherIncomeAllocated = allocateAnnualValueToRange(n(db.tax?.other_income || 0), from, to);
  const superAllocated = allocateAnnualValueToRange(n(db.tax?.super_contribution || 0), from, to);
  const taxSettings = normalizeTaxSettings({
    ...(db.tax || DEFAULT_TAX_SETTINGS),
    other_income: otherIncomeAllocated,
    super_contribution: superAllocated,
    cents_per_km_cap: allocateAnnualValueToRange(n(db.tax?.cents_per_km_cap ?? DEFAULT_TAX_SETTINGS.cents_per_km_cap), from, to)
  });
  const deduction = computeDeductionModel({ expenses, businessUsePct, businessKm, superContrib: superAllocated, taxSettings });
  const deductibleExpenses = deduction.deductibleExpenses;
  const rideshareTaxableIncome = Math.max(0, netPayout - gstPayable - deductibleExpenses);
  const taxableIncome = Math.max(0, rideshareTaxableIncome + otherIncomeAllocated);
  const taxBreakdown = computeTaxBreakdown(rideshareTaxableIncome, otherIncomeAllocated);
  const incomeTax = taxBreakdown.incomeTax;
  const medicare = taxBreakdown.medicare;
  const totalTax = taxBreakdown.totalTax;
  const preTaxBalance = netPayout - gstPayable - expenseTotal;
  const dashboardTaxableIncome = rideshareTaxableIncome;
  const afterTaxIncome = netPayout - gstPayable - taxBreakdown.uberTaxPayable;
  const balance = netPayout - gstPayable - taxBreakdown.uberTaxPayable - expenseTotal;
  const inHand = balance;
  const rideshareEffectiveTaxRate = rideshareTaxableIncome > 0 ? taxBreakdown.uberTaxPayable / rideshareTaxableIncome : 0;

  return {
    fareGross,
    gstSalesTotal,
    tipExtra,
    fareAfterUberFee,
    expenseTotal,
    netPayout,
    platformFees,
    platformFeeGst,
    tollTotal,
    reimbursedTolls,
    fareGst,
    businessUseExpenseAmount,
    expenseOnlyGstCredit,
    expenseGstCredit,
    gstPayable,
    totalKm,
    businessKm,
    tripCount,
    businessUsePct,
    businessUseExpenses: deduction.businessUseExpenses,
    deductibleExpenses,
    deductionMethod: deduction.deductionMethod,
    vehicleExpenseTotal: deduction.vehicleExpenseTotal,
    vehicleExpenseDeduction: deduction.vehicleExpenseDeduction,
    otherExpenseDeduction: deduction.otherExpenseDeduction,
    centsPerKmDeduction: deduction.centsPerKmDeduction,
    centsPerKmRate: deduction.centsPerKmRate,
    centsPerKmCap: deduction.centsPerKmCap,
    cappedBusinessKm: deduction.cappedBusinessKm,
    rideshareTaxableIncome,
    taxableIncome,
    incomeTax,
    medicare,
    totalTax,
    uberTaxPayable: taxBreakdown.uberTaxPayable,
    otherIncomeTaxPaid: taxBreakdown.otherIncomeTaxPaid,
    preTaxBalance,
    dashboardTaxableIncome,
    afterTaxIncome,
    balance,
    rideshareEffectiveTaxRate,
    inHand
  };
}

function bucketizeByPeriod(period, year) {
  const fy = financialYearRange(year);
  if (period === "yearly") {
    return [{ label: fy.label, from: fy.from, to: fy.to }];
  }
  if (period === "quarterly") {
    return [
      { label: `Q1 ${fy.label}`, from: `${year - 1}-07-01`, to: `${year - 1}-09-30` },
      { label: `Q2 ${fy.label}`, from: `${year - 1}-10-01`, to: `${year - 1}-12-31` },
      { label: `Q3 ${fy.label}`, from: `${year}-01-01`, to: `${year}-03-31` },
      { label: `Q4 ${fy.label}`, from: `${year}-04-01`, to: `${year}-06-30` }
    ];
  }
  return Array.from({ length: 12 }).map((_, i) => {
    const date = new Date(year - 1, 6 + i, 1);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const calendarYear = date.getFullYear();
    const last = new Date(calendarYear, date.getMonth() + 1, 0).getDate();
    return { label: `${calendarYear}-${month}`, from: `${calendarYear}-${month}-01`, to: `${calendarYear}-${month}-${String(last).padStart(2, "0")}` };
  });
}

function atoLogbookDeclaration() {
  return `
    <h3>ATO Logbook Declaration</h3>
    <p>This report includes date, start/end odometer, km, purpose, and trip route fields suitable for ATO logbook evidence. Keep invoices/receipts for all expenses and tolls.</p>
  `;
}

function exportLogbookCsv() {
  const headers = ["date", "purpose", "odo_start", "odo_end", "km", "from_location", "to_location", "notes"];
  const lines = [headers.join(",")];
  db.trips.forEach((t) => {
    lines.push(headers.map((h) => csvCell(t[h] ?? "")).join(","));
  });
  downloadFile(`ridemint-logbook-${today}.csv`, lines.join("\n"), "text/csv");
}

function bindRowActions() {
  bindSwipeRows();
}

function tableHtml(headers, rows) {
  const h = `<tr>${headers.map((x) => `<th>${x}</th>`).join("")}</tr>`;
  const b = rows.length ? rows.map((r) => `<tr class="swipe-row">${r.map((c, i) => `<td class="${i === r.length - 1 ? "action-cell" : ""}">${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">No records.</td></tr>`;
  return h + b;
}
function delBtn(table, id) { return `<button type="button" class="del" data-table="${table}" data-id="${id}">Delete</button>`; }
function editBtn(table, id) { return `<button type="button" class="edit" data-table="${table}" data-id="${id}">Edit</button>`; }
function actionBtns(table, id) { return `<div class="actions-row">${editBtn(table, id)} ${delBtn(table, id)}</div>`; }

function bindRowActionDelegates() {
  if (rowActionDelegatesBound) return;
  rowActionDelegatesBound = true;
  document.addEventListener("click", async (evt) => {
    const editButton = evt.target.closest(".edit");
    if (editButton) {
      evt.preventDefault();
      startEdit(editButton.dataset.table, editButton.dataset.id);
      return;
    }
    const deleteButton = evt.target.closest(".del");
    if (deleteButton) {
      evt.preventDefault();
      const table = deleteButton.dataset.table;
      const id = deleteButton.dataset.id;
      if (!table || !id || !supabase) return;
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) return alert(`Delete failed: ${error.message}`);
      await refreshAll();
      return;
    }
    const receiptPdfButton = evt.target.closest(".receipt-pdf");
    if (receiptPdfButton) {
      evt.preventDefault();
      const receipt = db.receipts.find((x) => x.id === receiptPdfButton.dataset.id);
      if (receipt) await downloadSingleReceipt(receipt);
    }
  });
}

function startEdit(table, id) {
  if (table === "trips") {
    const r = db.trips.find((x) => x.id === id); if (!r) return;
    const f = el("tripForm"); editing.trips = id;
    f.date.value = r.date; f.purpose.value = r.purpose; f.odo_start.value = r.odo_start; f.odo_end.value = r.odo_end;
    f.from_location.value = r.from_location || ""; f.to_location.value = r.to_location || ""; f.notes.value = r.notes || "";
    setEditUI("tripSubmitBtn", "tripCancelEditBtn", true, "Update Logbook Entry");
  }
  if (table === "fares") {
    const r = db.fares.find((x) => x.id === id); if (!r) return;
    const f = el("fareForm"); editing.fares = id;
    f.date.value = r.date; f.platform.value = r.platform; f.gross.value = r.gross; f.gst_included.value = String(!!r.gst_included);
    f.platform_fee.value = r.platform_fee || 0; f.platform_fee_gst.value = (n(r.platform_fee) / 11).toFixed(2);
    if (f.tip_extra) f.tip_extra.value = r.tip_extra || 0;
    if (f.net_payout) f.net_payout.value = round2(netPayoutForFare(r)).toFixed(2);
    updateFareWeekFields();
    setEditUI("fareSubmitBtn", "fareCancelEditBtn", true, "Update Weekly Income");
  }
  if (table === "expenses") {
    const r = db.expenses.find((x) => x.id === id); if (!r) return;
    const f = el("expenseForm"); editing.expenses = id;
    f.date.value = r.date; f.category.value = r.category; if (f.is_vehicle_expense) f.is_vehicle_expense.value = isVehicleRunningExpense(r) ? "true" : "false"; f.amount.value = r.amount; if (f.gst_amount) f.gst_amount.value = round2(r.gst_amount || 0).toFixed(2); f.gst_claimable.value = String(!!r.gst_claimable); if (f.gst_credit) f.gst_credit.value = round2(expenseGstCreditValue(r)).toFixed(2); f.notes.value = r.notes || "";
    setEditUI("expenseSubmitBtn", "expenseCancelEditBtn", true, "Update Expense");
  }
  if (table === "tolls") {
    const r = db.tolls.find((x) => x.id === id); if (!r) return;
    const f = el("tollForm"); editing.tolls = id;
    f.date.value = r.date; f.amount.value = r.amount; f.reimbursed.value = String(!!r.reimbursed);
    setEditUI("tollSubmitBtn", "tollCancelEditBtn", true, "Update Toll");
  }
}

function clearEdit(table) {
  if (table === "trips") { editing.trips = null; setEditUI("tripSubmitBtn", "tripCancelEditBtn", false, "Add Logbook Entry"); }
  if (table === "fares") { editing.fares = null; setEditUI("fareSubmitBtn", "fareCancelEditBtn", false, "Add Weekly Income"); updateFareWeekFields(); }
  if (table === "expenses") { editing.expenses = null; setEditUI("expenseSubmitBtn", "expenseCancelEditBtn", false, "Add Expense"); }
  if (table === "tolls") { editing.tolls = null; setEditUI("tollSubmitBtn", "tollCancelEditBtn", false, "Add Toll"); }
}

function setEditUI(submitId, cancelId, isEditing, submitLabel) {
  const s = el(submitId), c = el(cancelId);
  if (s) s.textContent = submitLabel;
  if (c) c.classList.toggle("hidden", !isEditing);
}

function bindSwipeRows() {
  const rows = document.querySelectorAll(".swipe-row");
  rows.forEach((row) => {
    if (row.dataset.swipeBound === "true") return;
    row.dataset.swipeBound = "true";
    let startX = 0;
    let startY = 0;
    row.addEventListener("touchstart", (e) => {
      const touch = e.changedTouches[0];
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    row.addEventListener("touchend", (e) => {
      if (e.target.closest(".actions-row")) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) <= Math.abs(dy)) return;
      if (dx < -56) row.classList.add("reveal");
      if (dx > 28) row.classList.remove("reveal");
    }, { passive: true });
  });
}
function renderTaxBreakdown() {
  const m = computeMetrics(readDraftTaxValues());
  const otherIncome = n(readDraftTaxValues().other_income);
  const html = `
    <div class="tax-panel">
      <strong>GST Position</strong>
      <div class="meta">GST collected from fares versus GST credits from expenses and platform fees.</div>
      ${line("G1 Total Sales incl Tips/Bonus", aud(m.gstSalesTotal))}
      ${line("GST on Sales (1A)", aud(m.fareGst))}
      ${line("Expense GST Credits (1B)", aud(m.expenseGstCredit))}
      ${line("Platform Fee GST (not deducted here)", aud(m.platformFeeGst))}
      ${line("GST Total Payable", aud(m.gstPayable))}
    </div>
    <div class="tax-panel">
      <strong>Rideshare Tax Payable</strong>
      <div class="meta">Tax still payable from Uber and rideshare activity after excluding PAYG salary tax already withheld.</div>
      ${line("Ride Share Total Income", aud(m.netPayout))}
      ${line("Deduction Method", deductionMethodLabel(m.deductionMethod))}
      ${line("Total Income-tax Deduction", aud(m.deductibleExpenses))}
      ${m.deductionMethod === "cents_per_km" ? line("Vehicle Deduction - Cents/KM", `${aud(m.centsPerKmDeduction)} (${f2(m.cappedBusinessKm)} km x ${aud(m.centsPerKmRate)})`) : line("Actual Expense Deduction", aud(m.vehicleExpenseDeduction))}
      ${m.deductionMethod === "cents_per_km" ? line("Other Business Expense Deduction", aud(m.otherExpenseDeduction)) : ""}
      ${line("Deductible Super", aud(n(readDraftTaxValues().super_contribution)))}
      ${line("Rideshare Taxable Income", aud(m.rideshareTaxableIncome))}
      ${line("Income Tax Payable", aud(m.uberTaxPayable))}
      ${line("Effective Rideshare Tax Rate", pct(m.rideshareEffectiveTaxRate))}
      ${line("GST Payable", aud(m.gstPayable))}
      ${line("Rideshare After Tax Income", aud(m.afterTaxIncome))}
    </div>
    <div class="tax-panel">
      <strong>Other Income Tax Position</strong>
      <div class="meta">This is treated as PAYG income already taxed through salary withholding.</div>
      ${line("Other Income Entered", aud(otherIncome))}
      ${line("Estimated PAYG Tax on Other Income", aud(m.otherIncomeTaxPaid))}
      ${line("Current Tax Slab", esc(m.slabLabel))}
    </div>
  `;
  if (el("taxBreakdown")) el("taxBreakdown").innerHTML = html;
}

function readDraftTaxValues() {
  const form = el("taxForm");
  if (!form) return {};
  return {
    other_income: n(form.other_income?.value),
    super_contribution: n(form.super_contribution?.value),
    deduction_method: validDeductionMethod(form.deduction_method?.value),
    cents_per_km_rate: n(form.cents_per_km_rate?.value || DEFAULT_TAX_SETTINGS.cents_per_km_rate),
    cents_per_km_cap: n(form.cents_per_km_cap?.value || DEFAULT_TAX_SETTINGS.cents_per_km_cap)
  };
}

function taxSlabForIncome(income) {
  const brackets = [
    { upto: 18200, rate: 0, label: "0% up to $18,200" },
    { upto: 45000, rate: 0.16, label: "16% from $18,201 to $45,000" },
    { upto: 135000, rate: 0.30, label: "30% from $45,001 to $135,000" },
    { upto: 190000, rate: 0.37, label: "37% from $135,001 to $190,000" },
    { upto: Infinity, rate: 0.45, label: "45% above $190,000" }
  ];
  return brackets.find((x) => income <= x.upto) || brackets[brackets.length - 1];
}

function computeTaxBreakdown(rideshareTaxableIncome, otherIncome) {
  const taxableIncome = Math.max(0, rideshareTaxableIncome + otherIncome);
  const incomeTax = estimateTaxAu(taxableIncome);
  const medicare = taxableIncome * 0.02;
  const totalTax = incomeTax + medicare;
  const otherIncomeTaxPaid = estimateTaxAu(otherIncome) + otherIncome * 0.02;
  const uberTaxPayable = Math.max(0, totalTax - otherIncomeTaxPaid);
  return { incomeTax, medicare, totalTax, otherIncomeTaxPaid, uberTaxPayable };
}

function allocateAnnualValueToRange(total, from, to) {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  const fyEnd = currentFinancialYearEnd(start);
  const yearStart = new Date(fyEnd - 1, 6, 1);
  const yearEnd = new Date(fyEnd, 5, 30);
  const clippedStart = start < yearStart ? yearStart : start;
  const clippedEnd = end > yearEnd ? yearEnd : end;
  const daysInRange = Math.max(0, Math.round((clippedEnd - clippedStart) / 86400000) + 1);
  const daysInYear = Math.round((yearEnd - yearStart) / 86400000) + 1;
  return round2((n(total) * daysInRange) / daysInYear);
}

function weeklyFareSummaries() {
  const totals = computeMetrics();
  return scopedData().fares
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((fare) => {
      const netPayout = netPayoutForFare(fare);
      const share = totals.netPayout > 0 ? netPayout / totals.netPayout : 0;
      return {
        id: fare.id,
        label: `${fare.date} to ${fare.week_end || addDays(fare.date, 6)}`,
        start: fare.date,
        end: fare.week_end || addDays(fare.date, 6),
        gross: round2(fare.gross),
        tipExtra: round2(fare.tip_extra),
        platformFees: round2(fare.platform_fee),
        platformFeeGst: round2(fare.platform_fee_gst),
        fareGst: round2(gstFromFare(fare)),
        netPayout: round2(netPayout),
        gstPayableShare: round2(totals.gstPayable * share),
        taxPayableShare: round2(totals.uberTaxPayable * share)
      };
    });
}

function weekRange(dateStr) {
  const date = parseLocalDate(dateStr || today);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: formatDateLocal(monday), end: formatDateLocal(sunday) };
}

function weekLabel(dateStr) {
  const week = weekRange(dateStr);
  return `${week.start} to ${week.end}`;
}

async function clearAllAccountData() {
  if (!currentUser || !supabase) return setStatus("clearAllStatus", "Login required.", true);
  const phraseOk = (el("clearAllPhrase")?.value || "").trim() === "DELETE ALL";
  const emailOk = ((el("clearAllEmail")?.value || "").trim().toLowerCase() === (currentUser.email || "").toLowerCase());
  const checkOne = !!el("confirmClearOne")?.checked;
  const checkTwo = !!el("confirmClearTwo")?.checked;
  if (!checkOne || !checkTwo || !phraseOk || !emailOk) {
    return setStatus("clearAllStatus", "Complete all confirmations before deleting data.", true);
  }
  if (!window.confirm("Final confirmation: delete all data for this account?")) return;
  setStatus("clearAllStatus", "Clearing account data...");
  const tables = ["trips", "fares", "expenses", "tolls", "receipts", "tax_settings"];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq("user_id", currentUser.id);
    if (error) return setStatus("clearAllStatus", `Delete failed in ${table}: ${error.message}`, true);
  }
  ["confirmClearOne", "confirmClearTwo"].forEach((id) => { if (el(id)) el(id).checked = false; });
  if (el("clearAllPhrase")) el("clearAllPhrase").value = "";
  if (el("clearAllEmail")) el("clearAllEmail").value = "";
  setStatus("clearAllStatus", "All account data deleted.");
  await refreshAll();
}

function gstSalesBaseForFare(x) { return n(x.gross) + n(x.tip_extra); }
function gstFromFare(x) { return x.gst_included ? gstSalesBaseForFare(x) / 11 : gstSalesBaseForFare(x) * 0.1; }
function netPayoutForFare(x) { return round2(n(x.net_payout || (n(x.gross) + n(x.tip_extra) - n(x.platform_fee)))); }
function parseBoolish(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1", "vehicle", "vehicle running cost"].includes(text)) return true;
  if (["false", "no", "n", "0", "other", "other business expense", "non-vehicle"].includes(text)) return false;
  return n(value) > 0;
}
function estimateTaxAu(income) {
  let tax = 0, prev = 0;
  const brackets = [[18200, 0], [45000, 0.16], [135000, 0.30], [190000, 0.37], [Infinity, 0.45]];
  for (const [cap, rate] of brackets) {
    if (income > cap) { tax += (cap - prev) * rate; prev = cap; }
    else { tax += (income - prev) * rate; break; }
  }
  return Math.max(0, tax);
}
function distinctMonths(dates) { return new Set(dates.filter(Boolean).map((d) => d.slice(0, 7))); }
function setStatus(id, msg, isErr = false) { const e = el(id); e.textContent = msg; e.style.color = isErr ? "#b91c1c" : "#0f5132"; }
function n(v) { return Number(v || 0); }
function round2(v) { return Number(n(v).toFixed(2)); }
function sum(arr, k) { return arr.reduce((a, x) => a + n(x[k]), 0); }
function avg(arr) { return arr.length ? sum(arr.map((x) => ({ value: x })), "value") / arr.length : 0; }
function f2(v) { return n(v).toFixed(2); }
function aud(v) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n(v)); }
function pct(v) { return `${(n(v) * 100).toFixed(1)}%`; }
function esc(s) { return String(s ?? "").replace(/[&<>\"]/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m])); }
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
function line(k, v) { return `<div class="report-line"><span>${k}</span><strong>${v}</strong></div>`; }
function csvCell(v) { const s = String(v).replace(/"/g, '""'); return `"${s}"`; }
function parseLocalDate(s) {
  const [y, m, d] = String(s || today).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDays(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + Number(days || 0));
  return formatDateLocal(d);
}
function formatDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadAllReceiptsPdf() {
  const receipts = db.receipts || [];
  if (!receipts.length) return setStatus("receiptStatus", "No receipts to download.", true);
  await downloadReceiptsPdf(receipts, `ridemint-receipts-${today}.pdf`);
}

async function downloadSingleReceipt(receipt) {
  if (isPdfReceipt(receipt)) {
    downloadDataUrl(
      receipt.image_data,
      `${safeFileName(receipt.title || "receipt")}-${receipt.receipt_date || today}.pdf`
    );
    return;
  }
  await downloadReceiptsPdf([receipt], `ridemint-receipt-${receipt.receipt_date || today}.pdf`);
}

async function downloadReceiptsPdf(receipts, fileName) {
  const PdfDocument = window.PDFLib?.PDFDocument;
  if (!PdfDocument) return setStatus("receiptStatus", "PDF library is still loading. Try again in a moment.", true);
  setStatus("receiptStatus", "Preparing receipt PDF...");
  try {
    const output = await PdfDocument.create();
    for (const receipt of receipts) {
      if (isPdfReceipt(receipt)) {
        const source = await PdfDocument.load(dataUrlBytes(receipt.image_data));
        const pages = await output.copyPages(source, source.getPageIndices());
        pages.forEach((page) => output.addPage(page));
        continue;
      }
      const image = await output.embedJpg(dataUrlBytes(receipt.image_data));
      const page = output.addPage([595.28, 841.89]);
      const margin = 36;
      const maxW = page.getWidth() - margin * 2;
      const maxH = page.getHeight() - margin * 2 - 24;
      const ratio = Math.min(maxW / image.width, maxH / image.height);
      const width = image.width * ratio;
      const height = image.height * ratio;
      page.drawText(`${receipt.title || "Receipt"} - ${receipt.receipt_date || ""}`, {
        x: margin,
        y: page.getHeight() - 28,
        size: 11
      });
      page.drawImage(image, {
        x: (page.getWidth() - width) / 2,
        y: page.getHeight() - 48 - height,
        width,
        height
      });
    }
    const bytes = await output.save();
    downloadBlob(new Blob([bytes], { type: "application/pdf" }), fileName);
    setStatus("receiptStatus", "Receipt PDF downloaded.");
  } catch (err) {
    setStatus("receiptStatus", `PDF creation failed: ${err?.message || "Unknown error"}`, true);
  }
}

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadDataUrl(dataUrl, fileName) {
  const mime = String(dataUrl).match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  downloadBlob(new Blob([dataUrlBytes(dataUrl)], { type: mime }), fileName);
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(value) {
  return String(value).trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "receipt";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").then((registration) => {
      registration.update().catch(() => {});
      if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (window.__RIDEMINT_RELOADING__) return;
        window.__RIDEMINT_RELOADING__ = true;
        window.location.reload();
      });
    }).catch(() => {});
  });
}

function bindAutoRefresh() {
  window.addEventListener("focus", () => {
    if (currentUser) refreshAll(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentUser) refreshAll(true);
  });
  window.addEventListener("online", () => {
    if (currentUser) refreshAll(true);
  });
  window.setInterval(() => {
    if (currentUser && !document.hidden) refreshAll(true);
  }, 30000);
}
})();
