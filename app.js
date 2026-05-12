(() => {
if (window.__RIDEMINT_APP_LOADED__) {
  console.warn("RideMint app.js already loaded; skipping duplicate init.");
  return;
}
window.__RIDEMINT_APP_LOADED__ = true;

const APP_KEY = "ridemint-pro-config";
const today = new Date().toISOString().slice(0, 10);

let supabase = null;
let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let db = { trips: [], fares: [], expenses: [], tolls: [], tax: null, platforms: [] };

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
  if (el("buildTag")) el("buildTag").textContent = "Build: RM-2026-05-11e (JS active)";
  setStatus("configStatus", "App ready. Enter Supabase details and click Save Connection.");
  ["tripForm", "fareForm", "expenseForm", "tollForm"].forEach((id) => {
    const f = el(id);
    if (f?.date) f.date.value = today;
  });
  if (el("summaryYear")) el("summaryYear").value = new Date().getFullYear();
  wireEvents();
  setupTabs();
  showAuthPage("login");
  loadConfigUI();
  syncConnectionInputs();
}

function wireEvents() {
  bindClick("saveConfigBtn", saveConfig);
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
  bindClick("printBasBtn", () => renderReport("bas"));
  bindClick("printTaxBtn", () => renderReport("tax"));
  bindClick("printReportBtn", () => window.print());
  bindClick("printReportBtn2", () => window.print());
  bindClick("exportLogbookCsvBtn", exportLogbookCsv);
  bindClick("saveAdminRoleBtn", updateUserRole);
  bindClick("refreshAdminsBtn", loadAdminUsers);
  bindClick("addPlatformBtn", addPlatformOption);
  bindClick("refreshPlatformsBtn", loadPlatformOptions);
  bindFareFeeAutoCalc();
}

function bindFareFeeAutoCalc() {
  const form = el("fareForm");
  if (!form || !form.platform_fee) return;
  const recalc = () => {
    const fee = n(form.platform_fee.value);
    form.platform_fee_gst.value = (fee / 11).toFixed(2);
  };
  form.platform_fee.addEventListener("input", recalc);
  recalc();
}

function saveConfigFromAdmin() {
  if (el("sbUrlAdmin")) el("sbUrl").value = el("sbUrlAdmin").value;
  if (el("sbAnonAdmin")) el("sbAnon").value = el("sbAnonAdmin").value;
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
  const cfg = readConfig();
  updateConfigCardVisibility();
  if (!cfg?.url || !cfg?.anon) return;
  el("sbUrl").value = cfg.url;
  el("sbAnon").value = cfg.anon;
  syncConnectionInputs();
  initSupabase(cfg.url, cfg.anon);
}

function syncConnectionInputs() {
  if (el("sbUrlAdmin")) el("sbUrlAdmin").value = el("sbUrl")?.value || "";
  if (el("sbAnonAdmin")) el("sbAnonAdmin").value = el("sbAnon")?.value || "";
}

function readConfig() {
  try { return JSON.parse(localStorage.getItem(APP_KEY) || "{}"); } catch { return {}; }
}

async function saveConfig() {
  const url = el("sbUrl").value.trim();
  const anon = el("sbAnon").value.trim();
  if (!url || !anon) return setStatus("configStatus", "Enter URL and anon key.", true);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    return setStatus("configStatus", "URL format should be https://<project-ref>.supabase.co", true);
  }
  if (!window.supabase?.createClient) {
    return setStatus("configStatus", "Supabase library failed to load. Check internet and reload.", true);
  }
  const btn = el("saveConfigBtn");
  btn.disabled = true;
  setStatus("configStatus", "Testing connection...");
  localStorage.setItem(APP_KEY, JSON.stringify({ url, anon }));
  syncConnectionInputs();
  updateConfigCardVisibility();
  const ok = await initSupabase(url, anon);
  btn.disabled = false;
  if (!ok) return;
  setStatus("configStatus", "Connection saved and verified. You can now sign up/sign in.");
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
    setStatus("configStatus", `Connection failed: ${msg}`, true);
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
  db = { trips: [], fares: [], expenses: [], tolls: [], tax: null };
  toggleApp();
  renderAll();
}

function toggleApp() {
  el("appRoot").classList.toggle("hidden", !currentUser);
  el("logoutBtn").classList.toggle("hidden", !currentUser);
  el("printReportBtn").classList.toggle("hidden", !currentUser);
  el("authPages").classList.toggle("hidden", !!currentUser);
  updateConfigCardVisibility();
  applyAdminVisibility();
}

