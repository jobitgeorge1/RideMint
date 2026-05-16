(() => {
if (window.__RIDEMINT_APP_LOADED__) {
  console.warn("RideMint app.js already loaded; skipping duplicate init.");
  return;
}
window.__RIDEMINT_APP_LOADED__ = true;

const APP_KEY = "ridemint-pro-config";
const DEFAULT_SUPABASE_URL = window.RIDEMINT_CONFIG?.SUPABASE_URL || "";
const DEFAULT_SUPABASE_ANON = window.RIDEMINT_CONFIG?.SUPABASE_ANON_KEY || "";
const today = new Date().toISOString().slice(0, 10);

let supabase = null;
let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let db = { trips: [], fares: [], expenses: [], tolls: [], tax: null, platforms: [] };
let editing = { trips: null, fares: null, expenses: null, tolls: null };
let activeTab = "dashboard";

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
  if (el("buildTag")) el("buildTag").textContent = "Build: RM-2026-05-16c (JS active)";
  registerServiceWorker();
  setStatus("authStatus", "Login to continue.");
  ["tripForm", "expenseForm", "tollForm"].forEach((id) => {
    const f = el(id);
    if (f?.date) f.date.value = today;
  });
  if (el("fareForm")?.date) el("fareForm").date.value = weekRange(today).start;
  if (el("summaryYear")) el("summaryYear").value = new Date().getFullYear();
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
  bindClick("printBasBtn", () => downloadReportWorkbook("bas"));
  bindClick("printTaxBtn", () => downloadReportWorkbook("tax"));
  bindClick("printReportBtn", () => downloadReportWorkbook("full"));
  bindClick("printReportBtn2", () => downloadReportWorkbook("full"));
  bindClick("exportLogbookCsvBtn", exportLogbookCsv);
  bindClick("saveAdminRoleBtn", updateUserRole);
  bindClick("refreshAdminsBtn", loadAdminUsers);
  bindClick("addPlatformBtn", addPlatformOption);
  bindClick("refreshPlatformsBtn", loadPlatformOptions);
  bindClick("importWorkbookBtn", importWorkbook);
  bindClick("clearAllDataBtn", clearAllAccountData);
  bindClick("tripCancelEditBtn", () => clearEdit("trips"));
  bindClick("fareCancelEditBtn", () => clearEdit("fares"));
  bindClick("expenseCancelEditBtn", () => clearEdit("expenses"));
  bindClick("tollCancelEditBtn", () => clearEdit("tolls"));
  bindFareFeeAutoCalc();
  bindFareWeekFields();
  bindTaxLivePreview();
  bindExpenseGstCalc();
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
  ["other_income", "super_contribution"].forEach((name) => {
    form[name]?.addEventListener("input", () => {
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
    toggleApp();
    if (currentUser) await refreshAll();
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
  db = { trips: [], fares: [], expenses: [], tolls: [], tax: null, platforms: [] };
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

async function refreshAll() {
  await loadProfile();
  applyAdminVisibility();
  await Promise.all([loadTable("trips"), loadTable("fares"), loadTable("expenses"), loadTable("tolls"), loadTax(), loadPlatformOptions()]);
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
  const { data, error } = await supabase.from(table).select("*").order("date", { ascending: false });
  if (error) return;
  db[table] = data || [];
}

async function loadTax() {
  const { data } = await supabase.from("tax_settings").select("*").limit(1).maybeSingle();
  db.tax = data || { other_income: 0, super_contribution: 0 };
  el("taxForm").other_income.value = db.tax.other_income || 0;
  el("taxForm").super_contribution.value = db.tax.super_contribution || 0;
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

    const incomeResult = incomeRows.length ? await mergeRows("fares", incomeRows, fareImportKey) : { inserted: 0, updated: 0 };
    const expenseResult = expenseRows.length ? await mergeRows("expenses", expenseRows, expenseImportKey) : { inserted: 0, updated: 0 };
    const logbookResult = logbookRows.length ? await mergeRows("trips", logbookRows, tripImportKey) : { inserted: 0, updated: 0 };
    const tollResult = tollRows.length ? await mergeRows("tolls", tollRows, tollImportKey) : { inserted: 0, updated: 0 };
    await refreshAll();
    setStatus(
      "importStatus",
      `Import synced. Income: +${incomeResult.inserted} / updated ${incomeResult.updated}, Expenses: +${expenseResult.inserted} / updated ${expenseResult.updated}, Logbook: +${logbookResult.inserted} / updated ${logbookResult.updated}, Tolls: +${tollResult.inserted} / updated ${tollResult.updated}.`
    );
  } catch (err) {
    setStatus("importStatus", err?.message || "Import failed.", true);
  }
}

async function mergeRows(table, rows, keyFn) {
  const { data: existing, error } = await supabase.from(table).select("*");
  if (error) throw new Error(`${cap(table)} lookup failed: ${error.message}`);
  const existingMap = new Map((existing || []).map((row) => [keyFn(row), row]));
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const key = keyFn(row);
    const match = existingMap.get(key);
    if (!match) {
      const { error: insertError } = await supabase.from(table).insert(row);
      if (insertError) throw new Error(`${cap(table)} import failed: ${insertError.message}`);
      inserted += 1;
      continue;
    }
    const payload = changedPayload(match, row);
    if (Object.keys(payload).length) {
      const { error: updateError } = await supabase.from(table).update(payload).eq("id", match.id);
      if (updateError) throw new Error(`${cap(table)} update failed: ${updateError.message}`);
      updated += 1;
    }
  }
  return { inserted, updated };
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
      date: normalizeExcelDate(r["From Date"] || r["Date"]),
      week_end: normalizeExcelDate(r["To Date"]) || addDays(normalizeExcelDate(r["From Date"] || r["Date"]), 6),
      platform: "Uber",
      gross: n(r["Trip Gross Fare"]),
      gst_included: true,
      platform_fee: n(r["Uber Service Fee"]),
      platform_fee_gst: n(r["GST on Uber Fee"]),
      tip_extra: n(r["Tip/Extra"]),
      net_payout: n(r["Net Payout"]) || round2(n(r["Trip Gross Fare"]) + n(r["Tip/Extra"]) - n(r["Uber Service Fee"]))
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
      return {
        user_id: currentUser.id,
        date: normalizeExcelDate(r["Date"]),
        category: String(r["Expense Type"] || "Other"),
        amount: n(r["Total Amount"]),
        gst_amount: n(r["GST Amount"]),
        gst_claimable: n(r["GST Claimable"]) > 0,
        gst_credit: n(r["GST Claimable"]),
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
    amount: n(f.amount.value),
    gst_amount: n(f.gst_amount.value),
    gst_claimable: f.gst_claimable.value === "true",
    gst_credit: f.gst_claimable.value === "true" ? (n(f.gst_credit.value) || n(f.gst_amount.value)) : 0,
    notes: f.notes.value
  };
  if (editing.expenses) await supabase.from("expenses").update(payload).eq("id", editing.expenses);
  else await supabase.from("expenses").insert(payload);
  clearEdit("expenses");
  f.reset(); f.date.value = today;
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
    other_income: n(f.other_income.value),
    super_contribution: n(f.super_contribution.value)
  };
  const { data } = await supabase.from("tax_settings").select("id").limit(1).maybeSingle();
  if (data?.id) {
    await supabase.from("tax_settings").update(payload).eq("id", data.id);
  } else {
    await supabase.from("tax_settings").insert(payload);
  }
  setStatus("taxStatus", "Tax settings saved.");
  await refreshAll();
}

function renderAll() {
  renderTripTable(); renderLogbookSummary(); renderFareWeeklyTable(); renderExpenseTable(); renderTollTable(); renderKpis(); renderDashboardHero(); renderReport(); renderTaxBreakdown();
  updateAutoTaxPct();
}

function renderTripTable() {
  el("tripTable").innerHTML = tableHtml(
    ["Date", "Purpose", "Start Odo", "End Odo", "KM", "Actions"],
    db.trips.map((x) => [x.date, x.purpose, f2(x.odo_start), f2(x.odo_end), f2(x.km), actionBtns("trips", x.id)])
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
function renderExpenseTable() {
  const businessUsePct = currentBusinessUsePct();
  el("expenseTable").innerHTML = tableHtml(
    ["Date", "Category", "Amount", "GST Credit", "Actions"],
    db.expenses.map((x) => [x.date, esc(x.category), aud(x.amount), aud(expenseGstCreditValue(x, businessUsePct)), actionBtns("expenses", x.id)])
  );
  bindRowActions();
}
function renderTollTable() {
  el("tollTable").innerHTML = tableHtml(
    ["Date", "Amount", "Reimbursed", "Actions"],
    db.tolls.map((x) => [x.date, aud(x.amount), x.reimbursed ? "Yes" : "No", actionBtns("tolls", x.id)])
  );
  bindRowActions();
}

function renderKpis() {
  const m = computeMetrics();
  const cards = [
    ["Trip Gross Fare", aud(m.fareGross), "kpi-tone-1"],
    ["Uber Trip KM", f2(m.businessKm), "kpi-tone-2"],
    ["Tip / Extra", aud(m.tipExtra), "kpi-tone-2"],
    ["Tolls Tracked", aud(m.tollTotal), "kpi-tone-4"],
    ["Net Payout", aud(m.netPayout), "kpi-tone-3"],
    ["GST Payable", aud(m.gstPayable), "kpi-tone-4"],
    ["Income Tax Payable", aud(m.uberTaxPayable), "kpi-tone-5"],
    ["In Hand", aud(m.inHand), "kpi-tone-2"],
    ["Expenses", aud(m.expenseTotal), "kpi-tone-3"]
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
      <div class="hero-chip"><span>Tolls Tracked</span><strong>${aud(m.tollTotal)}</strong></div>
    </div>
  `;
}

function renderLogbookSummary() {
  const m = computeMetrics();
  if (!el("logbookSummary")) return;
  el("logbookSummary").innerHTML = `
    <div class="hero-metrics">
      <div class="hero-chip"><span>Total KM</span><strong>${f2(m.totalKm)}</strong></div>
      <div class="hero-chip"><span>Uber Trip KM</span><strong>${f2(m.businessKm)}</strong></div>
      <div class="hero-chip"><span>Business Use</span><strong>${pct(m.businessUsePct)}</strong></div>
      <div class="hero-chip"><span>Trips Logged</span><strong>${db.trips.length}</strong></div>
    </div>
  `;
}

function computeMetrics(overrides = {}) {
  const fareGross = sum(db.fares, "gross");
  const fareGst = db.fares.reduce((a, x) => a + gstFromFare(x), 0);
  const tipExtra = db.fares.reduce((a, x) => a + n(x.tip_extra), 0);
  const platformFees = db.fares.reduce((a, x) => a + n(x.platform_fee), 0);
  const platformFeeGst = db.fares.reduce((a, x) => a + n(x.platform_fee_gst), 0);
  const netPayout = db.fares.reduce((a, x) => a + netPayoutForFare(x), 0);
  const totalKm = sum(db.trips, "km");
  const businessKm = db.trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  const businessUsePct = totalKm > 0 ? businessKm / totalKm : 0;
  const expenseTotal = sum(db.expenses, "amount");
  const expenseGstCredit = db.expenses.reduce((a, x) => a + expenseGstCreditValue(x, businessUsePct), 0) + platformFeeGst;
  const tollTotal = sum(db.tolls, "amount");
  const reimbursedTolls = db.tolls.reduce((a, x) => a + (x.reimbursed ? x.amount : 0), 0);

  const deductibleExpenses = expenseTotal * businessUsePct + platformFees;

  const otherIncome = n(overrides.other_income ?? db.tax?.other_income ?? 0);
  const superContrib = n(overrides.super_contribution ?? db.tax?.super_contribution ?? 0);
  const rideshareTaxableIncome = Math.max(0, fareGross + tipExtra - deductibleExpenses - superContrib);
  const taxableIncome = Math.max(0, rideshareTaxableIncome + otherIncome);
  const taxBreakdown = computeTaxBreakdown(rideshareTaxableIncome, otherIncome);
  const incomeTax = taxBreakdown.incomeTax;
  const medicare = taxBreakdown.medicare;
  const totalTax = taxBreakdown.totalTax;
  const uberTaxPayable = taxBreakdown.uberTaxPayable;
  const otherIncomeTaxPaid = taxBreakdown.otherIncomeTaxPaid;
  const slab = taxSlabForIncome(taxableIncome);

  const gstPayable = Math.max(0, fareGst - expenseGstCredit);
  const inHand = fareGross + tipExtra - expenseTotal - platformFees - uberTaxPayable - gstPayable;

  const monthsActive = Math.max(1, distinctMonths([...db.fares, ...db.expenses, ...db.tolls].map((x) => x.date)).size);
  const monthlyAvgNet = inHand / monthsActive;
  const effectiveTaxRate = taxableIncome > 0 ? totalTax / taxableIncome : 0;
  const recommendedReserve = taxableIncome * effectiveTaxRate;

  return {
    fareGross,
    fareGst,
    tipExtra,
    expenseTotal,
    expenseGstCredit,
    tollTotal,
    reimbursedTolls,
    totalKm,
    businessKm,
    businessUsePct,
    rideshareTaxableIncome,
    taxableIncome,
    incomeTax,
    medicare,
    totalTax,
    uberTaxPayable,
    otherIncomeTaxPaid,
    gstPayable,
    inHand,
    netPayout,
    monthlyAvgNet,
    recommendedReserve,
    effectiveTaxRate,
    platformFees,
    marginalRate: slab.rate,
    slabLabel: slab.label
  };
}

function renderReport(forceType = null) {
  const period = el("summaryPeriod").value;
  const year = Number(el("summaryYear").value || new Date().getFullYear());
  const type = forceType || "combined";
  const buckets = bucketizeByPeriod(period, year);

  let html = `<h3>ATO Summary Report</h3><div class="meta">Period: ${cap(period)} | Year: ${year} | Generated: ${new Date().toLocaleString("en-AU")}</div>`;
  html += `<table><tr><th>Period</th><th>Fare</th><th>Expenses</th><th>GST Collected</th><th>GST Credits</th><th>GST Payable</th><th>Taxable Income</th><th>Income Tax Payable</th><th>PAYG Paid</th><th>In-Hand</th></tr>`;

  buckets.forEach((b) => {
    const m = computeForRange(b.from, b.to);
    html += `<tr><td>${b.label}</td><td>${aud(m.fareGross)}</td><td>${aud(m.expenseTotal)}</td><td>${aud(m.fareGst)}</td><td>${aud(m.expenseGstCredit)}</td><td>${aud(m.gstPayable)}</td><td>${aud(m.taxableIncome)}</td><td>${aud(m.uberTaxPayable)}</td><td>${aud(m.otherIncomeTaxPaid)}</td><td>${aud(m.inHand)}</td></tr>`;
  });
  html += `</table>`;

  const all = computeMetrics();
  const basSection = `
    <h3>BAS Summary (Estimate)</h3>
    <div class="report-grid">
      ${line("G1 Total Sales", aud(all.fareGross))}
      ${line("1A GST on Sales", aud(all.fareGst))}
      ${line("1B GST on Purchases", aud(all.expenseGstCredit))}
      ${line("Net GST Payable", aud(all.gstPayable))}
    </div>
  `;

  const taxSection = `
    <h3>Tax Summary (Estimate)</h3>
    <div class="report-grid">
      ${line("Taxable Income", aud(all.taxableIncome))}
      ${line("PAYG Income Entered", aud(n(db.tax?.other_income || 0)))}
      ${line("Tip / Extra", aud(all.tipExtra))}
      ${line("Income Tax", aud(all.incomeTax))}
      ${line("Medicare Levy (2%)", aud(all.medicare))}
      ${line("Total Tax", aud(all.totalTax))}
      ${line("Income Tax Payable", aud(all.uberTaxPayable))}
      ${line("PAYG Tax Already Paid", aud(all.otherIncomeTaxPaid))}
      ${line("Current Tax Slab", esc(all.slabLabel))}
      ${line("Net In-Hand", aud(all.inHand))}
    </div>
  `;

  if (type === "bas") html = basSection;
  if (type === "tax") html = taxSection;
  if (type === "combined") html += basSection + taxSection + atoLogbookDeclaration();

  el("reportArea").innerHTML = html;
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
      Expenses: round2(metrics.expenseTotal),
      GST_Collected: round2(metrics.fareGst),
      GST_Credits: round2(metrics.expenseGstCredit),
      GST_Payable: round2(metrics.gstPayable),
      Taxable_Income: round2(metrics.taxableIncome),
      Income_Tax_Payable: round2(metrics.uberTaxPayable),
      PAYG_Tax_Paid: round2(metrics.otherIncomeTaxPaid),
      Tax_Medicare: round2(metrics.totalTax),
      In_Hand: round2(metrics.inHand)
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
    GST_On_Fare: round2(gstFromFare(row)),
    Platform_Fee: round2(row.platform_fee),
    Platform_Fee_GST: round2(row.platform_fee_gst),
    Tip_Extra: round2(row.tip_extra),
    Net_Payout: round2(netPayoutForFare(row))
  }));
  const expenses = filterByRange(db.expenses).map((row) => ({
    Date: row.date,
    Category: row.category,
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

  const allMetrics = computeMetrics();
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
    { Field: "Taxable Income", Value: round2(allMetrics.taxableIncome) },
    { Field: "Income Tax Payable", Value: round2(allMetrics.uberTaxPayable) },
    { Field: "PAYG Tax Already Paid", Value: round2(allMetrics.otherIncomeTaxPaid) },
    { Field: "Tax + Medicare", Value: round2(allMetrics.totalTax) },
    { Field: "Effective Tax %", Value: round2(allMetrics.effectiveTaxRate * 100) },
    { Field: "In Hand", Value: round2(allMetrics.inHand) }
  ];
  const basRows = [{
    G1_Total_Sales: round2(allMetrics.fareGross),
    GST_on_Sales_1A: round2(allMetrics.fareGst),
    GST_Credits_1B: round2(allMetrics.expenseGstCredit),
    Net_GST_Payable: round2(allMetrics.gstPayable)
  }];
  const taxRows = [{
    Other_Income: round2(n(db.tax?.other_income || 0)),
    Super_Contribution: round2(n(db.tax?.super_contribution || 0)),
    Rideshare_Taxable_Income: round2(allMetrics.rideshareTaxableIncome),
    Taxable_Income: round2(allMetrics.taxableIncome),
    Income_Tax: round2(allMetrics.incomeTax),
    Medicare: round2(allMetrics.medicare),
    Total_Tax: round2(allMetrics.totalTax),
    Income_Tax_Payable: round2(allMetrics.uberTaxPayable),
    PAYG_Tax_Already_Paid: round2(allMetrics.otherIncomeTaxPaid),
    Marginal_Tax_Slab: allMetrics.slabLabel,
    Effective_Tax_Pct: round2(allMetrics.effectiveTaxRate * 100),
    In_Hand: round2(allMetrics.inHand)
  }];

  const workbook = window.XLSX.utils.book_new();
  appendSheet(workbook, "Overview", overviewRows);
  appendSheet(workbook, "Period Summary", reportRows);
  appendSheet(workbook, "BAS Summary", basRows);
  appendSheet(workbook, "Tax Summary", taxRows);
  appendSheet(workbook, "Fares", fares);
  appendSheet(workbook, "Expenses", expenses);
  appendSheet(workbook, "Tolls", tolls);
  appendSheet(workbook, "Logbook", trips);

  const suffix = reportType === "bas" ? "bas-report" : reportType === "tax" ? "tax-report" : "full-report";
  window.XLSX.writeFile(workbook, `ridemint-${suffix}-${year}.xlsx`);
}

function appendSheet(workbook, name, rows) {
  const safeRows = rows.length ? rows : [{ Message: "No data for selected report period." }];
  const sheet = window.XLSX.utils.json_to_sheet(safeRows);
  window.XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function currentBusinessUsePct() {
  const totalKm = sum(db.trips, "km");
  if (totalKm <= 0) return 0;
  const businessKm = db.trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
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
  const platformFees = fares.reduce((a, x) => a + n(x.platform_fee), 0);
  const platformFeeGst = fares.reduce((a, x) => a + n(x.platform_fee_gst), 0);
  const expenseTotal = sum(expenses, "amount");
  const tollTotal = sum(tolls, "amount");
  const reimbursedTolls = tolls.reduce((a, x) => a + (x.reimbursed ? x.amount : 0), 0);

  const totalKm = sum(trips, "km");
  const businessKm = trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  const businessUsePct = totalKm > 0 ? businessKm / totalKm : 0;
  const expenseGstCredit = expenses.reduce((a, x) => a + expenseGstCreditValue(x, businessUsePct), 0) + platformFeeGst;

  const deductibleExpenses = expenseTotal * businessUsePct + platformFees;
  const otherIncomeAllocated = allocateAnnualValueToRange(n(db.tax?.other_income || 0), from, to);
  const superAllocated = allocateAnnualValueToRange(n(db.tax?.super_contribution || 0), from, to);
  const rideshareTaxableIncome = Math.max(0, fareGross + tipExtra - deductibleExpenses - superAllocated);
  const taxableIncome = Math.max(0, rideshareTaxableIncome + otherIncomeAllocated);
  const taxBreakdown = computeTaxBreakdown(rideshareTaxableIncome, otherIncomeAllocated);
  const incomeTax = taxBreakdown.incomeTax;
  const medicare = taxBreakdown.medicare;
  const totalTax = taxBreakdown.totalTax;
  const gstPayable = Math.max(0, fareGst - expenseGstCredit);
  const inHand = fareGross + tipExtra - expenseTotal - platformFees - taxBreakdown.uberTaxPayable - gstPayable;

  return {
    fareGross,
    tipExtra,
    expenseTotal,
    fareGst,
    expenseGstCredit,
    gstPayable,
    businessUsePct,
    rideshareTaxableIncome,
    taxableIncome,
    incomeTax,
    medicare,
    totalTax,
    uberTaxPayable: taxBreakdown.uberTaxPayable,
    otherIncomeTaxPaid: taxBreakdown.otherIncomeTaxPaid,
    inHand
  };
}

function bucketizeByPeriod(period, year) {
  if (period === "yearly") {
    return [{ label: `${year}`, from: `${year}-01-01`, to: `${year}-12-31` }];
  }
  if (period === "quarterly") {
    return [
      { label: `Q1 (${year})`, from: `${year}-01-01`, to: `${year}-03-31` },
      { label: `Q2 (${year})`, from: `${year}-04-01`, to: `${year}-06-30` },
      { label: `Q3 (${year})`, from: `${year}-07-01`, to: `${year}-09-30` },
      { label: `Q4 (${year})`, from: `${year}-10-01`, to: `${year}-12-31` }
    ];
  }
  return Array.from({ length: 12 }).map((_, i) => {
    const month = String(i + 1).padStart(2, "0");
    const last = new Date(year, i + 1, 0).getDate();
    return { label: `${year}-${month}`, from: `${year}-${month}-01`, to: `${year}-${month}-${String(last).padStart(2, "0")}` };
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
  document.querySelectorAll(".del").forEach((b) => {
    b.onclick = async () => {
      const table = b.dataset.table;
      const id = b.dataset.id;
      await supabase.from(table).delete().eq("id", id);
      await refreshAll();
    };
  });
  document.querySelectorAll(".edit").forEach((b) => {
    b.onclick = () => startEdit(b.dataset.table, b.dataset.id);
  });
  bindSwipeRows();
}

function tableHtml(headers, rows) {
  const h = `<tr>${headers.map((x) => `<th>${x}</th>`).join("")}</tr>`;
  const b = rows.length ? rows.map((r) => `<tr class="swipe-row">${r.map((c, i) => `<td class="${i === r.length - 1 ? "action-cell" : ""}">${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">No records.</td></tr>`;
  return h + b;
}
function delBtn(table, id) { return `<button class="del" data-table="${table}" data-id="${id}">Delete</button>`; }
function editBtn(table, id) { return `<button class="edit" data-table="${table}" data-id="${id}">Edit</button>`; }
function actionBtns(table, id) { return `<div class="actions-row">${editBtn(table, id)} ${delBtn(table, id)}</div>`; }

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
    f.date.value = r.date; f.category.value = r.category; f.amount.value = r.amount; if (f.gst_amount) f.gst_amount.value = round2(r.gst_amount || 0).toFixed(2); f.gst_claimable.value = String(!!r.gst_claimable); if (f.gst_credit) f.gst_credit.value = round2(expenseGstCreditValue(r)).toFixed(2); f.notes.value = r.notes || "";
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
    let startX = 0;
    row.ontouchstart = (e) => { startX = e.changedTouches[0].clientX; };
    row.ontouchend = (e) => {
      const endX = e.changedTouches[0].clientX;
      const dx = endX - startX;
      if (dx < -40) row.classList.add("reveal");
      if (dx > 24) row.classList.remove("reveal");
    };
  });
}
function renderTaxBreakdown() {
  const m = computeMetrics(readDraftTaxValues());
  const otherIncome = n(readDraftTaxValues().other_income);
  const html = `
    <div class="tax-panel">
      <strong>GST Position</strong>
      <div class="meta">GST collected from fares versus GST credits from expenses and platform fees.</div>
      ${line("GST on Sales (1A)", aud(m.fareGst))}
      ${line("GST Credits (1B)", aud(m.expenseGstCredit))}
      ${line("GST Total Payable", aud(m.gstPayable))}
    </div>
    <div class="tax-panel">
      <strong>Rideshare Tax Payable</strong>
      <div class="meta">Tax still payable from Uber and rideshare activity after excluding PAYG salary tax already withheld.</div>
      ${line("Rideshare Taxable Income", aud(m.rideshareTaxableIncome))}
      ${line("Income Tax Payable", aud(m.uberTaxPayable))}
      ${line("GST Payable", aud(m.gstPayable))}
    </div>
    <div class="tax-panel">
      <strong>Other Income Tax Position</strong>
      <div class="meta">This is treated as PAYG income already taxed through salary withholding.</div>
      ${line("Other Income Entered", aud(otherIncome))}
      ${line("PAYG Tax Already Paid", aud(m.otherIncomeTaxPaid))}
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
    super_contribution: n(form.super_contribution?.value)
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
  const rideshareOnlyIncomeTax = estimateTaxAu(rideshareTaxableIncome);
  const rideshareOnlyMedicare = rideshareTaxableIncome * 0.02;
  const otherIncomeTaxPaid = Math.max(0, totalTax - (rideshareOnlyIncomeTax + rideshareOnlyMedicare));
  const uberTaxPayable = Math.max(0, totalTax - (estimateTaxAu(otherIncome) + otherIncome * 0.02));
  return { incomeTax, medicare, totalTax, otherIncomeTaxPaid, uberTaxPayable };
}

function allocateAnnualValueToRange(total, from, to) {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  const yearStart = new Date(start.getFullYear(), 0, 1);
  const yearEnd = new Date(start.getFullYear(), 11, 31);
  const clippedStart = start < yearStart ? yearStart : start;
  const clippedEnd = end > yearEnd ? yearEnd : end;
  const daysInRange = Math.max(0, Math.round((clippedEnd - clippedStart) / 86400000) + 1);
  const daysInYear = Math.round((yearEnd - yearStart) / 86400000) + 1;
  return round2((n(total) * daysInRange) / daysInYear);
}

function weeklyFareSummaries() {
  const totals = computeMetrics();
  return db.fares
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
  const tables = ["trips", "fares", "expenses", "tolls", "tax_settings"];
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

function gstFromFare(x) { return x.gst_included ? n(x.gross) / 11 : n(x.gross) * 0.1; }
function netPayoutForFare(x) { return round2(n(x.net_payout || (n(x.gross) + n(x.tip_extra) - n(x.platform_fee)))); }
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

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}
})();