function updateConfigCardVisibility() {
  const cfg = readConfig();
  const hasCfg = !!(cfg?.url && cfg?.anon);
  el("configCard").classList.toggle("hidden", hasCfg || !!currentUser);
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
    updateSectionHeader(key);
  };
  document.querySelectorAll(".tab, .nav-item-lite").forEach((t) => {
    t.addEventListener("click", () => activate(t.dataset.tab));
  });
  activate("dashboard");
}

function updateSectionHeader(key) {
  const map = {
    dashboard: ["Dashboard", "Business snapshot and performance metrics."],
    logbook: ["Logbook", "ATO-compatible trip and odometer record."],
    income: ["Income", "Fares, platform fees, and GST tracking."],
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
  const m = computeMetrics();
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

async function onAddTrip(e) {
  e.preventDefault();
  const f = e.target;
  const odo_start = n(f.odo_start.value), odo_end = n(f.odo_end.value);
  if (odo_end <= odo_start) return alert("End odometer must be greater than start.");
  await supabase.from("trips").insert({
    user_id: currentUser.id,
    date: f.date.value,
    purpose: f.purpose.value,
    odo_start,
    odo_end,
    km: +(odo_end - odo_start).toFixed(2),
    from_location: f.from_location.value,
    to_location: f.to_location.value,
    notes: f.notes.value
  });
  f.reset(); f.date.value = today;
  prefillTripStartOdo();
  await refreshAll();
}

async function onAddFare(e) {
  e.preventDefault();
  const f = e.target;
  await supabase.from("fares").insert({
    user_id: currentUser.id,
    date: f.date.value,
    platform: f.platform.value,
    gross: n(f.gross.value),
    gst_included: f.gst_included.value === "true",
    platform_fee: n(f.platform_fee.value),
    platform_fee_gst: +(n(f.platform_fee.value) / 11).toFixed(2)
  });
  f.reset(); f.date.value = today;
  if (f.platform.options.length) f.platform.value = f.platform.options[0].value;
  f.platform_fee.value = 0;
  f.platform_fee_gst.value = "0.00";
  await refreshAll();
}

async function onAddExpense(e) {
  e.preventDefault();
  const f = e.target;
  await supabase.from("expenses").insert({
    user_id: currentUser.id,
    date: f.date.value,
    category: f.category.value,
    amount: n(f.amount.value),
    gst_claimable: f.gst_claimable.value === "true",
    notes: f.notes.value
  });
  f.reset(); f.date.value = today;
  await refreshAll();
}

async function onAddToll(e) {
  e.preventDefault();
  const f = e.target;
  await supabase.from("tolls").insert({
    user_id: currentUser.id,
    date: f.date.value,
    amount: n(f.amount.value),
    reimbursed: f.reimbursed.value === "true"
  });
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
  renderTripTable(); renderFareTable(); renderExpenseTable(); renderTollTable(); renderKpis(); renderReport();
  updateAutoTaxPct();
}

function renderTripTable() {
  el("tripTable").innerHTML = tableHtml(
    ["Date", "Purpose", "KM", "From", "To", "", ""],
    db.trips.map((x) => [x.date, x.purpose, f2(x.km), esc(x.from_location), esc(x.to_location), esc(x.notes || ""), delBtn("trips", x.id)])
  );
  bindDelete();
}
function renderFareTable() {
  el("fareTable").innerHTML = tableHtml(
    ["Date", "Platform", "Gross", "Platform Fee", "Fee GST", "GST", ""],
    db.fares.map((x) => [x.date, esc(x.platform), aud(x.gross), aud(x.platform_fee || 0), aud(x.platform_fee_gst || 0), aud(gstFromFare(x)), delBtn("fares", x.id)])
  );
  bindDelete();
}
function renderExpenseTable() {
  el("expenseTable").innerHTML = tableHtml(
    ["Date", "Category", "Amount", "GST Credit", ""],
    db.expenses.map((x) => [x.date, esc(x.category), aud(x.amount), aud(x.gst_claimable ? x.amount / 11 : 0), delBtn("expenses", x.id)])
  );
  bindDelete();
}
function renderTollTable() {
  el("tollTable").innerHTML = tableHtml(
    ["Date", "Amount", "Reimbursed", ""],
    db.tolls.map((x) => [x.date, aud(x.amount), x.reimbursed ? "Yes" : "No", delBtn("tolls", x.id)])
  );
  bindDelete();
}

function renderKpis() {
  const m = computeMetrics();
  const cards = [
    ["Gross Fare Income", aud(m.fareGross)],
    ["Platform Fees", aud(m.platformFees || 0)],
    ["Total Expenses", aud(m.expenseTotal)],
    ["GST Payable Estimate", aud(m.gstPayable)],
    ["Business Use", pct(m.businessUsePct)],
    ["Effective Tax %", pct(m.effectiveTaxRate)],
    ["Income Tax + Medicare", aud(m.totalTax)],
    ["In-Hand After Tax/Expense", aud(m.inHand)],
    ["Monthly Avg Net", aud(m.monthlyAvgNet)],
    ["Tax Reserve Recommended", aud(m.recommendedReserve)]
  ];
  el("kpiGrid").innerHTML = cards.map(([k, v]) => `<article class="kpi"><div class="key">${k}</div><div class="val">${v}</div></article>`).join("");
}

function computeMetrics() {
  const fareGross = sum(db.fares, "gross");
  const fareGst = db.fares.reduce((a, x) => a + gstFromFare(x), 0);
  const platformFees = db.fares.reduce((a, x) => a + n(x.platform_fee), 0);
  const platformFeeGst = db.fares.reduce((a, x) => a + n(x.platform_fee_gst), 0);
  const expenseTotal = sum(db.expenses, "amount");
  const expenseGstCredit = db.expenses.reduce((a, x) => a + (x.gst_claimable ? x.amount / 11 : 0), 0) + platformFeeGst;
  const tollTotal = sum(db.tolls, "amount");
  const reimbursedTolls = db.tolls.reduce((a, x) => a + (x.reimbursed ? x.amount : 0), 0);

  const totalKm = sum(db.trips, "km");
  const businessKm = db.trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  const businessUsePct = totalKm > 0 ? businessKm / totalKm : 0;

  const deductibleExpenses = (expenseTotal + platformFees) * businessUsePct;
  const deductibleTolls = (tollTotal - reimbursedTolls) * businessUsePct;

  const otherIncome = n(db.tax?.other_income || 0);
  const superContrib = n(db.tax?.super_contribution || 0);
  const taxableIncome = Math.max(0, fareGross - deductibleExpenses - deductibleTolls + otherIncome - superContrib);
  const incomeTax = estimateTaxAu(taxableIncome);
  const medicare = taxableIncome * 0.02;
  const totalTax = incomeTax + medicare;

  const gstPayable = Math.max(0, fareGst - expenseGstCredit);
  const inHand = fareGross - expenseTotal - platformFees - (tollTotal - reimbursedTolls) - totalTax - gstPayable;

  const monthsActive = Math.max(1, distinctMonths([...db.fares, ...db.expenses, ...db.tolls].map((x) => x.date)).size);
  const monthlyAvgNet = inHand / monthsActive;
  const effectiveTaxRate = taxableIncome > 0 ? totalTax / taxableIncome : 0;
  const recommendedReserve = taxableIncome * effectiveTaxRate;

  return { fareGross, fareGst, expenseTotal, expenseGstCredit, tollTotal, reimbursedTolls, businessUsePct, taxableIncome, incomeTax, medicare, totalTax, gstPayable, inHand, monthlyAvgNet, recommendedReserve, effectiveTaxRate, platformFees };
}

function renderReport(forceType = null) {
  const period = el("summaryPeriod").value;
  const year = Number(el("summaryYear").value || new Date().getFullYear());
  const type = forceType || "combined";
  const buckets = bucketizeByPeriod(period, year);

  let html = `<h3>ATO Summary Report</h3><div class="meta">Period: ${cap(period)} | Year: ${year} | Generated: ${new Date().toLocaleString("en-AU")}</div>`;
  html += `<table><tr><th>Period</th><th>Fare</th><th>Expenses</th><th>GST Collected</th><th>GST Credits</th><th>GST Payable</th><th>Taxable Income</th><th>Tax+Medicare</th><th>In-Hand</th></tr>`;

  buckets.forEach((b) => {
    const m = computeForRange(b.from, b.to);
    html += `<tr><td>${b.label}</td><td>${aud(m.fareGross)}</td><td>${aud(m.expenseTotal)}</td><td>${aud(m.fareGst)}</td><td>${aud(m.expenseGstCredit)}</td><td>${aud(m.gstPayable)}</td><td>${aud(m.taxableIncome)}</td><td>${aud(m.totalTax)}</td><td>${aud(m.inHand)}</td></tr>`;
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
      ${line("Income Tax", aud(all.incomeTax))}
      ${line("Medicare Levy (2%)", aud(all.medicare))}
      ${line("Total Tax", aud(all.totalTax))}
      ${line("Net In-Hand", aud(all.inHand))}
    </div>
  `;

  if (type === "bas") html = basSection;
  if (type === "tax") html = taxSection;
  if (type === "combined") html += basSection + taxSection + atoLogbookDeclaration();

  el("reportArea").innerHTML = html;
  if (forceType) window.print();
}

function computeForRange(from, to) {
  const inRange = (d) => d >= from && d <= to;
  const fares = db.fares.filter((x) => inRange(x.date));
  const expenses = db.expenses.filter((x) => inRange(x.date));
  const tolls = db.tolls.filter((x) => inRange(x.date));
  const trips = db.trips.filter((x) => inRange(x.date));

  const fareGross = sum(fares, "gross");
  const fareGst = fares.reduce((a, x) => a + gstFromFare(x), 0);
  const platformFees = fares.reduce((a, x) => a + n(x.platform_fee), 0);
  const platformFeeGst = fares.reduce((a, x) => a + n(x.platform_fee_gst), 0);
  const expenseTotal = sum(expenses, "amount");
  const expenseGstCredit = expenses.reduce((a, x) => a + (x.gst_claimable ? x.amount / 11 : 0), 0) + platformFeeGst;
  const tollTotal = sum(tolls, "amount");
  const reimbursedTolls = tolls.reduce((a, x) => a + (x.reimbursed ? x.amount : 0), 0);

  const totalKm = sum(trips, "km");
  const businessKm = trips.reduce((a, x) => a + (x.purpose === "Business" ? Number(x.km) : 0), 0);
  const businessUsePct = totalKm > 0 ? businessKm / totalKm : 0;

  const deductibleExpenses = (expenseTotal + platformFees) * businessUsePct;
  const deductibleTolls = (tollTotal - reimbursedTolls) * businessUsePct;
  const taxableIncome = Math.max(0, fareGross - deductibleExpenses - deductibleTolls + n(db.tax?.other_income || 0) - n(db.tax?.super_contribution || 0));
  const incomeTax = estimateTaxAu(taxableIncome);
  const medicare = taxableIncome * 0.02;
  const totalTax = incomeTax + medicare;
  const gstPayable = Math.max(0, fareGst - expenseGstCredit);
  const inHand = fareGross - expenseTotal - platformFees - (tollTotal - reimbursedTolls) - totalTax - gstPayable;

  return { fareGross, expenseTotal, fareGst, expenseGstCredit, gstPayable, taxableIncome, totalTax, inHand };
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

function bindDelete() {
  document.querySelectorAll(".del").forEach((b) => {
    b.onclick = async () => {
      const table = b.dataset.table;
      const id = b.dataset.id;
      await supabase.from(table).delete().eq("id", id);
      await refreshAll();
    };
  });
}

function tableHtml(headers, rows) {
  const h = `<tr>${headers.map((x) => `<th>${x}</th>`).join("")}</tr>`;
  const b = rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">No records.</td></tr>`;
  return h + b;
}
function delBtn(table, id) { return `<button class="del" data-table="${table}" data-id="${id}">Delete</button>`; }
function gstFromFare(x) { return x.gst_included ? n(x.gross) / 11 : n(x.gross) * 0.1; }
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
function sum(arr, k) { return arr.reduce((a, x) => a + n(x[k]), 0); }
function f2(v) { return n(v).toFixed(2); }
function aud(v) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n(v)); }
function pct(v) { return `${(n(v) * 100).toFixed(1)}%`; }
function esc(s) { return String(s ?? "").replace(/[&<>\"]/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m])); }
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
function line(k, v) { return `<div class="report-line"><span>${k}</span><strong>${v}</strong></div>`; }
function csvCell(v) { const s = String(v).replace(/"/g, '""'); return `"${s}"`; }
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
})();
