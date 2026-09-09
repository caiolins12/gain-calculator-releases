(() => {
  "use strict";

  const SUPABASE_URL = "https://wckwpfaagvzppuzlnwbx.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indja3dwZmFhZ3Z6cHB1emxud2J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDE5NjcsImV4cCI6MjA5MjM3Nzk2N30.M-fcU5zIsr6PwBRqJZv3v0MQdHBCCpC_zm7g0tB8U_k";
  const SESSION_KEY = "gain_admin_session_v2";
  const ONLINE_WINDOW_MS = 5 * 60 * 1000;
  const DAY_MS = 86_400_000;

  const PAGES = {
    overview: { eyebrow: "Visão", title: "Visão geral", description: "Prioridades, atividade e saúde da operação em um só lugar." },
    users: { eyebrow: "Operação", title: "Usuários", description: "Contas, licenças, dispositivos e uso do monitoramento." },
    diagnostics: { eyebrow: "Operação", title: "Diagnósticos", description: "Fila de incompatibilidades, ocorrências e logs enviados pelo app." },
    traces: { eyebrow: "Operação", title: "Rastros de teste", description: "Linha do tempo operacional dos participantes do programa de testes." },
    analytics: { eyebrow: "Produto", title: "Uso e adoção", description: "Alcance, estados das solicitações e comportamento dentro do produto." },
    versions: { eyebrow: "Produto", title: "Versões", description: "Release publicada, adoção instalada e contas que precisam atualizar." },
    services: { eyebrow: "Serviços", title: "Status dos serviços", description: "Disponibilidade e latência das dependências críticas do app." },
    whatsapp: { eyebrow: "Serviços", title: "WhatsApp", description: "Conexão da Evolution API e desempenho das verificações de telefone." },
    broadcast: { eyebrow: "Serviços", title: "Comunicados", description: "Envio controlado de mensagens para números verificados ou uma lista manual." }
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    auth: $("auth-view"), app: $("app-view"), page: $("page-content"),
    sidebar: $("sidebar"), backdrop: $("sidebar-backdrop"),
    detail: $("detail-dialog"), detailContent: $("detail-content"),
    confirm: $("confirm-dialog"), toast: $("toast-region")
  };

  const state = {
    session: null,
    page: "overview",
    devices: null,
    accounts: [],
    statistics: null,
    diagnostics: null,
    health: null,
    whatsapp: null,
    verification: null,
    traces: null,
    versions: null,
    now: Date.now(),
    serverNow: null,
    lastUpdated: null,
    loading: {},
    errors: {},
    sequence: {},
    userFilter: { search: "", scope: "real", license: "all", activity: "all", verification: "all", sort: "recent" },
    diagnosticFilter: { search: "", status: "all", manufacturer: "all", version: "all" },
    traceFilter: "",
    detail: null,
    detailTab: "summary",
    detailData: new Map(),
    broadcast: { mode: "base", manual: "", message: "", search: "", segment: "all", includeInternal: false, selected: null, lists: [], media: null, uploading: false, sentMessage: "", sentMedia: null, sentAt: 0, recipients: null, sending: false, sent: 0, total: 0, results: [] },
    timers: { clock: null, health: null, whatsapp: null }
  };

  let refreshPromise = null;

  /* Utilidades ----------------------------------------------------------- */
  function icon(name, className = "icon") {
    return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function safeJson(value, fallback = {}) {
    if (value && typeof value === "object") return value;
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function pct(value, total) { return total > 0 ? Math.round(asNumber(value) * 100 / asNumber(total)) : 0; }
  function count(value) { return asNumber(value).toLocaleString("pt-BR"); }
  function money(value) { return asNumber(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  function duration(ms, compact = false) {
    const total = Math.max(0, asNumber(ms));
    if (!total) return "—";
    const minutes = Math.floor(total / 60_000);
    const hours = Math.floor(minutes / 60);
    if (compact) return hours >= 1 ? `${hours}h ${minutes % 60}min` : `${minutes}min`;
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    return hours >= 1 ? `${hours}h ${minutes % 60}min` : `${minutes}min`;
  }

  function bytes(value) {
    const size = Math.max(0, asNumber(value));
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
    return `${(size / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }

  function dateTime(ms) {
    return asNumber(ms) > 0 ? new Date(asNumber(ms)).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
  }

  function dateOnly(ms) {
    return asNumber(ms) > 0 ? new Date(asNumber(ms)).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  }

  function relative(ms, now = state.serverNow || state.now) {
    if (!asNumber(ms)) return "Nunca";
    const seconds = Math.max(0, Math.floor((now - asNumber(ms)) / 1000));
    if (seconds < 45) return "Agora";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Há ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `Há ${days} d`;
    const months = Math.floor(days / 30);
    if (months < 12) return `Há ${months} ${months === 1 ? "mês" : "meses"}`;
    const years = Math.floor(months / 12);
    return `Há ${years} ${years === 1 ? "ano" : "anos"}`;
  }

  function initials(name, email) {
    const source = String(name || email || "A").trim();
    const words = source.split(/[\s@._-]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2)).toUpperCase();
  }

  function isOnline(lastSeen) {
    return asNumber(lastSeen) > 0 && (state.serverNow || state.now) - asNumber(lastSeen) < ONLINE_WINDOW_MS;
  }

  function copyText(text, label = "Conteúdo copiado") {
    navigator.clipboard?.writeText(String(text ?? "")).then(
      () => toast(label, "success"),
      () => toast("Não foi possível copiar.", "error")
    );
  }

  function downloadText(filename, text) {
    const blob = new Blob([String(text ?? "")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toast(message, type = "success", detail = "") {
    const node = document.createElement("div");
    node.className = `toast${type === "error" ? " is-error" : ""}`;
    node.innerHTML = `<span class="toast-icon">${icon(type === "error" ? "alert" : "check")}</span>
      <span class="toast-copy"><strong>${esc(message)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</span>`;
    els.toast.append(node);
    setTimeout(() => node.remove(), 4800);
  }

  function loadingState(label = "Carregando dados…") {
    return `<div class="loading-state"><div class="state-inner"><span class="state-icon">${icon("loader", "icon spin")}</span><p class="section-copy">${esc(label)}</p></div></div>`;
  }

  function emptyState(title, copy, iconName = "search", action = "") {
    return `<div class="empty-state"><div class="state-inner"><span class="state-icon">${icon(iconName)}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p>${action}</div></div>`;
  }

  function errorState(message, resource = "") {
    return `<div class="error-state"><div class="state-inner"><span class="state-icon">${icon("alert")}</span><h3>Não foi possível carregar</h3><p>${esc(message || "Tente novamente em instantes.")}</p><button class="button button--secondary" data-retry="${esc(resource)}">Tentar novamente</button></div></div>`;
  }

  function pageHeading(title, copy, actions = "") {
    return `<div class="page-heading"><div class="page-heading-copy"><h2>${esc(title)}</h2><p>${esc(copy)}</p></div>${actions ? `<div class="page-heading-actions">${actions}</div>` : ""}</div>`;
  }

  function metricCard(label, value, foot, tone = "blue", iconName = "activity") {
    return `<article class="metric-card metric-${tone}"><div class="metric-head"><span class="metric-label">${esc(label)}</span><span class="metric-icon">${icon(iconName)}</span></div><div class="metric-value">${esc(value)}</div><div class="metric-foot">${foot}</div></article>`;
  }

  function pill(label, tone = "neutral") {
    return `<span class="status-pill pill-${tone}">${esc(label)}</span>`;
  }

  function bar(label, value, maximum, color = "var(--green)", suffix = "", displayValue = null) {
    const width = maximum > 0 ? clamp(asNumber(value) * 100 / maximum, 0, 100) : 0;
    return `<div class="bar-row"><div class="bar-row-head"><span class="bar-label">${esc(label)}</span><span class="bar-value">${esc(displayValue ?? count(value))}${suffix ? `<small>${esc(suffix)}</small>` : ""}</span></div><div class="bar-track"><div class="bar-fill" style="width:${width}%;--bar-color:${color}"></div></div></div>`;
  }

  /* Autenticação e transporte ------------------------------------------- */
  function storeSession(session) {
    state.session = session;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function readSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      return session?.accessToken ? session : null;
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  function clearSession() {
    state.session = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  function sessionFromHash() {
    if (!location.hash.includes("access_token=") && !location.hash.includes("error=")) return null;
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get("access_token");
    const error = params.get("error_description") || params.get("error");
    history.replaceState(null, "", location.pathname + location.search);
    if (error) throw new Error(error);
    if (!accessToken) return null;
    const expiresIn = asNumber(params.get("expires_in"), 3600);
    return {
      accessToken,
      refreshToken: params.get("refresh_token") || null,
      expiresAt: Date.now() + expiresIn * 1000,
      email: ""
    };
  }

  async function refreshSession() {
    if (!state.session?.refreshToken) throw new Error("Sua sessão expirou. Entre novamente.");
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: state.session.refreshToken })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.access_token) throw new Error("Sua sessão expirou. Entre novamente.");
      storeSession({
        ...state.session,
        accessToken: json.access_token,
        refreshToken: json.refresh_token || state.session.refreshToken,
        expiresAt: (json.expires_at ? json.expires_at * 1000 : Date.now() + asNumber(json.expires_in, 3600) * 1000),
        email: json.user?.email || state.session.email
      });
      return state.session.accessToken;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function requestJson(url, options = {}, canRetry = true) {
    if (!state.session?.accessToken) throw new Error("Sessão administrativa ausente.");
    if (state.session.expiresAt && state.session.expiresAt - Date.now() < 30_000 && state.session.refreshToken) {
      await refreshSession();
    }
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${state.session.accessToken}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 && canRetry && state.session.refreshToken) {
      await refreshSession();
      return requestJson(url, options, false);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.message || json.error_description || json.msg || `Falha no servidor (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async function rpc(name, body = {}) {
    return requestJson(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  }

  async function edge(action, body = {}) {
    return requestJson(`${SUPABASE_URL}/functions/v1/evolution-whatsapp`, {
      method: "POST", body: JSON.stringify({ action, ...body })
    });
  }

  async function userForToken() {
    return requestJson(`${SUPABASE_URL}/auth/v1/user`, { method: "GET" });
  }

  async function passwordLogin(email, password) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) throw new Error(json.error_description || json.msg || "E-mail ou senha incorretos.");
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || null,
      expiresAt: json.expires_at ? json.expires_at * 1000 : Date.now() + asNumber(json.expires_in, 3600) * 1000,
      email: json.user?.email || email
    };
  }

  async function validateAndEnter(session) {
    storeSession(session);
    const admin = await rpc("me_is_admin", {});
    if (!admin?.is_admin) {
      clearSession();
      throw new Error("Esta conta não tem permissão de administração.");
    }
    if (!state.session.email) {
      const user = await userForToken();
      storeSession({ ...state.session, email: user.email || "Administrador" });
    }
    showApp();
    await loadCore();
  }

  function showAuthError(error) {
    const message = $("auth-message");
    message.textContent = error?.message || String(error);
    message.hidden = false;
  }

  function logout(expired = false) {
    stopPageTimers();
    clearSession();
    els.app.hidden = true;
    els.auth.hidden = false;
    if (expired) showAuthError(new Error("Sua sessão expirou. Entre novamente para continuar."));
    else location.reload();
  }

  /* Modelagem da base ---------------------------------------------------- */
  function accountLicenseFields(row) {
    const linked = Boolean(row.user_id);
    return {
      expiry: linked ? (row.user_expiry_ms ?? null) : (row.expiry_ms ?? null),
      lifetime: linked ? row.user_is_lifetime === true : row.is_lifetime === true
    };
  }

  function licenseState(expiry, lifetime) {
    const now = state.serverNow || state.now;
    if (lifetime) return { key: "lifetime", label: "Vitalícia", tone: "blue", days: null };
    if (!asNumber(expiry)) return { key: "none", label: "Sem licença", tone: "neutral", days: null };
    const days = Math.floor((asNumber(expiry) - now) / DAY_MS);
    if (days < 0) return { key: "expired", label: "Expirada", tone: "red", days };
    if (days <= 7) return { key: "expiring", label: `${days} d restantes`, tone: "yellow", days };
    return { key: "active", label: `${days} d restantes`, tone: "green", days };
  }

  function buildAccounts(rows) {
    const grouped = new Map();
    (rows || []).forEach((row, index) => {
      const key = row.user_id ? `user:${row.user_id}` : `orphan:${row.device_hash || index}`;
      const license = accountLicenseFields(row);
      let account = grouped.get(key);
      if (!account) {
        account = {
          key,
          userId: row.user_id || null,
          email: row.user_email || null,
          name: row.user_name || null,
          phone: row.user_phone || null,
          phoneConfirmed: row.user_phone_confirmed === true,
          isTester: row.is_tester === true,
          testerCheckins: asNumber(row.tester_checkin_count),
          testerCompleted: row.tester_completed === true,
          isInternal: row.is_internal === true,
          isOrphan: !row.user_id,
          createdAt: asNumber(row.created_at_ms),
          linkedAt: asNumber(row.user_linked_at_ms),
          lastSeen: asNumber(row.last_seen_ms),
          expiry: license.expiry,
          lifetime: license.lifetime,
          totalUsage: 0,
          segments: 0,
          devices: [],
          rows: []
        };
        grouped.set(key, account);
      }
      account.rows.push(row);
      account.lastSeen = Math.max(account.lastSeen, asNumber(row.last_seen_ms));
      account.totalUsage += asNumber(row.total_usage_ms);
      account.segments += asNumber(row.session_count);
      if (row.device_hash) {
        account.devices.push({
          hash: row.device_hash,
          name: row.device_name || "Dispositivo desconhecido",
          createdAt: asNumber(row.created_at_ms),
          linkedAt: asNumber(row.user_linked_at_ms),
          lastSeen: asNumber(row.last_seen_ms),
          totalUsage: asNumber(row.total_usage_ms),
          segments: asNumber(row.session_count)
        });
      }
    });
    return [...grouped.values()];
  }

  /* Três estados possíveis, e a diferença importa: quem confirmou o número,
     quem cadastrou e não confirmou, e quem nunca informou telefone. */
  function verificationState(account) {
    if (!account.phone) return "none";
    return account.phoneConfirmed ? "verified" : "pending";
  }

  function realAccounts() { return state.accounts.filter((a) => a.userId && !a.isInternal); }
  function uniqueDevices(accounts = realAccounts()) { return new Set(accounts.flatMap((a) => a.devices.map((d) => d.hash))).size; }

  function syncNavBadges() {
    const usersBadge = $("nav-users-badge");
    const diagBadge = $("nav-diagnostics-badge");
    const serviceDot = $("nav-services-status");
    const userCount = realAccounts().length;
    usersBadge.textContent = userCount > 99 ? "99+" : String(userCount);
    usersBadge.hidden = !state.devices;
    const newDiagnostics = (state.diagnostics || []).filter((d) => d.status === "new").length;
    diagBadge.textContent = newDiagnostics > 99 ? "99+" : String(newDiagnostics);
    diagBadge.hidden = newDiagnostics === 0;
    if (state.health) {
      const services = Object.values(state.health.services || {});
      const healthy = services.length > 0 && services.every((service) => service.ok && !service.zombie);
      serviceDot.hidden = false;
      serviceDot.classList.toggle("is-error", !healthy);
    } else serviceDot.hidden = true;
  }

  /* Carregamento --------------------------------------------------------- */
  async function loadResource(name, loader, apply, { quiet = false } = {}) {
    const sequence = (state.sequence[name] || 0) + 1;
    state.sequence[name] = sequence;
    state.loading[name] = true;
    delete state.errors[name];
    if (!quiet) renderCurrentPage();
    try {
      const result = await loader();
      if (state.sequence[name] !== sequence) return null;
      apply(result);
      state.lastUpdated = Date.now();
      updateLastSync();
      return result;
    } catch (error) {
      if (state.sequence[name] !== sequence) return null;
      state.errors[name] = error?.message || String(error);
      if (error?.status === 401) logout(true);
      return null;
    } finally {
      if (state.sequence[name] === sequence) {
        state.loading[name] = false;
        syncNavBadges();
        renderCurrentPage();
      }
    }
  }

  function loadDevices(options = {}) {
    return loadResource("devices", () => rpc("admin_list_devices", {}), (result) => {
      if (result.status !== "ok") throw new Error("Sem permissão para consultar as contas.");
      state.devices = result.devices || [];
      state.accounts = buildAccounts(state.devices);
      state.serverNow = asNumber(result.server_time_ms, Date.now());
    }, options);
  }

  function loadStatistics(options = {}) {
    return loadResource("statistics", () => rpc("admin_usage_statistics", {}), (result) => {
      if (result.status && result.status !== "ok") throw new Error("Sem permissão para consultar as estatísticas.");
      state.statistics = result;
    }, options);
  }

  function loadDiagnostics(options = {}) {
    return loadResource("diagnostics", () => rpc("admin_list_diagnostic_reports", { p_status: null, p_limit: 500 }), (result) => {
      if (result.status !== "ok") throw new Error("Sem permissão para consultar os diagnósticos.");
      state.diagnostics = result.reports || [];
      state.serverNow = asNumber(result.server_time_ms, state.serverNow || Date.now());
    }, options);
  }

  function loadHealth(options = {}) {
    return loadResource("health", () => edge("admin_health"), (result) => {
      if (result.status !== "ok") throw new Error(result.message || "O diagnóstico dos serviços não respondeu.");
      state.health = result;
    }, options);
  }

  async function loadCore() {
    await Promise.allSettled([
      loadDevices({ quiet: true }),
      loadStatistics({ quiet: true }),
      loadDiagnostics({ quiet: true }),
      loadHealth({ quiet: true })
    ]);
  }

  async function refreshCurrentPage() {
    const button = $("refresh-page");
    button.disabled = true;
    button.querySelector("svg")?.classList.add("spin");
    try {
      const loaders = {
        overview: () => Promise.allSettled([loadDevices({ quiet: true }), loadStatistics({ quiet: true }), loadDiagnostics({ quiet: true }), loadHealth({ quiet: true })]),
        users: () => Promise.allSettled([loadDevices({ quiet: true }), loadVersions({ quiet: true })]),
        diagnostics: () => loadDiagnostics({ quiet: true }),
        analytics: () => loadStatistics({ quiet: true }),
        versions: () => loadVersions({ quiet: true }),
        traces: () => loadTraces({ quiet: true }),
        services: () => loadHealth({ quiet: true }),
        whatsapp: () => Promise.allSettled([loadWhatsapp({ quiet: true }), loadVerification({ quiet: true })]),
        broadcast: () => Promise.allSettled([loadWhatsapp({ quiet: true }), loadRecipients({ quiet: true })])
      };
      await loaders[state.page]?.();
      toast("Dados atualizados");
    } finally {
      button.disabled = false;
      button.querySelector("svg")?.classList.remove("spin");
    }
  }

  /* Navegação ------------------------------------------------------------ */
  function pageFromHash() {
    const value = location.hash.replace(/^#\/?/, "").split("/")[0];
    return PAGES[value] ? value : "overview";
  }

  function setPage(page, { updateHistory = true } = {}) {
    if (!PAGES[page]) page = "overview";
    state.page = page;
    state.detail = null;
    stopPageTimers();
    if (updateHistory) history.replaceState(null, "", `${location.pathname}${location.search}#/${page}`);
    const meta = PAGES[page];
    $("page-eyebrow").textContent = meta.eyebrow;
    $("page-title").textContent = meta.title;
    document.title = `${meta.title} — Gain Control`;
    document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
      if (item.dataset.page === page) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    closeSidebar();
    renderCurrentPage();
    els.page.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
    activatePageData(page);
  }

  function activatePageData(page) {
    if (["users", "versions"].includes(page) && !state.versions && !state.loading.versions) loadVersions();
    if (page === "traces" && !state.traces && !state.loading.traces) loadTraces();
    if (page === "services") {
      if (!state.health && !state.loading.health) loadHealth();
      state.timers.health = setInterval(() => { if (state.page === "services") loadHealth({ quiet: true }); }, 15_000);
    }
    if (page === "whatsapp") {
      if (!state.whatsapp && !state.loading.whatsapp) loadWhatsapp();
      if (!state.verification && !state.loading.verification) loadVerification();
    }
    if (page === "broadcast") {
      state.broadcast.lists = savedLists();
      if (!state.broadcast.recipients && !state.loading.recipients) loadRecipients();
      if (!state.whatsapp && !state.loading.whatsapp) loadWhatsapp({ quiet: true });
      /* Contas dão licença, atividade e programa de testes; o resumo de versões
         é o que sustenta o segmento de app desatualizado. */
      if (!state.devices && !state.loading.devices) loadDevices({ quiet: true });
      if (!state.versions && !state.loading.versions) loadVersions({ quiet: true });
    }
  }

  function stopPageTimers() {
    clearInterval(state.timers.health); clearInterval(state.timers.whatsapp);
    state.timers.health = null; state.timers.whatsapp = null;
  }

  function openSidebar() { els.sidebar.classList.add("is-open"); els.backdrop.hidden = false; }
  function closeSidebar() { els.sidebar.classList.remove("is-open"); els.backdrop.hidden = true; }

  function updateLastSync() {
    const label = $("last-sync");
    if (!label) return;
    label.textContent = state.lastUpdated ? `Atualizado ${relative(state.lastUpdated, Date.now()).toLowerCase()}` : "Aguardando dados";
  }

  function showApp() {
    els.auth.hidden = true;
    els.app.hidden = false;
    const email = state.session.email || "Administrador";
    $("sidebar-account-email").textContent = email;
    $("sidebar-account-name").textContent = email.split("@")[0] || "Administrador";
    $("menu-account-email").textContent = email;
    $("sidebar-avatar").textContent = initials("", email);
    $("topbar-account").textContent = initials("", email);
    state.page = pageFromHash();
    setPage(state.page, { updateHistory: true });
    clearInterval(state.timers.clock);
    state.timers.clock = setInterval(() => {
      state.now = Date.now();
      if (state.serverNow) state.serverNow += 60_000;
      updateLastSync();
      if (["overview", "users"].includes(state.page)) renderCurrentPage();
    }, 60_000);
  }

  /* Visão geral ---------------------------------------------------------- */
  function renderOverview() {
    const accounts = realAccounts();
    const stats = state.statistics || {};
    const diagnostics = state.diagnostics || [];
    const online = accounts.filter((a) => isOnline(a.lastSeen)).length;
    const activeLicenses = accounts.filter((a) => ["active", "expiring", "lifetime"].includes(licenseState(a.expiry, a.lifetime).key)).length;
    const expiring = accounts.filter((a) => licenseState(a.expiry, a.lifetime).key === "expiring").length;
    const newDiagnostics = diagnostics.filter((d) => d.status === "new").length;
    const activeWeek = asNumber(stats.accounts?.active_week);
    const readWeek = asNumber(stats.funnel?.read_week);
    const finishedWeek = asNumber(stats.funnel?.finished_week);
    const conversion = pct(finishedWeek, readWeek);

    const header = pageHeading(
      "Central de operação",
      "Veja a situação da base, as prioridades abertas e os sinais mais importantes do produto.",
      `<button class="button button--secondary" data-nav="users">${icon("search")} Buscar conta</button><button class="button button--primary" data-nav="broadcast">${icon("send")} Novo comunicado</button>`
    );

    if (!state.devices && state.loading.devices) return header + `<div class="metric-grid">${Array(4).fill('<article class="metric-card skeleton"></article>').join("")}</div>${loadingState()}`;
    if (state.errors.devices && !state.devices) return header + errorState(state.errors.devices, "devices");

    const metrics = `<section class="metric-grid">
      ${metricCard("Base real", count(accounts.length), `<strong>${count(activeWeek)}</strong> com corridas em 7 dias`, "blue", "users")}
      ${metricCard("Online agora", count(online), `<strong>${count(uniqueDevices())}</strong> aparelhos vinculados`, "green", "activity")}
      ${metricCard("Licenças ativas", count(activeLicenses), expiring ? `<strong>${count(expiring)}</strong> vencem em até 7 dias` : "Nenhuma vence em 7 dias", expiring ? "yellow" : "green", "key")}
      ${metricCard("Diagnósticos novos", count(newDiagnostics), diagnostics.length ? `${count(diagnostics.length)} relatórios carregados` : "Sem relatos recentes", newDiagnostics ? "red" : "purple", "bug")}
    </section>`;

    return header + metrics + `<section class="dashboard-grid">
      ${renderOverviewProduct(readWeek, finishedWeek, conversion, stats)}
      ${renderAttention(accounts, diagnostics)}
    </section>
    <section class="dashboard-grid dashboard-grid--equal">
      ${renderRecentDiagnostics(diagnostics)}
      ${renderRecentAccounts(accounts)}
    </section>
    <section class="content-grid content-grid--wide-left">
      ${renderServiceSummary()}
      ${renderQuickActions()}
    </section>`;
  }

  function renderOverviewProduct(readWeek, finishedWeek, conversion, stats) {
    const f = stats.funnel || {};
    const verdict = readWeek < 20
      ? "O volume dos últimos 7 dias ainda é pequeno para concluir uma tendência."
      : asNumber(f.missed) > asNumber(f.finished)
        ? "Solicitações perdidas superam as finalizadas no acumulado e merecem investigação."
        : "O monitoramento registra mais finalizações do que perdas no acumulado.";
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Pulso do produto</h3><p class="section-copy">Solicitações registradas nos últimos 7 dias</p></div><button class="text-button" data-nav="analytics">Analisar tudo ${icon("arrow-right")}</button></div>
      <div class="donut-layout"><div class="donut" style="--value:${conversion};--donut-color:var(--green)"><span class="donut-copy"><strong>${conversion}%</strong><small>finalizadas</small></span></div>
      <div class="donut-legend"><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--blue)"></span>Lidas<strong>${count(readWeek)}</strong></div><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--green)"></span>Finalizadas<strong>${count(finishedWeek)}</strong></div><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--red)"></span>Perdidas · total<strong>${count(f.missed)}</strong></div></div></div>
      <div class="notice ${asNumber(f.missed) > asNumber(f.finished) ? "notice--warning" : "notice--info"}" style="margin:1.0625rem 0 0">${icon(asNumber(f.missed) > asNumber(f.finished) ? "alert" : "activity")}<span>${esc(verdict)}</span></div>
    </article>`;
  }

  function renderAttention(accounts, diagnostics) {
    const expired = accounts.filter((a) => ["expired", "none"].includes(licenseState(a.expiry, a.lifetime).key)).length;
    const expiring = accounts.filter((a) => licenseState(a.expiry, a.lifetime).key === "expiring").length;
    const newReports = diagnostics.filter((d) => d.status === "new").length;
    const orphans = state.accounts.filter((a) => a.isOrphan).length;
    const services = Object.values(state.health?.services || {});
    const serviceProblems = services.filter((s) => !s.ok || s.zombie).length;
    const items = [
      [serviceProblems, "Serviços com atenção", "Verifique a infraestrutura crítica", "server", "red", "services"],
      [newReports, "Diagnósticos não revisados", "Relatos aguardando triagem", "bug", "red", "diagnostics"],
      [expiring, "Licenças vencendo", "Prazo de até sete dias", "clock", "yellow", "users"],
      [expired, "Sem acesso ativo", "Licenças expiradas ou ausentes", "key", "blue", "users"],
      [orphans, "Aparelhos sem conta", "Registros legados para revisar", "device", "purple", "users"]
    ].filter(([value]) => value > 0);
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Precisa de atenção</h3><p class="section-copy">Prioridades detectadas agora</p></div></div><div class="attention-list">${items.length ? items.map(([value, title, copy, iconName, tone, page]) => `<button class="attention-item" data-nav="${page}"><span class="attention-icon is-${tone}">${icon(iconName)}</span><span class="attention-copy"><strong>${esc(title)}</strong><small>${esc(copy)}</small></span><span class="attention-count">${count(value)}</span>${icon("chevron-right")}</button>`).join("") : `<div class="notice" style="margin:0">${icon("check-circle")}<span>Nenhuma prioridade crítica foi detectada.</span></div>`}</div></article>`;
  }

  function diagnosticTitle(report) {
    return report.error_message || report.capture_status || (report.error_code != null ? `Código ${report.error_code}` : "Relatório técnico");
  }

  function diagnosticStatus(status) {
    return ({ new: { label: "Novo", tone: "red" }, reviewed: { label: "Em análise", tone: "yellow" }, resolved: { label: "Resolvido", tone: "green" } })[status] || { label: status || "Desconhecido", tone: "neutral" };
  }

  function renderRecentDiagnostics(diagnostics) {
    const list = [...diagnostics].sort((a, b) => asNumber(b.created_at_ms) - asNumber(a.created_at_ms)).slice(0, 5);
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Diagnósticos recentes</h3><p class="section-copy">Últimos relatos enviados pelo app</p></div><button class="text-button" data-nav="diagnostics">Ver fila ${icon("arrow-right")}</button></div><div class="activity-list">${list.length ? list.map((report) => { const status = diagnosticStatus(report.status); return `<button class="activity-item" data-open-diagnostic="${asNumber(report.id)}"><span class="activity-icon">${icon("bug")}</span><span class="activity-copy"><strong>${esc(diagnosticTitle(report))}</strong><small>${esc(report.user_email || "Sem e-mail")} · ${relative(report.created_at_ms)}</small></span>${pill(status.label, status.tone)}${icon("chevron-right")}</button>`; }).join("") : `<div class="notice" style="margin:0">${icon("check-circle")}<span>Nenhum diagnóstico recebido.</span></div>`}</div></article>`;
  }

  function renderRecentAccounts(accounts) {
    const list = [...accounts].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 5);
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Atividade recente</h3><p class="section-copy">Contas vistas por último</p></div><button class="text-button" data-nav="users">Ver base ${icon("arrow-right")}</button></div><div class="activity-list">${list.map((account) => { const license = licenseState(account.expiry, account.lifetime); return `<button class="activity-item" data-open-user="${esc(account.key)}"><span class="avatar ${isOnline(account.lastSeen) ? "is-online" : ""}">${esc(initials(account.name, account.email))}</span><span class="activity-copy"><strong>${esc(account.name || account.email || "Conta sem nome")}</strong><small>${esc(account.email || "Sem e-mail")} · ${relative(account.lastSeen)}</small></span>${pill(license.label, license.tone)}${icon("chevron-right")}</button>`; }).join("")}</div></article>`;
  }

  function normalizedHealthServices() {
    const services = state.health?.services || {};
    return [
      { key: "edge", name: "Edge Function", icon: "activity", ...services.edge },
      { key: "db", name: "Banco de dados", icon: "database", ...services.db },
      { key: "auth", name: "Autenticação", icon: "shield", ...services.auth },
      { key: "evolution", name: "Evolution API", icon: "phone", ...services.evolution }
    ];
  }

  function serviceDescription(service) {
    if (service.zombie) return "Estado zumbi: reporta conexão, mas operações reais falham.";
    if (!service.ok) return service.error || "Serviço indisponível ou sem resposta.";
    if (service.key === "evolution") return service.reported_state_open ? "WhatsApp conectado e operações disponíveis." : "API responde, mas o WhatsApp está desconectado.";
    return "Operacional e respondendo normalmente.";
  }

  function renderServiceSummary() {
    if (state.loading.health && !state.health) return `<article class="panel skeleton" style="min-height:13.125rem"></article>`;
    if (state.errors.health && !state.health) return `<article class="panel"><div class="panel-head"><h3 class="section-title">Saúde dos serviços</h3></div><div class="notice notice--danger" style="margin:0">${icon("alert")}<span>${esc(state.errors.health)}</span></div></article>`;
    const services = normalizedHealthServices();
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Saúde dos serviços</h3><p class="section-copy">Checagem real das dependências</p></div><button class="text-button" data-nav="services">Abrir status ${icon("arrow-right")}</button></div><div class="service-mini-list">${services.map((service) => `<div class="service-mini-item"><span class="status-dot ${service.ok && !service.zombie ? "status-dot--ok" : "status-dot--error"}"></span><span class="service-mini-copy"><strong>${esc(service.name)}</strong><small>${esc(serviceDescription(service))}</small></span><span class="latency">${service.latency_ms != null ? `${count(service.latency_ms)} ms` : "—"}</span></div>`).join("")}</div></article>`;
  }

  function renderQuickActions() {
    const actions = [
      ["users", "users", "Consultar usuário", "Licença, uso e dispositivos"],
      ["diagnostics", "bug", "Revisar diagnósticos", "Logs e ocorrências técnicas"],
      ["whatsapp", "phone", "Gerenciar WhatsApp", "Conexão e verificações"],
      ["broadcast", "send", "Enviar comunicado", "Números verificados ou lista"]
    ];
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Ações rápidas</h3><p class="section-copy">Atalhos operacionais</p></div></div><div class="attention-list">${actions.map(([page, iconName, title, copy]) => `<button class="attention-item" data-nav="${page}"><span class="attention-icon is-blue">${icon(iconName)}</span><span class="attention-copy"><strong>${esc(title)}</strong><small>${esc(copy)}</small></span>${icon("chevron-right")}</button>`).join("")}</div></article>`;
  }

  /* Usuários ------------------------------------------------------------- */
  function filteredAccounts() {
    const filter = state.userFilter;
    const query = filter.search.trim().toLocaleLowerCase("pt-BR");
    const list = state.accounts.filter((account) => {
      if (filter.scope === "real" && (!account.userId || account.isInternal)) return false;
      if (filter.scope === "internal" && !account.isInternal) return false;
      if (filter.scope === "orphan" && !account.isOrphan) return false;
      if (filter.scope === "tester" && !account.isTester) return false;
      if (query) {
        const haystack = [account.name, account.email, account.phone, account.userId, ...account.devices.flatMap((d) => [d.name, d.hash])].filter(Boolean).join(" ").toLocaleLowerCase("pt-BR");
        if (!haystack.includes(query)) return false;
      }
      const license = licenseState(account.expiry, account.lifetime);
      if (filter.license !== "all" && license.key !== filter.license) return false;
      if (filter.verification !== "all" && verificationState(account) !== filter.verification) return false;
      const age = account.lastSeen ? (state.serverNow || state.now) - account.lastSeen : Infinity;
      if (filter.activity === "online" && !isOnline(account.lastSeen)) return false;
      if (filter.activity === "week" && age > 7 * DAY_MS) return false;
      if (filter.activity === "month" && age > 30 * DAY_MS) return false;
      if (filter.activity === "inactive" && age <= 30 * DAY_MS) return false;
      if (filter.activity === "never" && account.lastSeen) return false;
      return true;
    });
    return list.sort((a, b) => {
      if (filter.sort === "email") return String(a.email || "").localeCompare(String(b.email || ""), "pt-BR");
      if (filter.sort === "usage") return b.totalUsage - a.totalUsage;
      if (filter.sort === "expiry") return (a.lifetime ? Infinity : asNumber(a.expiry)) - (b.lifetime ? Infinity : asNumber(b.expiry));
      if (filter.sort === "devices") return b.devices.length - a.devices.length;
      return b.lastSeen - a.lastSeen;
    });
  }

  function renderUsers() {
    const accounts = realAccounts();
    const online = accounts.filter((a) => isOnline(a.lastSeen)).length;
    const active = accounts.filter((a) => ["active", "expiring", "lifetime"].includes(licenseState(a.expiry, a.lifetime).key)).length;
    const expiring = accounts.filter((a) => licenseState(a.expiry, a.lifetime).key === "expiring").length;
    const header = pageHeading("Contas e acessos", "A licença pertence à conta. Aparelhos compartilhados e registros internos são tratados sem distorcer a base real.") + versionReferenceNotice();
    if (!state.devices && state.loading.devices) return header + loadingState("Carregando contas e aparelhos…");
    if (state.errors.devices && !state.devices) return header + errorState(state.errors.devices, "devices");
    return header + `<section class="metric-grid metric-grid--five">
      ${metricCard("Contas reais", count(accounts.length), "Internas fora do total", "blue", "users")}
      ${metricCard("Online agora", count(online), "Contato nos últimos 5 min", "green", "activity")}
      ${metricCard("Acesso ativo", count(active), `${pct(active, accounts.length)}% da base`, "green", "key")}
      ${metricCard("Vencendo", count(expiring), "Prazo de até 7 dias", expiring ? "yellow" : "blue", "clock")}
      ${metricCard("Aparelhos", count(uniqueDevices()), `${count(state.accounts.filter((a) => a.isOrphan).length)} sem conta`, "purple", "device")}
    </section>${state.errors.versions ? `<div class="notice notice--warning">${icon("alert")}<span>Não foi possível consultar as versões dos aplicativos. ${esc(state.errors.versions)}</span><button class="button button--secondary button--compact" data-retry="versions">Tentar novamente</button></div>` : ""}${renderUserToolbar()}<div id="users-results">${renderUserResults()}</div>`;
  }

  function renderUserToolbar() {
    const f = state.userFilter;
    const chips = [["real", "Base real"], ["tester", "Testadores"], ["internal", "Internas"], ["orphan", "Sem conta"], ["all", "Todas"]];
    return `<div class="toolbar"><label class="search-field">${icon("search")}<input id="user-search" type="search" value="${esc(f.search)}" placeholder="Buscar por nome, e-mail, telefone, UUID ou aparelho…" aria-label="Buscar usuários"></label>
      <select id="user-license-filter" class="toolbar-select" aria-label="Filtrar por licença"><option value="all">Todas as licenças</option><option value="active">Ativas</option><option value="expiring">Vencendo</option><option value="expired">Expiradas</option><option value="lifetime">Vitalícias</option><option value="none">Sem licença</option></select>
      <select id="user-activity-filter" class="toolbar-select" aria-label="Filtrar por atividade"><option value="all">Toda atividade</option><option value="online">Online agora</option><option value="week">Ativos em 7 dias</option><option value="month">Ativos em 30 dias</option><option value="inactive">Inativos +30 dias</option><option value="never">Nunca conectaram</option></select>
      <select id="user-verification-filter" class="toolbar-select" aria-label="Filtrar por verificação de telefone"><option value="all">Toda verificação</option><option value="verified">Telefone verificado</option><option value="pending">Cadastrado, não verificado</option><option value="none">Sem telefone</option></select>
      <select id="user-sort" class="toolbar-select" aria-label="Ordenar usuários"><option value="recent">Mais recentes</option><option value="expiry">Próximos do vencimento</option><option value="usage">Maior monitoramento</option><option value="devices">Mais aparelhos</option><option value="email">E-mail A–Z</option></select>
    </div><div class="filter-row">${chips.map(([value, label]) => `<button class="filter-chip" data-user-scope="${value}" aria-pressed="${f.scope === value}">${label}</button>`).join("")}<span class="result-count" id="user-result-count"></span></div>`;
  }

  function renderUserIdentity(account) {
    const name = account.name || account.email || (account.isOrphan ? "Aparelho sem conta" : "Conta sem nome");
    const sub = account.email || account.userId || account.devices[0]?.hash || "Sem identificação";
    const verified = verificationState(account) === "verified"
      ? `<span class="user-verified" role="img" aria-label="Telefone verificado" title="Telefone verificado">${icon("check-circle")}</span>` : "";
    const roles = [account.isTester ? "Testador" : "", account.isInternal ? "Conta interna" : ""].filter(Boolean);
    return `<span class="cell-user user-identity"><span class="avatar ${isOnline(account.lastSeen) ? "is-online" : ""}">${esc(initials(account.name, account.email || account.devices[0]?.name))}</span><span class="user-identity-copy"><span class="user-name"><span class="cell-primary">${esc(name)}</span>${verified}</span><span class="cell-secondary">${esc(sub)}</span>${roles.length ? `<span class="user-meta">${roles.map((role) => `<span>${role}</span>`).join("")}</span>` : ""}</span></span>`;
  }

  function renderUserResults() {
    const list = filteredAccounts();
    const versionTags = userAppVersionTags();
    setTimeout(() => { const countNode = $("user-result-count"); if (countNode) countNode.textContent = `${list.length} ${list.length === 1 ? "resultado" : "resultados"}`; }, 0);
    if (!list.length) return `<div class="table-card">${emptyState("Nenhuma conta encontrada", "Ajuste a busca ou remova alguns filtros.", "search")}</div>`;
    const rows = list.map((account) => {
      const license = licenseState(account.expiry, account.lifetime);
      return `<tr tabindex="0" data-action="open-user" data-open-user="${esc(account.key)}">
        <td>${renderUserIdentity(account)}</td>
        <td>${pill(license.label, license.tone)}</td>
        <td><span class="cell-primary">${isOnline(account.lastSeen) ? "Online" : relative(account.lastSeen)}</span><span class="cell-secondary">${account.lastSeen ? dateTime(account.lastSeen) : "Sem conexão registrada"}</span></td>
        <td><span class="user-device-summary"><span class="cell-metric">${count(account.devices.length)}</span><span>${account.devices.length === 1 ? esc(account.devices[0].name) : "aparelhos"}</span></span>${versionTags.get(account.key)}</td>
        <td><span class="cell-metric">${duration(account.totalUsage, true)}</span><span class="cell-secondary">${count(account.segments)} segmentos</span></td>
        <td class="cell-actions"><span class="row-arrow">${icon("chevron-right")}</span></td>
      </tr>`;
    }).join("");
    const cards = list.map((account) => {
      const license = licenseState(account.expiry, account.lifetime);
      return `<button class="mobile-data-card user-card" data-open-user="${esc(account.key)}">
        <span class="user-card-header">${renderUserIdentity(account)}<span class="row-arrow">${icon("chevron-right")}</span></span>
        <span class="user-card-statuses"><span><span class="user-card-label">Licença</span>${pill(license.label, license.tone)}</span><span><span class="user-card-label">Aplicativo</span>${versionTags.get(account.key)}</span></span>
        <span class="user-card-footer"><span>${isOnline(account.lastSeen) ? "Online agora" : relative(account.lastSeen)}</span><span>${count(account.devices.length)} ${account.devices.length === 1 ? "aparelho" : "aparelhos"}</span><span title="Tempo de monitoramento">${icon("activity")}${duration(account.totalUsage, true)}</span></span>
      </button>`;
    }).join("");
    return `<div class="table-card"><table class="data-table users-table"><colgroup><col style="width:30%"><col style="width:15%"><col style="width:18%"><col style="width:19%"><col style="width:14%"><col style="width:4%"></colgroup><thead><tr><th>Conta</th><th>Licença</th><th>Última atividade</th><th>Aparelhos e app</th><th>Monitoramento</th><th></th></tr></thead><tbody>${rows}</tbody></table><div class="mobile-card-list">${cards}</div><footer class="table-footer"><span>${list.length} de ${state.accounts.length} registros</span><span>Atualizado ${state.lastUpdated ? relative(state.lastUpdated, Date.now()).toLowerCase() : "agora"}</span></footer></div>`;
  }

  /* Detalhe de usuário --------------------------------------------------- */
  function detailStore(account) {
    const key = account.userId || account.key;
    if (!state.detailData.has(key)) {
      state.detailData.set(key, { loading: {}, errors: {}, insights: undefined, versions: undefined, backups: undefined, usage: new Map(), trace: undefined, traceHours: 24 });
    }
    return state.detailData.get(key);
  }

  function findAccount(key) { return state.accounts.find((account) => account.key === key); }

  function openUser(key) {
    const account = findAccount(key);
    if (!account) return;
    state.detail = { type: "user", key };
    state.detailTab = account.isOrphan ? "devices" : "summary";
    renderUserDetail(account);
    if (!els.detail.open) els.detail.showModal();
    if (account.userId) {
      loadUserDetailField(account, "insights", () => rpc("admin_user_insights", { p_user_id: account.userId }), (result) => {
        if (result.status === "empty") return null;
        if (result.status !== "ok") throw new Error("Não foi possível consultar os indicadores desta conta.");
        return result;
      });
      loadUserDetailField(account, "versions", () => rpc("admin_user_versions", { p_user_id: account.userId }), (result) => {
        if (result.status !== "ok") throw new Error("Não foi possível consultar as versões desta conta.");
        return result.devices || [];
      });
    }
  }

  async function loadUserDetailField(account, field, loader, parser = (value) => value) {
    const store = detailStore(account);
    if (store.loading[field]) return;
    store.loading[field] = true;
    delete store.errors[field];
    if (state.detail?.key === account.key) renderUserDetail(account);
    try {
      store[field] = parser(await loader());
    } catch (error) {
      store.errors[field] = error?.message || String(error);
    } finally {
      store.loading[field] = false;
      if (state.detail?.key === account.key) renderUserDetail(account);
    }
  }

  function renderUserDetail(account) {
    const store = detailStore(account);
    const license = licenseState(account.expiry, account.lifetime);
    const tabs = account.isOrphan
      ? [["devices", "Aparelho"]]
      : [["summary", "Resumo"], ["activity", "Uso"], ["devices", "Dispositivos"], ["license", "Licença e dados"], ...(account.isTester ? [["trace", "Rastro"]] : [])];
    const tags = `${pill(license.label, license.tone)}${account.isTester ? '<span class="tag">testador</span>' : ""}${account.isInternal ? '<span class="tag">conta interna</span>' : ""}${account.isOrphan ? '<span class="tag">sem conta</span>' : ""}`;
    els.detailContent.innerHTML = `<header class="detail-top"><button class="icon-button" data-close-detail aria-label="Fechar detalhe">${icon("x")}</button><div class="detail-top-copy"><span class="eyebrow">${account.isOrphan ? "Aparelho legado" : "Detalhe da conta"}</span><h2 id="detail-title">${esc(account.name || account.email || account.devices[0]?.name || "Sem identificação")}</h2></div><button class="icon-button" data-refresh-user="${esc(account.key)}" aria-label="Atualizar conta">${icon("refresh")}</button></header>
      <div class="detail-body"><section class="identity-card"><span class="avatar ${isOnline(account.lastSeen) ? "is-online" : ""}">${esc(initials(account.name, account.email || account.devices[0]?.name))}</span><div class="identity-copy"><h3>${esc(account.name || account.email || "Aparelho sem conta")}</h3><p>${esc(account.email || account.userId || account.devices[0]?.hash || "Sem identificação")}</p></div><div class="tags">${tags}</div></section>
      <div class="detail-tabs" role="tablist">${tabs.map(([value, label]) => `<button class="detail-tab" role="tab" data-user-tab="${value}" aria-selected="${state.detailTab === value}">${label}</button>`).join("")}</div>
      <div id="user-detail-tab">${renderUserDetailTab(account, store)}</div></div>`;
  }

  function renderUserDetailTab(account, store) {
    if (state.detailTab === "summary") return renderUserSummary(account, store);
    if (state.detailTab === "activity") return renderUserActivity(account, store);
    if (state.detailTab === "devices") return renderUserDevices(account, store);
    if (state.detailTab === "license") return renderUserLicense(account, store);
    if (state.detailTab === "trace") return renderUserTrace(account, store);
    return "";
  }

  function renderUserSummary(account, store) {
    const insights = store.insights;
    const relatedDiagnostics = (state.diagnostics || []).filter((report) => report.user_id === account.userId);
    let insightBlock;
    if (store.loading.insights && insights === undefined) {
      insightBlock = `<section class="detail-section skeleton" style="min-height:11.875rem"></section>`;
    } else if (store.errors.insights) {
      insightBlock = `<div class="notice notice--danger">${icon("alert")}<span>${esc(store.errors.insights)}</span></div>`;
    } else if (insights === null) {
      insightBlock = `<section class="detail-section">${emptyState("Sem dados sincronizados", "Esta conta ainda não enviou histórico suficiente para gerar indicadores.", "bar-chart")}</section>`;
    } else if (insights) {
      const rides = insights.rides || {};
      const earnings = insights.earnings || {};
      const time = insights.time || {};
      const conversion = pct(rides.finished, rides.read_total);
      const sources = insights.sources || [];
      insightBlock = `<div class="detail-metrics">
        <div class="detail-metric"><small>Ganhos · 7 dias</small><strong>${money(earnings.week)}</strong></div>
        <div class="detail-metric"><small>Lidas · 7 dias</small><strong>${count(rides.read_week)}</strong></div>
        <div class="detail-metric"><small>Conversão total</small><strong>${conversion}%</strong></div>
        <div class="detail-metric"><small>Em corrida · 30 dias</small><strong>${duration(time.in_ride_ms_month, true)}</strong></div>
      </div><section class="detail-section"><div class="detail-section-head"><div><h3>Imersão no produto</h3><p class="section-copy">Histórico que a própria conta sincronizou</p></div></div><div class="info-list">
        <div class="info-row"><span>Corridas finalizadas</span><span>${count(rides.finished)} de ${count(rides.read_total)} lidas</span></div>
        <div class="info-row"><span>Tempo total em corrida</span><span>${duration(time.in_ride_ms_total)}</span></div>
        <div class="info-row"><span>Ganho acumulado</span><span>${money(earnings.total)}</span></div>
        <div class="info-row"><span>Veículo informado</span><span>${esc(insights.vehicle_type || "—")}</span></div>
        <div class="info-row"><span>Plataforma principal</span><span>${esc(sources[0]?.name || "—")}</span></div>
        <div class="info-row"><span>Telemetria coletada</span><span>${dateTime(insights.collected_at)}</span></div>
      </div></section>`;
    } else insightBlock = "";

    const alertRows = [];
    const license = licenseState(account.expiry, account.lifetime);
    if (["expired", "none"].includes(license.key)) alertRows.push(["red", "Acesso inativo", "A conta está sem uma licença válida."]);
    if (license.key === "expiring") alertRows.push(["yellow", "Vencimento próximo", `A licença expira em ${license.days} dias.`]);
    if (!account.devices.length) alertRows.push(["blue", "Sem dispositivo", "Nenhum aparelho foi vinculado a esta conta."]);
    if (relatedDiagnostics.some((d) => d.status === "new")) alertRows.push(["red", "Diagnóstico pendente", "Há um relato técnico novo desta conta."]);

    return `${alertRows.length ? `<section class="detail-section"><h3>Pontos de atenção</h3>${alertRows.map(([tone, title, copy]) => `<div class="notice notice--${tone === "red" ? "danger" : tone === "yellow" ? "warning" : "info"}" style="margin:0.5rem 0 0">${icon("alert")}<span><strong>${esc(title)}</strong><br>${esc(copy)}</span></div>`).join("")}</section>` : ""}${insightBlock}
      <section class="detail-section"><h3>Conta e atividade</h3><div class="info-list">
        <div class="info-row"><span>E-mail</span><span>${esc(account.email || "—")}</span></div>
        <div class="info-row"><span>Telefone</span><span>${esc(account.phone || "—")}${account.phoneConfirmed ? " · verificado" : ""}</span></div>
        <div class="info-row"><span>Identificador</span><span>${esc(account.userId || "—")}</span></div>
        <div class="info-row"><span>Última atividade</span><span>${relative(account.lastSeen)} · ${dateTime(account.lastSeen)}</span></div>
        <div class="info-row"><span>Monitoramento acumulado</span><span>${duration(account.totalUsage)} em ${count(account.segments)} segmentos</span></div>
        <div class="info-row"><span>Diagnósticos enviados</span><span>${count(relatedDiagnostics.length)}</span></div>
        ${account.isTester ? `<div class="info-row"><span>Programa de testes</span><span>${count(account.testerCheckins)} / 14 check-ins${account.testerCompleted ? " · concluído" : ""}</span></div>` : ""}
      </div></section>`;
  }

  function miniColumns(values, labels, color = "var(--blue)") {
    const normalized = values.map((value) => asNumber(value));
    const maximum = Math.max(1, ...normalized);
    return `<div class="mini-columns">${normalized.map((value, index) => `<div class="mini-column-wrap" title="${esc(labels[index])}: ${duration(value, true)}"><div class="mini-column" style="height:${value ? Math.max(3, value * 100 / maximum) : 2}%;background:${color}"></div><span class="mini-column-label">${esc(labels[index])}</span></div>`).join("")}</div>`;
  }

  function pairsToArray(pairs, length) {
    const result = Array(length).fill(0);
    (pairs || []).forEach((pair) => { const index = asNumber(pair?.[0], -1); if (index >= 0 && index < length) result[index] = asNumber(pair?.[1]); });
    return result;
  }

  function ensureUsageLoaded(account, device = account.devices[0]) {
    if (!device) return;
    const store = detailStore(account);
    if (store.usage.has(device.hash) || store.loading[`usage:${device.hash}`]) return;
    const key = `usage:${device.hash}`;
    store.loading[key] = true;
    rpc("admin_get_device_usage", { p_device_hash: device.hash, p_user_id: account.userId }).then((result) => {
      if (result.status !== "ok") throw new Error("O detalhamento do aparelho não está disponível.");
      store.usage.set(device.hash, result);
    }).catch((error) => { store.errors[key] = error?.message || String(error); }).finally(() => {
      store.loading[key] = false;
      if (state.detail?.key === account.key && state.detailTab === "activity") renderUserDetail(account);
    });
  }

  function renderUserActivity(account, store) {
    const device = account.devices[0];
    if (!device) return emptyState("Sem atividade por aparelho", "Esta conta ainda não vinculou um dispositivo.", "device");
    ensureUsageLoaded(account, device);
    const usage = store.usage.get(device.hash);
    const key = `usage:${device.hash}`;
    const insights = store.insights;
    if (store.loading[key] && !usage) return loadingState("Montando o perfil de uso do aparelho…");
    if (store.errors[key]) return errorState(store.errors[key]);
    if (!usage) return "";
    const hourly = pairsToArray(usage.hourly, 24);
    const weekdays = pairsToArray(usage.day_of_week, 7);
    const daily = (usage.daily || []).map((pair) => asNumber(pair?.[1]));
    const dailyLabels = (usage.daily || []).map((pair) => new Date(asNumber(pair?.[0])).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }));
    const screens = insights?.screens || [];
    return `<div class="notice notice--info">${icon("activity")}<span><strong>Monitoramento</strong> mede quanto tempo o serviço ficou ligado; não é o mesmo que tempo em corrida nem tempo com o app em primeiro plano.</span></div>
      <div class="detail-metrics"><div class="detail-metric"><small>Monitoramento total</small><strong>${duration(usage.total_usage_ms)}</strong></div><div class="detail-metric"><small>Segmentos enviados</small><strong>${count(usage.session_count)}</strong></div><div class="detail-metric"><small>Primeiro segmento</small><strong>${dateOnly(usage.first_session_ms)}</strong></div><div class="detail-metric"><small>Último segmento</small><strong>${relative(usage.last_session_ms)}</strong></div></div>
      <section class="detail-section"><div class="detail-section-head"><div><h3>Horários de monitoramento</h3><p class="section-copy">Tempo acumulado por hora do dia</p></div></div>${miniColumns(hourly, Array.from({ length: 24 }, (_, index) => index % 3 === 0 ? `${index}h` : ""))}</section>
      <section class="detail-section"><div class="detail-section-head"><div><h3>Dias da semana</h3><p class="section-copy">Tempo acumulado por dia</p></div></div>${miniColumns(weekdays, ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"], "var(--purple)")}</section>
      ${daily.length ? `<section class="detail-section"><div class="detail-section-head"><div><h3>Últimos 30 dias</h3><p class="section-copy">Monitoramento reportado por dia</p></div></div>${miniColumns(daily, dailyLabels, "var(--green)")}</section>` : ""}
      ${screens.length ? `<section class="detail-section"><h3>Telas mais usadas</h3><div class="bar-list">${screens.slice(0, 8).map((screen) => bar(screen.name, screen.ms, Math.max(...screens.map((item) => asNumber(item.ms))), "var(--blue)", `${count(screen.hits)} visitas`, duration(screen.ms, true))).join("")}</div></section>` : ""}`;
  }

  function renderUserDevices(account, store) {
    const versions = store.versions;
    const versionByHash = new Map((versions || []).map((item) => [item.device_hash, item]));
    if (!account.devices.length) return emptyState("Nenhum aparelho vinculado", "A conta existe, mas ainda não concluiu o vínculo de um dispositivo.", "device");
    return `<section class="detail-section" style="margin-top:0"><div class="detail-section-head"><div><h3>${account.devices.length} ${account.devices.length === 1 ? "aparelho" : "aparelhos"}</h3><p class="section-copy">Uso e versão são escopados pela conta</p></div></div><div class="device-list">${account.devices.map((device) => { const version = versionByHash.get(device.hash); return `<article class="device-card"><span class="device-icon">${icon("device")}</span><span class="device-copy"><strong>${esc(device.name)}</strong><small>${esc(device.hash.slice(0, 20))}${device.hash.length > 20 ? "…" : ""}</small></span><span style="text-align:right"><span class="cell-primary">${esc(version?.app_version_name || version?.version_name || "Versão desconhecida")}</span><span class="cell-secondary">${relative(device.lastSeen)}</span></span><button class="icon-button button--compact" data-copy="${esc(device.hash)}" aria-label="Copiar hash">${icon("copy")}</button></article>`; }).join("")}</div></section>
      ${store.loading.versions ? `<div class="notice">${icon("loader", "icon spin")}<span>Consultando versões instaladas…</span></div>` : ""}
      ${store.errors.versions ? `<div class="notice notice--danger">${icon("alert")}<span>${esc(store.errors.versions)}</span></div>` : ""}`;
  }

  function ensureBackupsLoaded(account) {
    const store = detailStore(account);
    if (!account.email || store.backups !== undefined || store.loading.backups) return;
    loadUserDetailField(account, "backups", () => rpc("admin_list_user_app_data_versions", { p_email: account.email }), (result) => {
      if (!["ok", "not_found"].includes(result.status)) throw new Error("Não foi possível consultar os backups da conta.");
      return result;
    });
  }

  function renderUserLicense(account, store) {
    ensureBackupsLoaded(account);
    const license = licenseState(account.expiry, account.lifetime);
    const backups = store.backups;
    return `<section class="detail-section" style="margin-top:0"><div class="detail-section-head"><div><h3>Licença da conta</h3><p class="section-copy">Alterações são propagadas para os aparelhos vinculados</p></div>${pill(license.label, license.tone)}</div><div class="info-list"><div class="info-row"><span>Situação</span><span>${esc(license.label)}</span></div><div class="info-row"><span>Vencimento</span><span>${account.lifetime ? "Sem vencimento" : dateTime(account.expiry)}</span></div><div class="info-row"><span>Conta afetada</span><span>${esc(account.email || account.userId)}</span></div></div><div class="detail-actions" style="margin-top:0.9375rem"><input id="license-days" type="number" min="1" max="3650" value="30" aria-label="Dias para adicionar"><button class="button button--secondary button--compact" data-license-action="grant_days" data-account="${esc(account.key)}">Adicionar dias</button><button class="button button--warning-soft button--compact" data-license-action="grant_lifetime" data-account="${esc(account.key)}">Tornar vitalícia</button><button class="button button--danger-soft button--compact" data-license-action="revoke" data-account="${esc(account.key)}">Revogar acesso</button></div></section>
      <section class="detail-section"><div class="detail-section-head"><div><h3>Dados sincronizados e backups</h3><p class="section-copy">Até 20 snapshots anteriores da conta</p></div></div>
        ${store.loading.backups ? `<div class="notice">${icon("loader", "icon spin")}<span>Consultando snapshots…</span></div>` : ""}
        ${store.errors.backups ? `<div class="notice notice--danger">${icon("alert")}<span>${esc(store.errors.backups)}</span></div>` : ""}
        ${backups?.status === "not_found" ? `<div class="notice"><span>Esta conta ainda não possui dados sincronizados.</span></div>` : ""}
        ${backups?.status === "ok" ? `<div class="notice notice--info">${icon("database")}<span>Atual: <strong>${count(backups.current?.entries_count)}</strong> lançamentos, <strong>${count(backups.current?.accepted_rides_count)}</strong> corridas aceitas e <strong>${count(backups.current?.ride_history_count)}</strong> no histórico.</span></div><div class="backup-list">${(backups.versions || []).map((backup) => `<article class="backup-card"><span class="device-icon">${icon("restore")}</span><span class="backup-copy"><strong>${dateTime(backup.saved_at_ms)}</strong><small>${count(backup.entries_count)} lançamentos · ${count(backup.ride_history_count)} no histórico</small></span><button class="button button--secondary button--compact" data-restore-backup="${asNumber(backup.id)}" data-account="${esc(account.key)}">Restaurar</button></article>`).join("") || '<div class="notice"><span>Nenhum snapshot anterior disponível.</span></div>'}</div>` : ""}
      </section>`;
  }

  function ensureUserTraceLoaded(account, hours = 24, force = false) {
    const store = detailStore(account);
    if (!account.userId || store.loading.trace || (!force && store.trace !== undefined && store.traceHours === hours)) return;
    store.traceHours = hours;
    loadUserDetailField(account, "trace", () => rpc("admin_tester_trace", { p_user_id: account.userId, p_since_hours: hours }), (result) => {
      if (result.status !== "ok") throw new Error("O rastro remoto ainda não está disponível.");
      return result;
    });
  }

  function renderUserTrace(account, store) {
    ensureUserTraceLoaded(account, store.traceHours);
    const trace = store.trace;
    return `<div class="toolbar"><select id="user-trace-hours" class="toolbar-select" aria-label="Intervalo do rastro"><option value="6"${store.traceHours === 6 ? " selected" : ""}>Últimas 6 horas</option><option value="24"${store.traceHours === 24 ? " selected" : ""}>Últimas 24 horas</option><option value="72"${store.traceHours === 72 ? " selected" : ""}>Últimas 72 horas</option><option value="168"${store.traceHours === 168 ? " selected" : ""}>Últimos 7 dias</option></select><button class="button button--secondary button--compact" data-refresh-user-trace="${esc(account.key)}">${icon("refresh")} Atualizar</button>${trace?.text ? `<button class="button button--secondary button--compact" data-copy-trace="user">${icon("copy")} Copiar</button><button class="button button--secondary button--compact" data-download-trace="user">${icon("download")} Baixar</button>` : ""}</div>
      <div class="notice notice--info">${icon("shield")}<span>Disponível apenas para participantes do programa de testes, com retenção de 30 dias.</span></div>
      ${store.loading.trace ? loadingState("Costurando os lotes do rastro…") : ""}
      ${store.errors.trace ? errorState(store.errors.trace) : ""}
      ${trace ? `<div class="detail-metrics"><div class="detail-metric"><small>Lotes</small><strong>${count(trace.batches)}</strong></div><div class="detail-metric"><small>Bytes descartados</small><strong>${bytes(trace.skipped_bytes)}</strong></div></div>${trace.text ? `<div class="log-box"><pre>${esc(trace.text)}</pre></div>` : emptyState("Sem eventos no intervalo", "Nenhum lote de rastro foi recebido neste período.", "terminal")}` : ""}`;
  }

  async function handleLicenseAction(account, action) {
    if (!account?.userId) return;
    const days = clamp(asNumber($("license-days")?.value, 30), 1, 3650);
    const descriptions = {
      grant_days: [`Adicionar ${days} dias?`, `A validade será estendida para ${account.email || account.userId}.`, "Adicionar dias", false],
      grant_lifetime: ["Conceder licença vitalícia?", `A conta ${account.email || account.userId} ficará sem data de vencimento.`, "Conceder", false],
      revoke: ["Revogar o acesso?", `A licença de ${account.email || account.userId} será encerrada imediatamente em todos os aparelhos vinculados.`, "Revogar acesso", true]
    };
    const [title, message, label, danger] = descriptions[action];
    if (!await askConfirm({ title, message, label, danger, extra: `<code>${esc(account.email || account.userId)}</code>` })) return;
    try {
      const result = await rpc("admin_set_user_license", { p_user_id: account.userId, p_action: action, p_duration_days: action === "grant_days" ? days : null });
      if (result.status !== "ok") throw new Error(result.message || `A operação retornou “${result.status}”.`);
      account.expiry = result.expiry_ms ?? null;
      account.lifetime = result.is_lifetime === true;
      (state.devices || []).filter((row) => row.user_id === account.userId).forEach((row) => { row.user_expiry_ms = account.expiry; row.user_is_lifetime = account.lifetime; });
      toast(action === "revoke" ? "Acesso revogado" : "Licença atualizada");
      renderUserDetail(account); renderCurrentPage();
      loadDevices({ quiet: true });
    } catch (error) { toast("Não foi possível alterar a licença", "error", error.message); }
  }

  async function restoreBackup(account, versionId) {
    if (!account?.email) return;
    const backup = detailStore(account).backups?.versions?.find((item) => asNumber(item.id) === asNumber(versionId));
    if (!await askConfirm({ title: "Restaurar este backup?", message: "Os dados sincronizados atuais da conta serão substituídos pelo snapshot selecionado. Um novo snapshot de segurança é criado pelo servidor antes da restauração.", label: "Restaurar dados", danger: true, extra: `<code>${esc(account.email)} · ${dateTime(backup?.saved_at_ms)}</code>` })) return;
    try {
      const result = await rpc("admin_restore_user_app_data", { p_email: account.email, p_version_id: asNumber(versionId) });
      if (result.status !== "ok") throw new Error(`A restauração retornou “${result.status}”.`);
      toast("Backup restaurado", "success", `${count(result.restored?.entries_count)} lançamentos e ${count(result.restored?.ride_history_count)} corridas recuperados.`);
      const store = detailStore(account); store.backups = undefined; ensureBackupsLoaded(account);
    } catch (error) { toast("Não foi possível restaurar", "error", error.message); }
  }

  /* Diagnósticos --------------------------------------------------------- */
  function filteredDiagnostics() {
    const f = state.diagnosticFilter;
    const query = f.search.trim().toLocaleLowerCase("pt-BR");
    return (state.diagnostics || []).filter((report) => {
      if (f.status !== "all" && report.status !== f.status) return false;
      if (f.manufacturer !== "all" && (report.manufacturer || report.brand || "Desconhecido") !== f.manufacturer) return false;
      if (f.version !== "all" && (report.app_version_name || "Desconhecida") !== f.version) return false;
      if (query && ![report.user_email, report.user_name, report.device_hash, report.manufacturer, report.brand, report.model, report.error_message, report.error_code, report.capture_status, report.log_text].filter((v) => v != null).join(" ").toLocaleLowerCase("pt-BR").includes(query)) return false;
      return true;
    }).sort((a, b) => asNumber(b.created_at_ms) - asNumber(a.created_at_ms));
  }

  function renderDiagnostics() {
    const reports = state.diagnostics || [];
    const statusCount = (status) => reports.filter((report) => report.status === status).length;
    const header = pageHeading("Fila de diagnósticos", "Relatos enviados voluntariamente pelo app. Cada item reúne ambiente, recorrência, metadata e log técnico.");
    if (!state.diagnostics && state.loading.diagnostics) return header + loadingState("Carregando relatórios técnicos…");
    if (state.errors.diagnostics && !state.diagnostics) return header + errorState(state.errors.diagnostics, "diagnostics");
    const manufacturers = [...new Set(reports.map((report) => report.manufacturer || report.brand || "Desconhecido"))].sort();
    const versions = [...new Set(reports.map((report) => report.app_version_name || "Desconhecida"))].sort();
    const f = state.diagnosticFilter;
    return header + `<section class="metric-grid">
      ${metricCard("Novos", count(statusCount("new")), "Aguardando primeira análise", statusCount("new") ? "red" : "blue", "bug")}
      ${metricCard("Em análise", count(statusCount("reviewed")), "Triagem ou investigação", statusCount("reviewed") ? "yellow" : "blue", "search")}
      ${metricCard("Resolvidos", count(statusCount("resolved")), `${pct(statusCount("resolved"), reports.length)}% dos relatos`, "green", "check-circle")}
      ${metricCard("Recorrências", count(reports.reduce((sum, report) => sum + Math.max(1, asNumber(report.occurrence_count)), 0)), `${count(reports.length)} relatórios`, "purple", "activity")}
    </section><div class="toolbar"><label class="search-field">${icon("search")}<input id="diagnostic-search" type="search" value="${esc(f.search)}" placeholder="Buscar conta, aparelho, código ou mensagem…" aria-label="Buscar diagnósticos"></label>
      <select id="diagnostic-manufacturer" class="toolbar-select"><option value="all">Todos fabricantes</option>${manufacturers.map((value) => `<option value="${esc(value)}"${f.manufacturer === value ? " selected" : ""}>${esc(value)}</option>`).join("")}</select>
      <select id="diagnostic-version" class="toolbar-select"><option value="all">Todas versões</option>${versions.map((value) => `<option value="${esc(value)}"${f.version === value ? " selected" : ""}>${esc(value)}</option>`).join("")}</select>
    </div><div class="filter-row">${[["all", "Todos"], ["new", "Novos"], ["reviewed", "Em análise"], ["resolved", "Resolvidos"]].map(([value, label]) => `<button class="filter-chip" data-diagnostic-status="${value}" aria-pressed="${f.status === value}">${label}</button>`).join("")}<span class="result-count" id="diagnostic-result-count"></span></div><div id="diagnostic-results">${renderDiagnosticResults()}</div>`;
  }

  function renderDiagnosticResults() {
    const list = filteredDiagnostics();
    setTimeout(() => { const node = $("diagnostic-result-count"); if (node) node.textContent = `${list.length} ${list.length === 1 ? "relatório" : "relatórios"}`; }, 0);
    if (!list.length) return `<div class="table-card">${emptyState("Nenhum diagnóstico encontrado", "Não há relatos que correspondam aos filtros atuais.", "bug")}</div>`;
    const rows = list.map((report) => {
      const status = diagnosticStatus(report.status);
      const device = [report.manufacturer || report.brand, report.model].filter(Boolean).join(" ") || "Aparelho desconhecido";
      return `<tr tabindex="0" data-action="open-diagnostic" data-open-diagnostic="${asNumber(report.id)}"><td><span class="cell-primary">${esc(report.user_name || report.user_email || "Conta sem nome")}</span><span class="cell-secondary">${esc(report.user_email || report.user_id || "Sem identificação")}</span></td><td><span class="cell-primary">${esc(diagnosticTitle(report))}</span><span class="cell-secondary">${esc(report.capture_status || "status desconhecido")}${report.error_code != null ? ` · código ${esc(report.error_code)}` : ""}</span></td><td><span class="cell-primary">${esc(device)}</span><span class="cell-secondary">${esc(report.android_release ? `Android ${report.android_release}` : "Android desconhecido")} · ${esc(report.app_version_name || "versão desconhecida")}</span></td><td><span class="cell-metric">${count(Math.max(1, report.occurrence_count))}×</span></td><td>${pill(status.label, status.tone)}</td><td><span class="cell-primary">${relative(report.created_at_ms)}</span><span class="cell-secondary">${dateTime(report.created_at_ms)}</span></td><td class="cell-actions"><span class="row-arrow">${icon("chevron-right")}</span></td></tr>`;
    }).join("");
    const cards = list.map((report) => { const status = diagnosticStatus(report.status); return `<button class="mobile-data-card" data-open-diagnostic="${asNumber(report.id)}"><span class="activity-icon">${icon("bug")}</span><span style="min-width:0;flex:1"><span class="cell-primary">${esc(diagnosticTitle(report))}</span><span class="cell-secondary">${esc(report.user_email || "Sem conta")} · ${relative(report.created_at_ms)}</span></span><span class="mobile-data-side">${pill(status.label, status.tone)}<span class="cell-secondary">${count(Math.max(1, report.occurrence_count))}×</span></span></button>`; }).join("");
    return `<div class="table-card"><table class="data-table"><colgroup><col style="width:19%"><col style="width:25%"><col style="width:19%"><col style="width:8%"><col style="width:11%"><col style="width:12%"><col style="width:6%"></colgroup><thead><tr><th>Origem</th><th>Ocorrência</th><th>Ambiente</th><th>Vezes</th><th>Estado</th><th>Recebido</th><th></th></tr></thead><tbody>${rows}</tbody></table><div class="mobile-card-list">${cards}</div><footer class="table-footer"><span>${list.length} relatórios visíveis</span><span>Limite de 500 mais recentes</span></footer></div>`;
  }

  function openDiagnostic(id) {
    const report = (state.diagnostics || []).find((item) => asNumber(item.id) === asNumber(id));
    if (!report) return;
    state.detail = { type: "diagnostic", id: asNumber(id) };
    const status = diagnosticStatus(report.status);
    const metadata = safeJson(report.metadata, {});
    const prettyMetadata = JSON.stringify(metadata, null, 2);
    const account = state.accounts.find((item) => item.userId === report.user_id);
    const device = [report.manufacturer || report.brand, report.model].filter(Boolean).join(" ") || "Aparelho desconhecido";
    els.detailContent.innerHTML = `<header class="detail-top"><button class="icon-button" data-close-detail aria-label="Fechar detalhe">${icon("x")}</button><div class="detail-top-copy"><span class="eyebrow">Diagnóstico #${asNumber(report.id)}</span><h2 id="detail-title">${esc(diagnosticTitle(report))}</h2></div>${pill(status.label, status.tone)}</header><div class="detail-body">
      <section class="identity-card"><span class="activity-icon">${icon("bug")}</span><div class="identity-copy"><h3>${esc(report.user_name || report.user_email || "Conta sem nome")}</h3><p>${esc(report.user_email || report.user_id || "Sem identificação")}</p></div>${account ? `<button class="button button--secondary button--compact" data-open-user="${esc(account.key)}">Abrir conta</button>` : ""}</section>
      <section class="detail-section" style="margin-top:0"><div class="detail-section-head"><div><h3>Tratamento</h3><p class="section-copy">Atualize o estado conforme a investigação avança</p></div></div><div class="detail-actions">${[["new", "Marcar como novo"], ["reviewed", "Mover para análise"], ["resolved", "Marcar resolvido"]].map(([value, label]) => `<button class="button ${report.status === value ? "button--primary" : "button--secondary"} button--compact" data-set-diagnostic-status="${value}" data-diagnostic-id="${asNumber(report.id)}" ${report.status === value ? "disabled" : ""}>${esc(label)}</button>`).join("")}</div></section>
      <section class="detail-section"><h3>Ocorrência</h3><div class="info-list"><div class="info-row"><span>Mensagem</span><span>${esc(report.error_message || "—")}</span></div><div class="info-row"><span>Captura</span><span>${esc(report.capture_status || "—")}</span></div><div class="info-row"><span>Código</span><span>${report.error_code != null ? esc(report.error_code) : "—"}</span></div><div class="info-row"><span>Recorrência</span><span>${count(Math.max(1, report.occurrence_count))} ocorrências</span></div><div class="info-row"><span>Recebido</span><span>${dateTime(report.created_at_ms)}</span></div><div class="info-row"><span>Revisado</span><span>${dateTime(report.reviewed_at_ms)}</span></div></div></section>
      <section class="detail-section"><h3>Ambiente</h3><div class="info-list"><div class="info-row"><span>Aparelho</span><span>${esc(device)}</span></div><div class="info-row"><span>Produto / build</span><span>${esc([report.product, report.build_display].filter(Boolean).join(" · ") || "—")}</span></div><div class="info-row"><span>Android</span><span>${esc(report.android_release ? `${report.android_release} · SDK ${report.sdk_int ?? "—"}` : "—")}</span></div><div class="info-row"><span>Versão do app</span><span>${esc(report.app_version_name || "—")}${report.app_version_code != null ? ` (${esc(report.app_version_code)})` : ""}</span></div><div class="info-row"><span>Dispositivo</span><span>${esc(report.device_hash || "—")}</span></div></div></section>
      <section class="detail-section"><div class="detail-section-head"><div><h3>Log técnico</h3><p class="section-copy">Conteúdo enviado pelo usuário com consentimento</p></div><div class="detail-actions"><button class="button button--secondary button--compact" data-copy-diagnostic-log="${asNumber(report.id)}">${icon("copy")} Copiar</button><button class="button button--secondary button--compact" data-download-diagnostic-log="${asNumber(report.id)}">${icon("download")} Baixar</button></div></div>${report.log_text ? `<div class="log-box"><pre>${esc(report.log_text)}</pre></div>` : `<div class="notice"><span>Nenhum log foi anexado.</span></div>`}</section>
      <section class="detail-section"><div class="detail-section-head"><div><h3>Metadata</h3><p class="section-copy">Configuração e permissões no momento do relato</p></div><button class="button button--secondary button--compact" data-copy-metadata="${asNumber(report.id)}">${icon("copy")} Copiar JSON</button></div><div class="metadata-box"><pre>${esc(prettyMetadata)}</pre></div></section>
    </div>`;
    if (!els.detail.open) els.detail.showModal();
  }

  async function setDiagnosticStatus(id, status) {
    const report = (state.diagnostics || []).find((item) => asNumber(item.id) === asNumber(id));
    if (!report) return;
    try {
      const result = await rpc("admin_set_diagnostic_report_status", { p_report_id: asNumber(id), p_status: status });
      if (result.status !== "ok") throw new Error(`A operação retornou “${result.status}”.`);
      report.status = status;
      report.reviewed_at_ms = status === "new" ? null : Date.now();
      toast("Estado do diagnóstico atualizado");
      openDiagnostic(id); renderCurrentPage(); syncNavBadges();
    } catch (error) { toast("Não foi possível atualizar o diagnóstico", "error", error.message); }
  }

  /* Uso e adoção --------------------------------------------------------- */
  const EVENT_LABELS = {
    accept_shown: "Janela de aceite exibida", accept_tapped: "Aceitar tocado", accept_dismissed: "Janela dispensada", accept_expired: "Janela expirada",
    home_entry_tapped: "Atalho de entrada", home_expense_tapped: "Atalho de saída", home_statement_tapped: "Atalho de extrato", home_addresses_tapped: "Atalho de endereços", home_pix_tapped: "Atalho de Pix",
    ride_accepted: "Corrida aceita", ride_finished: "Corrida finalizada", ride_rejected: "Corrida recusada", ride_canceled: "Corrida cancelada", ride_missed: "Corrida perdida"
  };

  function renderAnalytics() {
    const s = state.statistics;
    const header = pageHeading("Comportamento da base", "Os dados globais excluem contas internas. Janelas temporais só são usadas onde o backend registra timestamps de corridas.");
    if (!s && state.loading.statistics) return header + loadingState("Agregando o comportamento da base…");
    if (state.errors.statistics && !s) return header + errorState(state.errors.statistics, "statistics");
    if (!s) return header + emptyState("Sem telemetria", "Nenhuma conta sincronizou dados de uso ainda.", "bar-chart");
    const a = s.accounts || {}, f = s.funnel || {}, events = s.events || {};
    const conversion = pct(f.finished, f.read);
    const weekConversion = pct(f.finished_week, f.read_week);
    return header + `<div class="notice notice--info">${icon("activity")}<span><strong>Leituras e finalizações</strong> vêm do histórico de corridas. Tempos de tela e eventos são acumulados e podem refletir a última sincronização de apenas um aparelho em contas multi-device.</span></div><section class="metric-grid metric-grid--five">
      ${metricCard("Com dados", count(a.with_data), "Snapshots sincronizados", "blue", "database")}
      ${metricCard("Com corridas", count(a.with_rides), `${pct(a.with_rides, a.with_data)}% com histórico`, "purple", "device")}
      ${metricCard("Ativos em 7 dias", count(a.active_week), "Tiveram corrida registrada", "green", "activity")}
      ${metricCard("Solicitações lidas", count(f.read), `${count(f.read_week)} nos últimos 7 dias`, "blue", "search")}
      ${metricCard("Finalizadas", `${conversion}%`, `${weekConversion}% nos últimos 7 dias`, "green", "check-circle")}
    </section><section class="content-grid content-grid--wide-left">${renderRequestStates(f)}${renderAcceptanceWindow(events)}</section><section class="content-grid">${renderSourceAnalytics(s.sources || [])}${renderScreenAnalytics(s.screens || [])}</section><section class="content-grid">${renderEventAnalytics(events)}${renderUserDistribution(s.per_user || [])}</section>`;
  }

  function renderRequestStates(f) {
    const read = asNumber(f.read);
    const states = [["Finalizadas", f.finished, "var(--green)"], ["Aceitas / em curso", f.accepted, "var(--blue)"], ["Recusadas", f.rejected, "var(--muted)"], ["Canceladas", f.canceled, "var(--yellow)"], ["Perdidas", f.missed, "var(--red)"]];
    const verdict = read < 20 ? "Ainda há pouco volume para interpretar a distribuição." : asNumber(f.missed) > asNumber(f.finished) ? "As perdidas superam as finalizadas. Vale cruzar este sinal com diagnósticos e rastros de teste." : "Finalizadas superam as perdidas no histórico acumulado.";
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Estados das solicitações</h3><p class="section-copy">Situação atual das linhas do histórico — não é um funil sequencial</p></div></div><div class="funnel-list">${states.map(([label, value, color]) => `<div class="funnel-row"><span class="bar-label">${label}</span><div class="bar-track"><div class="bar-fill" style="width:${pct(value, read)}%;--bar-color:${color}"></div></div><span class="funnel-number">${count(value)} <small>${pct(value, read)}%</small></span></div>`).join("")}</div><div class="notice ${asNumber(f.missed) > asNumber(f.finished) ? "notice--warning" : "notice--info"}" style="margin:1.0625rem 0 0">${icon("activity")}<span>${esc(verdict)}</span></div></article>`;
  }

  function renderAcceptanceWindow(events) {
    const shown = asNumber(events.accept_shown), tapped = asNumber(events.accept_tapped), rate = pct(tapped, shown);
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Janela de aceite</h3><p class="section-copy">Interação medida desde a instrumentação</p></div></div>${shown ? `<div class="donut-layout"><div class="donut" style="--value:${rate};--donut-color:var(--purple)"><span class="donut-copy"><strong>${rate}%</strong><small>toques</small></span></div><div class="donut-legend"><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--purple)"></span>Exibições<strong>${count(shown)}</strong></div><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--green)"></span>Toques<strong>${count(tapped)}</strong></div><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--muted)"></span>Dispensadas<strong>${count(events.accept_dismissed)}</strong></div><div class="legend-row"><span class="legend-dot" style="--legend-color:var(--yellow)"></span>Expiradas<strong>${count(events.accept_expired)}</strong></div></div></div>` : `<div class="notice"><span>Sem exibições medidas ainda. Isso é diferente de uma taxa de 0%.</span></div>`}</article>`;
  }

  function renderSourceAnalytics(sources) {
    const list = [...sources].sort((a, b) => asNumber(b.read_count) - asNumber(a.read_count));
    const maximum = Math.max(1, ...list.map((item) => asNumber(item.read_count)));
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Plataformas monitoradas</h3><p class="section-copy">Origem das solicitações persistidas</p></div></div>${list.length ? `<div class="bar-list">${list.map((item) => bar(item.name || "Desconhecida", item.read_count, maximum, "var(--purple)", `${pct(item.finished_count, item.read_count)}% finalizadas`)).join("")}</div>` : `<div class="notice"><span>Sem plataformas identificadas.</span></div>`}</article>`;
  }

  function renderScreenAnalytics(screens) {
    const list = [...screens].sort((a, b) => asNumber(b.ms) - asNumber(a.ms)).slice(0, 12);
    const maximum = Math.max(1, ...list.map((item) => asNumber(item.ms)));
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Telas por permanência</h3><p class="section-copy">Acumulado sincronizado pela base</p></div></div>${list.length ? `<div class="bar-list">${list.map((item) => bar(item.name || "Sem nome", item.ms, maximum, "var(--blue)", `${count(item.hits)} visitas`, duration(item.ms, true))).join("")}</div>` : `<div class="notice"><span>Sem tempo de tela sincronizado.</span></div>`}</article>`;
  }

  function renderEventAnalytics(events) {
    const list = Object.entries(events).filter(([, value]) => asNumber(value) > 0).sort((a, b) => asNumber(b[1]) - asNumber(a[1])).slice(0, 16);
    const maximum = Math.max(1, ...list.map(([, value]) => asNumber(value)));
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Interações e eventos</h3><p class="section-copy">Mistura ações explícitas e eventos automáticos do ciclo de corrida</p></div></div>${list.length ? `<div class="bar-list">${list.map(([name, value]) => bar(EVENT_LABELS[name] || name.replaceAll("_", " "), value, maximum, "var(--yellow)")).join("")}</div>` : `<div class="notice"><span>Sem eventos sincronizados.</span></div>`}</article>`;
  }

  function renderUserDistribution(users) {
    const list = [...users].sort((a, b) => asNumber(b.read) - asNumber(a.read)).slice(0, 12);
    const emails = new Map(state.accounts.map((account) => [account.userId, account.email]));
    return `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Distribuição por conta</h3><p class="section-copy">Quem mais registra solicitações</p></div></div>${list.length ? `<div class="activity-list">${list.map((user) => `<div class="activity-item"><span class="avatar">${esc(initials("", emails.get(user.user_id) || user.user_id))}</span><span class="activity-copy"><strong>${esc(emails.get(user.user_id) || `${String(user.user_id).slice(0, 8)}…`)}</strong><small>${count(user.finished)} finalizadas · ${count(user.rejected)} recusadas</small></span><span class="cell-metric">${count(user.read)}</span><span class="cell-secondary"> · ${pct(user.finished, user.read)}%</span></div>`).join("")}</div>` : `<div class="notice"><span>Sem distribuição por conta.</span></div>`}</article>`;
  }

  /* Versões -------------------------------------------------------------- */
  function appVersionReference() {
    const release = state.versions?.latest_release;
    const reported = (state.versions?.devices || []).filter((device) => !device.is_internal)
      .reduce((latest, device) => asNumber(device.app_version_code) > asNumber(latest?.app_version_code) ? device : latest, null);
    // O catálogo legado de APKs pode estar atrás das versões distribuídas pela Play Store.
    const observed = asNumber(reported?.app_version_code) > asNumber(release?.version_code);
    return {
      code: asNumber(observed ? reported?.app_version_code : release?.version_code),
      name: observed ? reported?.app_version_name : release?.version_name,
      observed
    };
  }

  function userAppVersionTags() {
    const reference = appVersionReference();
    const devicesByUser = new Map();
    (state.versions?.devices || []).forEach((device) => {
      if (!device.user_id) return;
      if (!devicesByUser.has(device.user_id)) devicesByUser.set(device.user_id, new Map());
      devicesByUser.get(device.user_id).set(device.device_hash, device);
    });
    return new Map(state.accounts.map((account) => {
      const tag = (label, title, tone = "") => [account.key, `<span class="user-version-status${tone ? ` user-version-status--${tone}` : ""}" title="${esc(title)}">${icon(tone === "ok" ? "check-circle" : tone === "warning" ? "alert" : "package")}<span>${esc(label)}</span></span>`];
      if (state.loading.versions) return tag("consultando versão", "Consultando a versão instalada nos aparelhos desta conta.");
      if (state.errors.versions) return tag("versão indisponível", "Não foi possível consultar as versões. Tente atualizar os dados.");
      if (!state.versions) return tag("consultando versão", "Aguardando os dados de versão.");
      const versions = devicesByUser.get(account.userId);
      const hashes = new Set([...account.devices.map((device) => device.hash), ...(versions?.keys() || [])]);
      const devices = [...hashes].map((hash) => versions?.get(hash));
      const known = devices.filter((device) => asNumber(device?.app_version_code) > 0);
      if (!known.length) return tag("versão não informada", "Nenhum aparelho desta conta informou o código da versão instalada.");
      if (reference.code <= 0) return tag("referência indisponível", "Ainda não há uma versão de referência para comparar.");
      const current = known.filter((device) => asNumber(device.app_version_code) >= reference.code);
      const target = `Referência: ${reference.name || reference.code} (${reference.observed ? "mais recente identificada nos aparelhos; catálogo de releases desatualizado ou ausente" : "release publicada"}).`;
      const installed = `Versões informadas: ${[...new Set(known.map((device) => device.app_version_name || device.app_version_code))].join(", ")}.`;
      if (current.length === devices.length) return tag("app atualizado", `Todos os aparelhos vinculados estão atualizados. ${installed} ${target}`, "ok");
      if (current.length) return tag("atualização parcial", `${current.length} de ${devices.length} aparelhos estão atualizados; os demais estão em versão anterior ou não informaram a versão. ${installed} ${target}`, "warning");
      return tag("app desatualizado", `Os aparelhos com versão conhecida estão em uma versão anterior. ${installed} ${target}`, "warning");
    }));
  }

  function versionReferenceNotice() {
    const reference = appVersionReference();
    if (!reference.observed || state.errors.versions || state.loading.versions) return "";
    return `<div class="notice notice--info">${icon("package")}<span>Versão de referência: <strong>${esc(reference.name || reference.code)}</strong>, a mais recente informada pelos aparelhos. O catálogo de releases ainda não registra essa versão.</span></div>`;
  }

  function loadVersions(options = {}) {
    return loadResource("versions", () => rpc("admin_version_overview", {}), (result) => {
      if (result.status !== "ok") throw new Error("O resumo global de versões não está disponível.");
      state.versions = result;
    }, options);
  }

  function versionOverview() {
    const payload = state.versions || {};
    const release = payload.latest_release || null;
    const devices = (payload.devices || []).filter((item) => !item.is_internal);
    const known = devices.filter((item) => item.app_version_code != null || item.app_version_name);
    const currentCode = appVersionReference().code;
    const current = known.filter((item) => asNumber(item.app_version_code) >= currentCode && currentCode > 0);
    const outdated = known.filter((item) => currentCode > 0 && asNumber(item.app_version_code) < currentCode);
    const unknown = devices.filter((item) => item.app_version_code == null && !item.app_version_name);
    const groups = new Map();
    devices.forEach((item) => {
      const code = item.app_version_code == null ? null : asNumber(item.app_version_code);
      const name = item.app_version_name || "Desconhecida";
      const key = `${code ?? "unknown"}|${name}`;
      const group = groups.get(key) || { name, code, count: 0, accounts: new Set(), current: currentCode > 0 && code != null && code >= currentCode };
      group.count += 1; if (item.user_id) group.accounts.add(item.user_id); groups.set(key, group);
    });
    return { release, devices, known, current, outdated, unknown, currentCode, groups: [...groups.values()].sort((a, b) => (b.code ?? -1) - (a.code ?? -1)) };
  }

  function renderVersions() {
    const header = pageHeading("Adoção de versões", "Comparação com o catálogo de releases e as versões informadas pelos aparelhos.") + versionReferenceNotice();
    if (!state.versions && state.loading.versions) return header + loadingState("Consultando a distribuição instalada…");
    if (state.errors.versions && !state.versions) return header + `<div class="notice notice--warning">${icon("alert")}<span><strong>O novo resumo global precisa estar publicado no Supabase.</strong><br>${esc(state.errors.versions)}</span></div>${errorState("Aplique a migração 20260827000000_admin_hub_overview.sql e tente novamente.", "versions")}`;
    if (!state.versions) return header;
    const view = versionOverview();
    const adoption = pct(view.current.length, view.devices.length);
    const release = view.release;
    const maximum = Math.max(1, ...view.groups.map((group) => group.count));
    const lateAccounts = new Map();
    view.outdated.forEach((item) => {
      const key = item.user_id || item.device_hash;
      const current = lateAccounts.get(key);
      if (!current || asNumber(item.app_version_code) < asNumber(current.app_version_code)) lateAccounts.set(key, item);
    });
    const apkUrl = safeHttpUrl(release?.apk_url);
    return header + `${release ? `<section class="hero-status"><span class="hero-status-icon">${icon("package")}</span><div class="hero-status-copy"><span class="eyebrow">Release publicada</span><h3>${esc(release.version_name)} · código ${count(release.version_code)}</h3><p>Publicada em ${dateTime(release.released_at_ms)}${release.file_size_bytes ? ` · ${bytes(release.file_size_bytes)}` : ""}${release.mandatory ? " · atualização obrigatória" : ""}</p></div><div class="hero-status-actions">${apkUrl ? `<a class="button button--secondary button--compact" href="${esc(apkUrl)}" target="_blank" rel="noopener">${icon("external")} Abrir APK</a>` : ""}</div></section>` : `<div class="notice notice--warning">${icon("alert")}<span>Nenhuma release foi encontrada no catálogo.</span></div>`}
      <section class="metric-grid" style="margin-top:0.9375rem">${metricCard("Aparelhos reportados", count(view.devices.length), `${count(view.known.length)} com versão conhecida`, "blue", "device")}${metricCard("Na versão atual", `${adoption}%`, `${count(view.current.length)} aparelhos`, "green", "check-circle")}${metricCard("Atrasados", count(view.outdated.length), `${count(lateAccounts.size)} contas afetadas`, view.outdated.length ? "yellow" : "green", "alert")}${metricCard("Sem versão", count(view.unknown.length), "Build ainda não identificada", view.unknown.length ? "purple" : "blue", "package")}</section>
      <section class="content-grid content-grid--wide-left"><article class="panel"><div class="panel-head"><div><h3 class="section-title">Distribuição instalada</h3><p class="section-copy">Contas internas não participam deste cálculo</p></div></div><div class="version-list">${view.groups.map((group) => `<div class="version-row"><span class="version-name">${esc(group.name)} ${group.current ? '<span class="tag" style="margin-left:0.3125rem">atual</span>' : ""}</span><div class="bar-track"><div class="bar-fill" style="width:${group.count * 100 / maximum}%;--bar-color:${group.current ? "var(--green)" : group.code == null ? "var(--muted)" : "var(--yellow)"}"></div></div><span class="version-number">${count(group.count)}</span><span class="version-number">${pct(group.count, view.devices.length)}%</span></div>`).join("") || '<div class="notice"><span>Sem dispositivos com versão reportada.</span></div>'}</div></article>
      <article class="panel"><div class="panel-head"><div><h3 class="section-title">Contas atrasadas</h3><p class="section-copy">Versão abaixo da release publicada</p></div></div><div class="activity-list">${[...lateAccounts.values()].sort((a, b) => asNumber(a.app_version_code) - asNumber(b.app_version_code)).slice(0, 12).map((item) => { const account = state.accounts.find((a) => a.userId === item.user_id); return `<button class="activity-item" ${account ? `data-open-user="${esc(account.key)}"` : ""}><span class="activity-icon">${icon("device")}</span><span class="activity-copy"><strong>${esc(item.user_email || item.device_name || "Sem identificação")}</strong><small>${esc(item.app_version_name || "desconhecida")} · ${relative(item.last_seen_ms)}</small></span><span class="tag">code ${count(item.app_version_code)}</span>${account ? icon("chevron-right") : ""}</button>`; }).join("") || '<div class="notice"><span>Todos os aparelhos conhecidos estão na versão atual.</span></div>'}</div></article></section>`;
  }

  /* Rastros de teste ----------------------------------------------------- */
  function loadTraces(options = {}) {
    return loadResource("traces", () => rpc("admin_tester_trace_index", {}), (result) => {
      if (result.status !== "ok") throw new Error("O índice de rastros não está disponível.");
      state.traces = result.testers || [];
    }, options);
  }

  function renderTraces() {
    const header = pageHeading("Rastros dos testadores", "Eventos operacionais costurados por conta para investigar leituras, decisões e ciclos de corrida.");
    if (!state.traces && state.loading.traces) return header + loadingState("Consultando rastros recentes…");
    if (state.errors.traces && !state.traces) return header + `<div class="notice notice--info">${icon("shield")}<span>Este recurso depende da migração de rastros dos testadores e pode ainda não estar publicado.</span></div>${errorState(state.errors.traces, "traces")}`;
    const query = state.traceFilter.trim().toLocaleLowerCase("pt-BR");
    const traces = (state.traces || []).filter((item) => !query || [item.user_email, item.user_id].filter(Boolean).join(" ").toLocaleLowerCase("pt-BR").includes(query)).sort((a, b) => asNumber(b.last_at_ms) - asNumber(a.last_at_ms));
    const totalBatches = (state.traces || []).reduce((sum, item) => sum + asNumber(item.batches), 0);
    const totalBytes = (state.traces || []).reduce((sum, item) => sum + asNumber(item.bytes), 0);
    return header + `<div class="notice notice--info">${icon("shield")}<span>Somente participantes do programa de testes enviam este rastro. O servidor retém os lotes por 30 dias; o índice mostra atividade dos últimos 7 dias.</span></div><section class="metric-grid">${metricCard("Testadores com rastro", count((state.traces || []).length), "Atividade nos últimos 7 dias", "purple", "users")}${metricCard("Lotes recebidos", count(totalBatches), "Blocos costurados por horário", "blue", "database")}${metricCard("Volume recente", bytes(totalBytes), "Texto operacional recebido", "green", "terminal")}${metricCard("Última recepção", state.traces?.length ? relative(Math.max(...state.traces.map((item) => asNumber(item.last_at_ms)))) : "—", "Atualização sob demanda", "yellow", "clock")}</section><div class="trace-toolbar"><label class="search-field">${icon("search")}<input id="trace-search" type="search" value="${esc(state.traceFilter)}" placeholder="Buscar por e-mail ou UUID…"></label></div>${traces.length ? `<div id="trace-results" class="trace-index-list">${traces.map((item) => `<button class="trace-card" data-open-trace="${esc(item.user_id)}"><div class="trace-card-head"><span class="avatar">${esc(initials("", item.user_email || item.user_id))}</span><span class="trace-card-copy"><strong>${esc(item.user_email || "Sem e-mail")}</strong><small>${esc(item.user_id)}</small></span>${icon("chevron-right")}</div><div class="trace-stats"><span class="trace-stat"><strong>${count(item.batches)}</strong><small>lotes em 7 dias</small></span><span class="trace-stat"><strong>${bytes(item.bytes)}</strong><small>volume recebido</small></span></div><span class="cell-secondary" style="margin-top:0.625rem">Último lote ${relative(item.last_at_ms).toLowerCase()}</span></button>`).join("")}</div>` : emptyState("Nenhum rastro recente", "Não há lotes de testadores que correspondam à busca.", "terminal")}`;
  }

  function openTrace(userId, hours = 24) {
    const index = (state.traces || []).find((item) => item.user_id === userId) || { user_id: userId };
    const account = state.accounts.find((item) => item.userId === userId);
    state.detail = { type: "trace", userId, hours, data: null, loading: true, error: null };
    renderTraceDetail(index, account);
    if (!els.detail.open) els.detail.showModal();
    rpc("admin_tester_trace", { p_user_id: userId, p_since_hours: hours }).then((result) => {
      if (result.status !== "ok") throw new Error("O rastro solicitado não está disponível.");
      if (state.detail?.type === "trace" && state.detail.userId === userId) { state.detail.data = result; state.detail.loading = false; renderTraceDetail(index, account); }
    }).catch((error) => { if (state.detail?.type === "trace" && state.detail.userId === userId) { state.detail.error = error.message; state.detail.loading = false; renderTraceDetail(index, account); } });
  }

  function renderTraceDetail(index, account) {
    const detail = state.detail;
    const trace = detail.data;
    els.detailContent.innerHTML = `<header class="detail-top"><button class="icon-button" data-close-detail aria-label="Fechar detalhe">${icon("x")}</button><div class="detail-top-copy"><span class="eyebrow">Rastro de testador</span><h2 id="detail-title">${esc(index.user_email || account?.email || detail.userId)}</h2></div>${account ? `<button class="button button--secondary button--compact" data-open-user="${esc(account.key)}">Abrir conta</button>` : ""}</header><div class="detail-body"><div class="toolbar"><select id="trace-detail-hours" class="toolbar-select"><option value="6"${detail.hours === 6 ? " selected" : ""}>Últimas 6 horas</option><option value="24"${detail.hours === 24 ? " selected" : ""}>Últimas 24 horas</option><option value="72"${detail.hours === 72 ? " selected" : ""}>Últimas 72 horas</option><option value="168"${detail.hours === 168 ? " selected" : ""}>Últimos 7 dias</option></select><button class="button button--secondary button--compact" data-reload-trace="${esc(detail.userId)}">${icon("refresh")} Atualizar</button>${trace?.text ? `<button class="button button--secondary button--compact" data-copy-trace="detail">${icon("copy")} Copiar</button><button class="button button--secondary button--compact" data-download-trace="detail">${icon("download")} Baixar</button>` : ""}</div><div class="notice notice--info">${icon("shield")}<span>Este conteúdo pode conter informações operacionais sensíveis. Use apenas para investigação do programa de testes.</span></div>${detail.loading ? loadingState("Costurando os lotes em ordem cronológica…") : ""}${detail.error ? errorState(detail.error) : ""}${trace ? `<div class="detail-metrics"><div class="detail-metric"><small>Lotes</small><strong>${count(trace.batches)}</strong></div><div class="detail-metric"><small>Bytes descartados</small><strong>${bytes(trace.skipped_bytes)}</strong></div><div class="detail-metric"><small>Intervalo</small><strong>${count(detail.hours)}h</strong></div></div>${trace.text ? `<div class="log-box" style="max-height:calc(100dvh - 16.875rem)"><pre>${esc(trace.text)}</pre></div>` : emptyState("Sem eventos no intervalo", "Nenhum lote foi recebido neste período.", "terminal")}` : ""}</div>`;
  }

  /* Serviços ------------------------------------------------------------- */
  function renderServices() {
    const header = pageHeading("Infraestrutura crítica", "Checagens reais do banco, autenticação, Edge Function e Evolution API. Atualização automática a cada 15 segundos enquanto esta página estiver aberta.");
    if (!state.health && state.loading.health) return header + loadingState("Executando checagens de saúde…");
    if (state.errors.health && !state.health) return header + errorState(state.errors.health, "health");
    if (!state.health) return header;
    const services = normalizedHealthServices();
    const problems = services.filter((service) => !service.ok || service.zombie);
    const overallTitle = problems.length ? `${problems.length} ${problems.length === 1 ? "serviço exige" : "serviços exigem"} atenção` : "Todos os serviços estão operacionais";
    const overallCopy = problems.length ? "Abra os detalhes abaixo antes de executar ações dependentes da infraestrutura." : `Última checagem ${state.health.checked_at ? new Date(state.health.checked_at).toLocaleString("pt-BR") : "agora"}.`;
    return header + `<section class="hero-status" style="${problems.length ? "background:linear-gradient(130deg,rgba(255,107,112,.09),rgba(245,200,75,.035))" : ""}"><span class="hero-status-icon" style="${problems.length ? "background:var(--red-soft);color:var(--red)" : ""}">${icon(problems.length ? "alert" : "heart-pulse")}</span><div class="hero-status-copy"><span class="eyebrow">Estado geral</span><h3>${esc(overallTitle)}</h3><p>${esc(overallCopy)}</p></div><div class="hero-status-actions"><button class="button button--secondary button--compact" data-refresh-resource="health">${icon("refresh")} Verificar agora</button></div></section>
      <section class="service-grid" style="margin-top:0.9375rem">${services.map((service) => `<article class="service-card"><div class="service-card-head"><span class="service-icon" style="${service.ok && !service.zombie ? "background:var(--green-soft);color:var(--green)" : "background:var(--red-soft);color:var(--red)"}">${icon(service.icon)}</span><span class="service-name"><strong>${esc(service.name)}</strong><small>${service.ok && !service.zombie ? "Operacional" : service.zombie ? "Estado zumbi" : "Indisponível"}</small></span>${pill(service.ok && !service.zombie ? "OK" : "Atenção", service.ok && !service.zombie ? "green" : "red")}</div><p class="service-detail">${esc(serviceDescription(service))}</p><div class="info-list" style="margin-top:0.625rem"><div class="info-row"><span>Latência</span><span>${service.latency_ms != null ? `${count(service.latency_ms)} ms` : "Não medida"}</span></div>${service.status_code != null ? `<div class="info-row"><span>HTTP</span><span>${esc(service.status_code)}</span></div>` : ""}${service.instance_name ? `<div class="info-row"><span>Instância</span><span>${esc(service.instance_name)}</span></div>` : ""}</div></article>`).join("")}</section>
      <div class="notice notice--info" style="margin-top:0.9375rem">${icon("activity")}<span>Este painel mostra apenas o estado atual. Ainda não há histórico de uptime persistido pelo backend.</span></div>`;
  }

  /* WhatsApp ------------------------------------------------------------- */
  function connectionState(payload = state.whatsapp) {
    const connection = payload?.connection || {};
    return String(connection.state || connection.instance?.state || connection.instance || connection.status || payload?.connection_state || "unknown").toLowerCase();
  }

  function whatsappConnected(payload = state.whatsapp) {
    return ["open", "connected", "conectado"].some((value) => connectionState(payload).includes(value));
  }

  function loadWhatsapp(options = {}) {
    return loadResource("whatsapp", () => edge("admin_status"), (result) => {
      const previous = state.whatsapp || {};
      state.whatsapp = !whatsappConnected(result) && !result.qr_code && (previous.qr_code || previous.pairing_code)
        ? { ...result, qr_code: previous.qr_code, pairing_code: previous.pairing_code }
        : result;
      if (state.page === "whatsapp" && !whatsappConnected(state.whatsapp) && result.status === "ok") startWhatsappPolling();
    }, options);
  }

  function loadVerification(options = {}) {
    return loadResource("verification", () => edge("admin_metrics"), (result) => {
      if (result.status !== "ok") throw new Error(result.message || "As métricas de verificação não responderam.");
      state.verification = result;
    }, options);
  }

  function startWhatsappPolling() {
    clearInterval(state.timers.whatsapp);
    state.timers.whatsapp = setInterval(async () => {
      if (state.page !== "whatsapp") return clearInterval(state.timers.whatsapp);
      await loadWhatsapp({ quiet: true });
      if (whatsappConnected()) clearInterval(state.timers.whatsapp);
    }, 3000);
  }

  function qrImageSource(value) {
    const text = String(value || "").trim();
    if (/^data:image\/(png|jpe?g|webp);base64,/i.test(text)) return text;
    if (/^(iVBOR|\/9j\/)[A-Za-z0-9+/=\r\n]+$/.test(text)) return `data:image/png;base64,${text.replace(/\s/g, "")}`;
    return null;
  }

  function renderWhatsapp() {
    const header = pageHeading("Conexão e verificações", "Gerencie a instância usada nos códigos de telefone e acompanhe a taxa de sucesso das verificações.");
    if (!state.whatsapp && state.loading.whatsapp) return header + loadingState("Consultando a Evolution API…");
    if (state.errors.whatsapp && !state.whatsapp) return header + errorState(state.errors.whatsapp, "whatsapp");
    const payload = state.whatsapp || {};
    const configured = payload.status !== "not_configured";
    const connected = whatsappConnected(payload);
    const config = payload.config || {};
    // Qual instancia o servidor tem de fato. Quando difere do secret, o painel
    // precisa mostrar a de verdade — foi a divergencia silenciosa entre as
    // duas que deixou a verificacao fora do ar sem ninguem enxergar.
    const instanceInfo = payload.instance || {};
    const qr = qrImageSource(payload.qr_code);
    const statusTitle = !configured ? "Integração não configurada" : connected ? "WhatsApp conectado" : payload.qr_code || payload.pairing_code ? "Aguardando pareamento" : "WhatsApp desconectado";
    const statusCopy = !configured ? "Configure os secrets da Evolution API na Edge Function." : connected ? "A instância está pronta para verificações e comunicados." : "Gere um QR code e faça o pareamento pelo WhatsApp.";
    return header + `<section class="hero-status" style="${connected ? "" : "background:linear-gradient(130deg,rgba(245,200,75,.09),rgba(91,155,255,.035))"}"><span class="hero-status-icon" style="${connected ? "" : "background:var(--yellow-soft);color:var(--yellow)"}">${icon("phone")}</span><div class="hero-status-copy"><span class="eyebrow">Conexão Evolution</span><h3>${esc(statusTitle)}</h3><p>${esc(statusCopy)}</p></div><div class="hero-status-actions">${configured && !connected ? `<button class="button button--primary button--compact" data-whatsapp-action="admin_connect">${icon("refresh")} Gerar pareamento</button>` : ""}${connected ? `<button class="button button--secondary button--compact" data-whatsapp-action="admin_logout">Desconectar</button>` : ""}</div></section>
      ${configured ? `<section class="content-grid" style="margin-top:0.9375rem"><article class="panel"><div class="panel-head"><div><h3 class="section-title">Configuração da instância</h3><p class="section-copy">Segredos completos nunca são exibidos</p></div>${pill(connected ? "Conectado" : "Desconectado", connected ? "green" : "yellow")}</div><div class="info-list"><div class="info-row"><span>Instância</span><span>${esc(instanceInfo.resolved || config.instance_name || "—")}${instanceInfo.adopted ? ` <small style="color:var(--yellow)">secret aponta para ${esc(instanceInfo.configured || "—")}</small>` : ""}</span></div><div class="info-row"><span>Número operador</span><span>${esc(config.owner_number || "—")}</span></div><div class="info-row"><span>Endpoint</span><span>${esc(config.base_url || "—")}</span></div><div class="info-row"><span>Chave</span><span>${esc(config.api_key_masked || "mascarada")}</span></div><div class="info-row"><span>Atualizada</span><span>${esc(config.updated_at ? new Date(config.updated_at).toLocaleString("pt-BR") : "—")}</span></div></div><div class="detail-actions" style="margin-top:0.9375rem"><button class="button button--secondary button--compact" data-whatsapp-action="admin_repair">Reparar sem QR</button><button class="button button--warning-soft button--compact" data-whatsapp-action="admin_reset">Reiniciar pareamento</button><button class="button button--danger-soft button--compact" data-whatsapp-action="admin_force_recreate">Recriar instância</button></div></article>
      <article class="panel"><div class="panel-head"><div><h3 class="section-title">Pareamento</h3><p class="section-copy">Use o WhatsApp do número operador</p></div></div><div class="qr-layout qr-layout--tight"><div class="qr-frame">${qr ? `<img src="${esc(qr)}" alt="QR code para conectar o WhatsApp">` : `<div class="qr-placeholder">${icon("phone")}<p>${connected ? "Instância conectada" : "Gere um novo QR code"}</p></div>`}</div><div><h3 class="section-title">${connected ? "Conexão pronta" : "Abra Aparelhos conectados"}</h3><p class="section-copy">No WhatsApp, acesse Configurações → Aparelhos conectados e leia o código.</p>${payload.pairing_code ? `<span class="pairing-code">${esc(payload.pairing_code)}</span>` : ""}${payload.message ? `<div class="notice" style="margin:0.75rem 0 0"><span>${esc(payload.message)}</span></div>` : ""}</div></div></article></section>` : `<div class="notice notice--warning" style="margin-top:0.9375rem">${icon("alert")}<span>A configuração EVOLUTION_BASE_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE_NAME precisa ser concluída no servidor.</span></div>`}
      <section style="margin-top:0.9375rem">${renderVerificationMetrics()}</section>`;
  }

  function renderVerificationMetrics() {
    const data = state.verification;
    if (!data && state.loading.verification) return `<article class="panel">${loadingState("Carregando métricas de verificação…")}</article>`;
    if (state.errors.verification && !data) return `<article class="panel">${errorState(state.errors.verification, "verification")}</article>`;
    if (!data) return "";
    const period = data.last7d || {};
    const successRate = pct(period.success, period.total);
    const daily = data.daily || [];
    /* Falhas de envio: uma queda do provedor não vira tentativa registrada,
       porque a linha do código só nasce depois do envio dar certo. Sem este
       bloco, a queda fica invisível aqui até um usuário reclamar. */
    const fail = data.failures || {};
    const failFoot = fail.last7d ? `${count(fail.last24h)} nas últimas 24h` : "Nenhuma falha registrada";
    const motivoDaFalha = {
      whatsapp_disconnected: "WhatsApp desconectado",
      instance_missing: "Instância ausente",
      provider_error: "Erro do provedor"
    };
    const failRows = (fail.recent || []).slice(0, 6).map((item) =>
      `<div class="activity-item"><span class="activity-icon">${icon("alert")}</span><span class="activity-copy"><strong>${esc(item.phone_masked || "Número protegido")}</strong><small>${item.created_at ? new Date(item.created_at).toLocaleString("pt-BR") : "—"}</small></span>${pill(motivoDaFalha[item.reason] || item.reason || "Falha", "red")}</div>`
    ).join("");
    const ultimaRecuperacao = (data.recovery?.recent || [])[0];
    return `<div class="panel-head"><div><h3 class="section-title">Verificações de telefone</h3><p class="section-copy">Tentativas e desfechos dos últimos 7 dias</p></div></div><div class="metric-grid">${metricCard("Tentativas · 7 dias", count(period.total), `${count(data.last24h?.total)} nas últimas 24h`, "blue", "phone")}${metricCard("Concluídas", count(period.success), `${successRate}% de sucesso`, "green", "check-circle")}${metricCard("Expiradas", count(period.expired), "Código não utilizado", period.expired ? "yellow" : "blue", "clock")}${metricCard("Pendentes", count(period.pending), "Ainda dentro do prazo", "purple", "activity")}${metricCard("Falhas de envio", count(fail.last7d), failFoot, fail.last7d ? "red" : "blue", "alert")}</div><section class="content-grid"><article class="panel"><div class="panel-head"><div><h3 class="section-title">Volume diário</h3><p class="section-copy">Tentativas nos últimos 7 dias</p></div></div>${daily.length ? miniColumns(daily.map((item) => item.total), daily.map((item) => new Date(`${item.date}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short" })), "var(--blue)") : '<div class="notice"><span>Sem série diária disponível.</span></div>'}</article><article class="panel"><div class="panel-head"><div><h3 class="section-title">Tentativas recentes</h3><p class="section-copy">Uma linha por número, com máscara de privacidade</p></div></div><div class="activity-list">${(data.recent || []).slice(0, 8).map((item) => { const outcome = item.outcome || (item.used_at ? "success" : new Date(item.expires_at) < new Date() ? "expired" : "pending"); const status = outcome === "success" ? ["Concluída", "green"] : outcome === "expired" ? ["Expirada", "yellow"] : ["Pendente", "purple"]; return `<div class="activity-item"><span class="activity-icon">${icon("phone")}</span><span class="activity-copy"><strong>${esc(item.phone_masked || "Número protegido")}</strong><small>${item.created_at ? new Date(item.created_at).toLocaleString("pt-BR") : "—"}</small></span>${pill(status[0], status[1])}</div>`; }).join("") || '<div class="notice"><span>Sem tentativas recentes.</span></div>'}</div></article>${failRows ? `<article class="panel"><div class="panel-head"><div><h3 class="section-title">Falhas de envio</h3><p class="section-copy">${ultimaRecuperacao ? `Última recuperação: ${esc(ultimaRecuperacao.action === "railway_redeploy" ? "reinício do container" : "reinício da instância")} em ${new Date(ultimaRecuperacao.created_at).toLocaleString("pt-BR")}` : "Quando o provedor não entregou o código"}</p></div>${pill(`${count(fail.last24h)} em 24h`, fail.last24h ? "red" : "green")}</div><div class="activity-list">${failRows}</div></article>` : ""}</section>`;
  }

  async function whatsappAction(action) {
    const config = {
      admin_connect: ["Gerando pareamento", false],
      admin_logout: ["Desconectar o WhatsApp?", true],
      admin_reset: ["Reiniciar o pareamento?", true],
      admin_force_recreate: ["Recriar a instância?", true],
      admin_repair: ["Reparando a conexão", false]
    }[action];
    if (config?.[1]) {
      const messages = {
        admin_logout: "A verificação de telefones e os comunicados ficarão indisponíveis até um novo pareamento.",
        admin_reset: "A sessão atual será encerrada e um novo QR code será solicitado.",
        admin_force_recreate: "A instância será apagada no servidor e criada do zero. Use apenas para corrigir um estado zumbi."
      };
      if (!await askConfirm({ title: config[0], message: messages[action], label: action === "admin_force_recreate" ? "Recriar instância" : "Continuar", danger: action === "admin_force_recreate" })) return;
    }
    state.loading.whatsapp = true; renderCurrentPage();
    try {
      const result = await edge(action);
      if (result.status !== "ok") throw new Error(result.message || `A operação retornou “${result.status}”.`);
      if (action === "admin_repair") {
        // O reparo devolve o laudo da sondagem, não o payload de status —
        // recarrega a tela em vez de sobrescrever o que está nela.
        const redeploy = result.redeploy;
        const detalhe = redeploy?.ok
          ? "O container do Evolution está reiniciando. Tente de novo em cerca de um minuto."
          : redeploy?.skipped === "cooldown"
            ? "Um reinício do container foi disparado há pouco. Aguarde alguns minutos."
            : redeploy?.skipped === "not_configured"
              ? "Reinício automático do container não configurado."
              : result.instance?.adopted ? `Instância em uso: ${result.instance.resolved}` : (result.probe?.error || "");
        toast(
          result.healthy ? "Conexão restabelecida" : redeploy?.ok ? "Reiniciando o container do Evolution" : "Reparo tentado, socket ainda fechado",
          result.healthy || redeploy?.ok ? "success" : "error",
          detalhe
        );
        await loadWhatsapp({ quiet: true });
        return;
      }
      state.whatsapp = result;
      toast(action === "admin_connect" ? "Pareamento gerado" : "Conexão atualizada");
      if (!whatsappConnected(result)) startWhatsappPolling();
      setTimeout(() => loadWhatsapp({ quiet: true }), 1200);
    } catch (error) { toast("Falha ao gerenciar o WhatsApp", "error", error.message); }
    finally { state.loading.whatsapp = false; renderCurrentPage(); }
  }

  /* Comunicados ---------------------------------------------------------- */
  function loadRecipients(options = {}) {
    return loadResource("recipients", () => edge("admin_broadcast_recipients"), (result) => {
      if (result.status !== "ok") throw new Error(result.message || "Não foi possível consultar os destinatários.");
      state.broadcast.recipients = [...new Set(result.phones || [])];
    }, options);
  }

  function manualRecipients() {
    const values = state.broadcast.manual.split(/[\n,;]+/).map((value) => value.replace(/\D/g, "")).filter((value) => value.length >= 10 && value.length <= 15);
    return [...new Set(values)];
  }

  function onlyDigits(value) { return String(value ?? "").replace(/\D/g, ""); }

  function plural(n, singular, plural_) { return `${count(n)} ${asNumber(n) === 1 ? singular : plural_}`; }

  /* O DDD serve de "inicial" do número na lista, como as iniciais do nome
     fazem nas outras telas. */
  function phoneDdd(raw) {
    const digits = onlyDigits(raw);
    const local = digits.startsWith("55") ? digits.slice(2) : digits;
    return local.slice(0, 2) || "??";
  }

  /* 5511987654321 -> +55 (11) 98765-4321. Fora do formato brasileiro, mostra os
     dígitos como vieram: inventar uma máscara esconderia um número torto. */
  function phoneLabel(raw) {
    const digits = onlyDigits(raw);
    const local = digits.startsWith("55") ? digits.slice(2) : digits;
    if (local.length === 11) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
    if (local.length === 10) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
    return `+${digits}`;
  }

  /* Estado de um número no disparo atual. "Enviado" quer dizer aceito pelo
     servidor do WhatsApp — não é confirmação de leitura, e a tela diz isso. */
  function deliveryFor(phone) {
    const b = state.broadcast;
    const hit = b.results.find((item) => onlyDigits(item.phone) === onlyDigits(phone));
    if (hit) {
      return hit.status === "sent"
        ? { key: "sent", label: "Enviado", iconName: "check-double", tone: "is-sent" }
        : { key: "failed", label: hit.error || "Falhou", iconName: "alert", tone: "is-failed" };
    }
    if (b.sending) return { key: "pending", label: "Na fila", iconName: "clock", tone: "" };
    return { key: "draft", label: "Vai receber este comunicado", iconName: "", tone: "" };
  }

  function renderBroadcast() {
    const b = state.broadcast;
    const recipients = selectedRecipients();
    const connected = whatsappConnected();
    const header = pageHeading(
      "Comunicados",
      "Funciona como um mensageiro: escolha quem recebe na lista, escreva no campo embaixo e dispare. Cada pessoa recebe uma mensagem individual, não um grupo."
    );
    const aviso = connected ? "" : `<div class="notice notice--warning">${icon("alert")}<span><strong>WhatsApp não confirmado como operacional.</strong> Verifique a conexão antes de enviar qualquer comunicado. <button class="text-button" data-nav="whatsapp" style="margin-left:0.3125rem">Abrir WhatsApp</button></span></div>`;
    return header + aviso + renderBroadcastToolbar() + `<section class="chat-shell">${renderBroadcastSide(recipients)}${renderBroadcastChat(recipients, connected)}</section>`;
  }

  /* Anexos --------------------------------------------------------------
     O arquivo sobe uma única vez para o bucket `broadcast-media` e o disparo
     manda só a URL. Assim os mesmos bytes não são reenviados a cada lote de
     cinco números, e a chamada continua pequena. */
  const MEDIA_BUCKET = "broadcast-media";
  const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
  const MEDIA_TYPES = {
    "image/jpeg": "image", "image/png": "image", "image/webp": "image",
    "application/pdf": "document"
  };
  /* Com anexo o texto vira legenda, e o WhatsApp corta legendas longas. */
  const CAPTION_MAX = 1024;

  function messageLimit() { return state.broadcast.media ? CAPTION_MAX : 4096; }

  async function uploadBroadcastMedia(file) {
    const b = state.broadcast;
    const mediatype = MEDIA_TYPES[file.type];
    if (!mediatype) return toast("Formato não aceito", "error", "Use JPG, PNG, WebP ou PDF.");
    if (file.size > MEDIA_MAX_BYTES) return toast("Arquivo grande demais", "error", `O limite é ${bytes(MEDIA_MAX_BYTES)}.`);

    b.uploading = true; renderCurrentPage();
    try {
      if (!state.session?.accessToken) throw new Error("Sessão administrativa ausente.");
      if (state.session.expiresAt && state.session.expiresAt - Date.now() < 30_000 && state.session.refreshToken) {
        await refreshSession();
      }
      const limpo = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(-60);
      const caminho = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${limpo}`;
      const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${encodeURIComponent(caminho)}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${state.session.accessToken}`,
          "Content-Type": file.type,
          "x-upsert": "false"
        },
        body: file
      });
      if (!response.ok) {
        const detalhe = await response.json().catch(() => ({}));
        throw new Error(detalhe.message || detalhe.error || `O servidor recusou o arquivo (${response.status}).`);
      }
      b.media = {
        path: caminho,
        url: `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${encodeURIComponent(caminho)}`,
        mimetype: file.type,
        filename: file.name.slice(0, 120),
        mediatype,
        size: file.size
      };
      /* A legenda é mais curta que a mensagem solta. Nada é cortado por conta
         própria: o envio fica bloqueado até o texto caber. */
      if (b.message.length > CAPTION_MAX) {
        toast("O texto não cabe na legenda", "error", `Com anexo cabem ${count(CAPTION_MAX)} caracteres; encurte para poder enviar.`);
      }
      toast("Anexo pronto", "success", file.name);
    } catch (error) {
      toast("Não foi possível anexar", "error", error.message);
    } finally {
      b.uploading = false;
      renderCurrentPage();
    }
  }

  async function removeBroadcastMedia() {
    const media = state.broadcast.media;
    state.broadcast.media = null;
    renderCurrentPage();
    if (!media?.path) return;
    /* Melhor esforço: se a remoção falhar, o arquivo fica órfão no bucket, mas
       não vai para ninguém — o disparo já não o referencia. */
    try {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${encodeURIComponent(media.path)}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${state.session?.accessToken}` }
      });
    } catch { /* silencioso de propósito */ }
  }

  function renderMediaChip(media, { removivel = false } = {}) {
    if (!media) return "";
    const imagem = media.mediatype === "image";
    return `<div class="media-chip">
      ${imagem
        ? `<img class="media-thumb" src="${esc(media.url)}" alt="Prévia do anexo">`
        : `<span class="media-thumb media-thumb--doc">${icon("package")}</span>`}
      <span class="media-copy"><strong>${esc(media.filename)}</strong><small>${esc(bytes(media.size))} · ${imagem ? "imagem" : "documento"}</small></span>
      ${removivel ? `<button class="icon-button" data-remove-media aria-label="Remover anexo">${icon("x")}</button>` : ""}
    </div>`;
  }

  /* Seleção de destinatários --------------------------------------------
     A lista de números verificados vem da Edge Function e continua sendo o
     limite do que dá para alcançar. O que muda aqui é o cruzamento: cada
     número ganha a conta correspondente, e com ela licença, atividade,
     programa de testes e versão instalada — que é o que permite segmentar. */
  const BROADCAST_LISTS_KEY = "gain_admin_broadcast_lists_v1";

  const SEGMENTS = [
    ["all", "Todos os verificados"],
    ["tester", "Testadores"],
    ["expiring", "Licença vence em até 7 dias"],
    ["expired", "Sem acesso ativo"],
    ["active", "Licença em dia"],
    ["lifetime", "Licença vitalícia"],
    ["outdated", "App desatualizado"],
    ["inactive", "Sem atividade há 30 dias"]
  ];

  /* Contas atrasadas, quando o resumo de versões já foi carregado. Sem ele o
     segmento fica indisponível em vez de devolver uma lista vazia mentirosa. */
  function outdatedUserIds() {
    if (!state.versions) return null;
    const ids = new Set();
    versionOverview().outdated.forEach((item) => { if (item.user_id) ids.add(item.user_id); });
    return ids;
  }

  function broadcastCandidates() {
    const contas = new Map();
    state.accounts.forEach((account) => {
      const digits = onlyDigits(account.phone);
      if (digits && !contas.has(digits)) contas.set(digits, account);
    });
    return [...new Set((state.broadcast.recipients || []).map(onlyDigits))]
      .filter(Boolean)
      .map((phone) => ({ phone, account: contas.get(phone) || null }));
  }

  function matchesSegment(candidate, segment, atrasados) {
    const account = candidate.account;
    if (segment === "all") return true;
    if (!account) return false;
    const license = licenseState(account.expiry, account.lifetime);
    const idade = account.lastSeen ? (state.serverNow || state.now) - account.lastSeen : Infinity;
    if (segment === "tester") return account.isTester;
    if (segment === "expiring") return license.key === "expiring";
    if (segment === "expired") return ["expired", "none"].includes(license.key);
    if (segment === "active") return license.key === "active";
    if (segment === "lifetime") return license.key === "lifetime";
    if (segment === "outdated") return Boolean(atrasados && account.userId && atrasados.has(account.userId));
    if (segment === "inactive") return idade > 30 * DAY_MS;
    return true;
  }

  /* O segmento define o público; a busca só ajuda a achar alguém dentro dele. */
  function segmentCandidates() {
    const b = state.broadcast;
    const atrasados = outdatedUserIds();
    return broadcastCandidates().filter((candidate) => {
      if (!b.includeInternal && candidate.account?.isInternal) return false;
      return matchesSegment(candidate, b.segment, atrasados);
    });
  }

  function visibleCandidates() {
    const query = state.broadcast.search.trim().toLocaleLowerCase("pt-BR");
    const lista = segmentCandidates();
    if (!query) return lista;
    const digits = onlyDigits(query);
    return lista.filter(({ phone, account }) => {
      if (digits && phone.includes(digits)) return true;
      const texto = [account?.name, account?.email].filter(Boolean).join(" ").toLocaleLowerCase("pt-BR");
      return texto.includes(query);
    });
  }

  /* Trocar de segmento redefine o público — é essa a intenção de escolher um. */
  function selectSegment(segment) {
    state.broadcast.segment = segment;
    state.broadcast.selected = new Set(segmentCandidates().map((c) => c.phone));
  }

  function ensureSelection() {
    const b = state.broadcast;
    /* Antes da lista de verificados chegar não há o que memorizar: fixar um
       conjunto vazio agora deixaria a seleção presa em zero para sempre. */
    if (!b.selected && (b.recipients || []).length) b.selected = new Set(segmentCandidates().map((c) => c.phone));
    return b.selected || new Set();
  }

  function selectedRecipients() {
    if (state.broadcast.mode === "manual") return manualRecipients();
    const validos = new Set(broadcastCandidates().map((c) => c.phone));
    return [...ensureSelection()].filter((phone) => validos.has(phone));
  }

  /* Listas salvas: ficam neste navegador, porque o servidor não guarda
     campanhas nem públicos. A tela diz isso em voz alta. */
  function savedLists() {
    try {
      const bruto = JSON.parse(localStorage.getItem(BROADCAST_LISTS_KEY) || "[]");
      return Array.isArray(bruto) ? bruto.filter((item) => item && item.name && Array.isArray(item.phones)) : [];
    } catch { return []; }
  }

  function storeLists(lists) {
    try {
      localStorage.setItem(BROADCAST_LISTS_KEY, JSON.stringify(lists.slice(0, 40)));
      return true;
    } catch {
      toast("Não foi possível salvar a lista", "error", "O navegador bloqueou o armazenamento local.");
      return false;
    }
  }

  async function saveCurrentList() {
    const phones = selectedRecipients();
    if (!phones.length) return toast("Nada para salvar", "error", "Selecione ao menos um destinatário.");
    const nome = await askText({
      title: "Salvar lista personalizada",
      message: `Guarda os ${count(phones.length)} destinatários selecionados agora, para reutilizar depois.`,
      placeholder: "Ex.: testadores ativos",
      label: "Salvar lista"
    });
    if (!nome) return;
    const lists = savedLists().filter((item) => item.name !== nome);
    lists.unshift({ name: nome, phones, savedAt: Date.now() });
    if (storeLists(lists)) {
      state.broadcast.lists = lists;
      toast("Lista salva", "success", `${nome} · ${plural(phones.length, "número guardado", "números guardados")} neste navegador.`);
      renderCurrentPage();
    }
  }

  function applyList(name) {
    const lista = savedLists().find((item) => item.name === name);
    if (!lista) return;
    const validos = new Set(broadcastCandidates().map((c) => c.phone));
    const presentes = lista.phones.map(onlyDigits).filter((phone) => validos.has(phone));
    const perdidos = lista.phones.length - presentes.length;
    state.broadcast.mode = "base";
    state.broadcast.segment = "all";
    state.broadcast.search = "";
    state.broadcast.selected = new Set(presentes);
    renderCurrentPage();
    toast(`Lista "${name}" aplicada`, perdidos ? "error" : "success",
      perdidos ? `${plural(perdidos, "número não está mais verificado", "números não estão mais verificados")} e ficaram de fora.` : `${plural(presentes.length, "destinatário selecionado", "destinatários selecionados")}.`);
  }

  async function deleteList(name) {
    if (!await askConfirm({ title: `Apagar a lista "${name}"?`, message: "Ela some deste navegador. Os destinatários continuam existindo.", label: "Apagar", danger: true })) return;
    const lists = savedLists().filter((item) => item.name !== name);
    if (storeLists(lists)) { state.broadcast.lists = lists; renderCurrentPage(); }
  }

  /* A barra tem duas faixas com papéis distintos: em cima se define QUEM é o
     público; embaixo, o que fazer com a seleção resultante. Misturar as duas
     coisas numa linha só era o que deixava a tela difícil de ler. */
  function renderBroadcastToolbar() {
    const b = state.broadcast;
    const manual = b.mode === "manual";
    const semVersoes = !state.versions;

    const origem = `<div class="mode-toggle">
      <button data-broadcast-mode="base" aria-pressed="${!manual}">Da base</button>
      <button data-broadcast-mode="manual" aria-pressed="${manual}">Lista manual</button>
    </div>`;

    const filtros = manual
      ? `<p class="toolbar-hint">Os números vão na coluna ao lado — só os válidos entram na conta.</p>`
      : `<select id="broadcast-segment" class="toolbar-select" aria-label="Segmento de destinatários">
          ${SEGMENTS.map(([value, label]) => `<option value="${value}"${b.segment === value ? " selected" : ""}${value === "outdated" && semVersoes ? " disabled" : ""}>${esc(label)}${value === "outdated" && semVersoes ? " (indisponível)" : ""}</option>`).join("")}
        </select>
        <label class="search-field">${icon("search")}<input id="broadcast-search" type="search" value="${esc(b.search)}" placeholder="Achar por nome, e-mail ou número…" aria-label="Procurar destinatário"></label>
        <button class="filter-chip" data-toggle-internal aria-pressed="${b.includeInternal}">Contas internas</button>`;

    if (manual) {
      return `<section class="broadcast-toolbar"><div class="toolbar-row">
        <span class="toolbar-label">Público</span>${origem}${filtros}
      </div></section>`;
    }

    const listas = b.lists.length
      ? b.lists.map((item) => `<span class="saved-list">
          <button data-load-list="${esc(item.name)}" title="Aplicar esta lista">${esc(item.name)} <small>${count(item.phones.length)}</small></button>
          <button class="saved-list-x" data-delete-list="${esc(item.name)}" aria-label="Apagar a lista ${esc(item.name)}">${icon("x")}</button>
        </span>`).join("")
      : `<span class="toolbar-hint">Nenhuma lista salva ainda.</span>`;

    return `<section class="broadcast-toolbar">
      <div class="toolbar-row">
        <span class="toolbar-label">Público</span>${origem}${filtros}
      </div>
      <div class="toolbar-row">
        <span class="toolbar-label">Seleção</span>
        <button class="button button--secondary button--compact" data-select-all>${icon("check")} Marcar todos</button>
        <button class="button button--secondary button--compact" data-select-none>${icon("x")} Desmarcar</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <span class="toolbar-label">Listas</span>
        ${listas}
        <button class="button button--secondary button--compact" data-save-list ${selectedRecipients().length ? "" : "disabled"} title="Guardar esta seleção como uma lista reutilizável">${icon("bookmark")} Salvar seleção</button>
      </div>
    </section>`;
  }

  function renderBroadcastSide(recipients) {
    const b = state.broadcast;
    const manual = b.mode === "manual";
    const carregando = state.loading.recipients && !manual;

    const head = `<div class="chat-side-head">
      <h3 class="section-title">Quem recebe</h3>
      ${manual ? "" : `<span id="bulk-summary" class="chat-side-bulk">${broadcastBulkLabel()}</span>`}
    </div>`;

    const corpo = manual
      ? `<div class="chat-side-compose">
          <label class="field-label" for="broadcast-manual">Um número por linha, com DDD</label>
          <textarea id="broadcast-manual" placeholder="5511999999999&#10;5511888888888">${esc(b.manual)}</textarea>
          <p class="section-copy" style="margin:0.5rem 0 0.75rem">Espaços e pontuação são ignorados. Repetidos contam uma vez só.</p>
        </div>
        <div id="recipient-list" class="chat-side-list">${renderManualRows(manualRecipients())}</div>`
      : `<div id="recipient-list" class="chat-side-list">${carregando ? loadingState("Consultando quem está verificado…") : renderCandidateRows(visibleCandidates(), segmentCandidates())}</div>`;

    const erro = state.errors.recipients && !manual
      ? `<div class="notice notice--danger" style="margin:0 0.9375rem 0.75rem">${icon("alert")}<span>${esc(state.errors.recipients)}</span></div>`
      : "";

    const lotes = Math.ceil(recipients.length / 5);
    return `<aside class="chat-side">${head}${corpo}${erro}<div class="chat-side-foot">
      <span><strong id="recipient-count">${count(recipients.length)}</strong><small id="recipient-label">${recipients.length === 1 ? "destinatário" : "destinatários"} · <span id="batch-count">${count(lotes)}</span> ${lotes === 1 ? "lote" : "lotes"} de até 5</small></span>
      ${manual ? "" : `<button class="button button--secondary button--compact" data-refresh-resource="recipients">${icon("refresh")} Atualizar</button>`}
    </div></aside>`;
  }

  function renderManualRows(phones) {
    if (!phones.length) return `<p class="chat-side-empty">Escreva os números acima. Eles aparecem aqui conforme ficam válidos.</p>`;
    return phones.map((phone) => {
      const entrega = deliveryFor(phone);
      return `<div class="recipient-row is-static">
        <span class="avatar">${esc(phoneDdd(phone))}</span>
        <span class="recipient-copy"><strong>${esc(phoneLabel(phone))}</strong><small>${esc(entrega.label)}</small></span>
        ${entrega.iconName ? icon(entrega.iconName, `icon ${entrega.tone}`) : ""}
      </div>`;
    }).join("");
  }

  function broadcastBulkLabel() {
    const selecionados = ensureSelection();
    const noSegmento = segmentCandidates();
    const visiveis = visibleCandidates();
    const extra = visiveis.length !== noSegmento.length ? ` · mostrando ${count(visiveis.length)}` : "";
    return `${count(selecionados.size)} de ${count(noSegmento.length)} selecionados${extra}`;
  }

  function renderCandidateRows(visiveis, noSegmento) {
    const b = state.broadcast;
    const selecionados = ensureSelection();
    if (!noSegmento.length) {
      return `<p class="chat-side-empty">${b.segment === "all"
        ? "Nenhum número concluiu a verificação por WhatsApp ainda."
        : "Nenhum número verificado se encaixa neste segmento."}</p>`;
    }
    if (!visiveis.length) return `<p class="chat-side-empty">Nenhum resultado para a busca. A seleção continua com ${count(selecionados.size)} destinatários.</p>`;
    return visiveis.slice(0, 300).map(({ phone, account }) => {
      const entrega = deliveryFor(phone);
      const marcado = selecionados.has(phone);
      const license = account ? licenseState(account.expiry, account.lifetime) : null;
      const titulo = account?.name || account?.email || "Sem conta vinculada";
      const apoio = b.results.length || b.sending
        ? entrega.label
        : `${phoneLabel(phone)}${account?.lastSeen ? ` · ${relative(account.lastSeen).toLowerCase()}` : ""}`;
      return `<label class="recipient-row${marcado ? " is-picked" : ""}">
        <input type="checkbox" data-phone="${esc(phone)}"${marcado ? " checked" : ""}${b.sending ? " disabled" : ""} aria-label="Incluir ${esc(phoneLabel(phone))}">
        <span class="avatar">${esc(account ? initials(account.name, account.email) : phoneDdd(phone))}</span>
        <span class="recipient-copy"><strong>${esc(titulo)}</strong><small>${esc(apoio)}</small></span>
        ${entrega.iconName
          ? icon(entrega.iconName, `icon ${entrega.tone}`)
          : (license ? `<span class="status-pill pill-${license.tone}">${esc(license.label)}</span>` : `<span class="tag">sem conta</span>`)}
      </label>`;
    }).join("") + (visiveis.length > 300 ? `<p class="chat-side-empty">…e mais ${count(visiveis.length - 300)}. A lista mostra 300 por vez; a seleção continua valendo por inteiro.</p>` : "");
  }

  function renderBroadcastChat(recipients, connected) {
    const b = state.broadcast;
    const texto = b.message.trim();
    const enviados = b.results.filter((item) => item.status === "sent").length;
    const falhas = b.results.filter((item) => item.status !== "sent").length;
    const relogio = (ms) => new Date(ms || Date.now()).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const hora = relogio();
    const horaEnvio = relogio(b.sentAt);

    const selo = b.sending
      ? `${icon("loader", "icon spin")}`
      : b.results.length
        ? `${icon(falhas ? "alert" : "check-double", `icon ${falhas ? "is-failed" : "is-sent"}`)}`
        : `${icon("clock")}`;

    /* Duas bolhas, como em qualquer mensageiro: em cima o que já foi disparado,
       com o estado da entrega; embaixo o rascunho que ainda está no campo. */
    const enviada = (b.sentMessage || b.sentMedia)
      ? `<div class="chat-bubble">${renderMediaChip(b.sentMedia)}${esc(b.sentMessage)}<span class="bubble-meta">${esc(horaEnvio)} ${selo}</span></div>${b.sending || b.results.length ? renderBroadcastProgress() : ""}`
      : "";
    const vazio = !texto && !b.media;
    const rascunho = `<div id="message-preview" class="chat-bubble${vazio ? " chat-bubble--vazia" : ""}">${renderMediaChip(b.media)}<span id="message-preview-text">${texto ? esc(b.message) : (vazio ? (b.sentMessage || b.sentMedia ? "Escreva outro comunicado para disparar de novo." : "O texto que você escrever aparece aqui, do jeito que chega no WhatsApp.") : "")}</span><span id="message-preview-meta" class="bubble-meta"${vazio ? " hidden" : ""}>${hora} ${icon("clock")}</span></div>`;
    const bolha = enviada + rascunho;

    const enviavel = !b.sending && !b.uploading && (Boolean(texto) || Boolean(b.media)) && texto.length <= messageLimit() && recipients.length > 0 && connected;

    return `<article class="chat-main">
      <header class="chat-top">
        <span class="chat-top-avatar">${icon("users")}</span>
        <span class="chat-top-copy">
          <strong>${count(recipients.length)} ${recipients.length === 1 ? "destinatário" : "destinatários"}</strong>
          <small>${b.mode === "manual" ? "Lista manual" : esc((SEGMENTS.find(([v]) => v === b.segment) || [, "Verificados"])[1])} · WhatsApp${connected ? "" : " · desconectado"}</small>
        </span>
        ${b.results.length ? pill(falhas ? `${plural(enviados, "enviado", "enviados")} · ${plural(falhas, "falhou", "falharam")}` : plural(enviados, "enviado", "enviados"), falhas ? "yellow" : "green") : ""}
      </header>

      <div id="chat-canvas" class="chat-canvas">
        <p class="chat-note">Mensagem <strong>individual</strong> para cada número, em lotes de cinco. Tique = servidor aceitou, não é confirmação de leitura. <strong>Respostas não chegam aqui</strong>, e sair da página durante o disparo interrompe os lotes restantes.</p>
        ${bolha}
      </div>

      <footer class="chat-composer">
        ${b.media ? `<div class="composer-attachment">${renderMediaChip(b.media, { removivel: true })}</div>` : ""}
        <div class="composer-line">
          <input id="broadcast-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden>
          <button class="icon-button composer-attach" data-attach-media ${b.sending || b.uploading ? "disabled" : ""} aria-label="Anexar imagem ou PDF" title="Anexar imagem ou PDF (até 8 MB)">
            ${b.uploading ? icon("loader", "icon spin") : icon("paperclip")}
          </button>
          <div class="chat-composer-field">
            <textarea id="broadcast-message" maxlength="${messageLimit()}" rows="1" placeholder="${b.media ? "Escreva a legenda (opcional)…" : "Escreva o comunicado…"}" aria-label="Texto do comunicado">${esc(b.message)}</textarea>
            <div class="chat-composer-hint">
              <span>Ctrl + Enter envia · Enter quebra linha${b.media ? " · com anexo o texto vira legenda" : ""}</span>
              <span id="broadcast-counter">${count(b.message.length)} / ${count(messageLimit())}</span>
            </div>
          </div>
          <button id="broadcast-send" class="send-fab" data-send-broadcast ${enviavel ? "" : "disabled"} aria-label="Enviar comunicado" title="Enviar comunicado">
            ${b.sending ? icon("loader", "icon spin") : icon("send")}
          </button>
        </div>
      </footer>
    </article>`;
  }

  function renderBroadcastProgress() {
    const b = state.broadcast;
    const falhas = b.results.filter((item) => item.status !== "sent").length;
    const progress = pct(b.sent, b.total);
    return `<div class="chat-progress">
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="progress-copy"><span>${count(b.sent)} de ${count(b.total)} processados</span><span>${progress}%</span></div>
      ${falhas ? `<button class="button button--secondary button--compact" style="margin-top:0.5rem" data-download-broadcast-failures>${icon("download")} Baixar falhas</button>` : ""}
    </div>`;
  }

  /* A conversa acompanha o que chega, como em qualquer mensageiro. */
  function stickChatToBottom() {
    const canvas = $("chat-canvas");
    if (canvas) canvas.scrollTop = canvas.scrollHeight;
  }

  /* O campo cresce com o texto até o teto definido no CSS. */
  function growComposer(node) {
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }

  /* Atualizações cirúrgicas: redesenhar a página inteira tiraria o foco de
     quem está escrevendo. */
  function syncBroadcastComposer() {
    const b = state.broadcast;
    const recipients = selectedRecipients();
    const texto = b.message.trim();
    const preview = $("message-preview");
    const previewText = $("message-preview-text");
    if (previewText) previewText.textContent = texto || "O texto que você escrever aparece aqui, do jeito que chega no WhatsApp.";
    if (preview) preview.classList.toggle("chat-bubble--vazia", !texto);
    const previewMeta = $("message-preview-meta");
    if (previewMeta) previewMeta.hidden = !texto;
    const counter = $("broadcast-counter");
    if (counter) counter.textContent = `${count(b.message.length)} / ${count(messageLimit())}`;
    const send = $("broadcast-send");
    if (send) send.disabled = b.sending || b.uploading || (!texto && !b.media) || b.message.trim().length > messageLimit() || !recipients.length || !whatsappConnected();
  }

  function syncBroadcastRecipients() {
    const recipients = selectedRecipients();
    const lotes = Math.ceil(recipients.length / 5);
    const total = $("recipient-count");
    if (total) total.textContent = count(recipients.length);
    const lote = $("batch-count");
    if (lote) lote.textContent = count(lotes);
    const lista = $("recipient-list");
    if (lista && state.broadcast.mode === "manual") lista.innerHTML = renderManualRows(recipients);
    const resumo = $("bulk-summary");
    if (resumo) resumo.textContent = broadcastBulkLabel();
    const salvar = document.querySelector("[data-save-list]");
    if (salvar) salvar.disabled = !recipients.length;
    syncBroadcastComposer();
  }

  async function sendBroadcast() {
    const b = state.broadcast;
    const recipients = selectedRecipients();
    const message = b.message.trim();
    const media = b.media;
    if ((!message && !media) || message.length > messageLimit() || !recipients.length || b.sending) return;
    if (!whatsappConnected()) return toast("WhatsApp desconectado", "error", "Confirme a conexão antes de iniciar o envio.");
    if (!await askConfirm({
      title: `Enviar para ${plural(recipients.length, "número", "números")}?`,
      message: `O envio começa imediatamente e não pode ser desfeito. Os números serão processados em lotes de cinco.${media ? ` Vai junto o anexo ${media.filename}.` : ""}`,
      label: "Iniciar envio", danger: true,
      extra: message ? `<code>${esc(message.slice(0, 240))}${message.length > 240 ? "…" : ""}</code>` : ""
    })) return;
    b.sending = true; b.sent = 0; b.total = recipients.length; b.results = [];
    b.sentMessage = message; b.sentMedia = media; b.sentAt = Date.now();
    renderCurrentPage();
    try {
      for (let offset = 0; offset < recipients.length; offset += 5) {
        const batch = recipients.slice(offset, offset + 5);
        const result = await edge("admin_broadcast_send", { numbers: batch, message, media: media ? { url: media.url, mimetype: media.mimetype, filename: media.filename } : undefined });
        if (result.status !== "ok") throw new Error(result.message || `Lote ${Math.floor(offset / 5) + 1} recusado pelo servidor.`);
        b.results.push(...(result.results || []));
        b.sent += batch.length;
        if (state.page === "broadcast") renderCurrentPage();
        if (offset + 5 < recipients.length) await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const failed = b.results.filter((item) => item.status !== "sent").length;
      b.message = ""; b.media = null;
      toast(failed ? "Envio concluído com falhas" : "Comunicado enviado", failed ? "error" : "success", failed ? `${plural(failed, "número não recebeu", "números não receberam")} a mensagem.` : `${plural(recipients.length, "número processado", "números processados")}.`);
    } catch (error) {
      toast("O envio foi interrompido", "error", error.message);
    } finally {
      b.sending = false; renderCurrentPage();
    }
  }

  /* Confirmações --------------------------------------------------------- */
  function askConfirm({ title, message, label = "Confirmar", danger = false, extra = "" }) {
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    $("confirm-extra").innerHTML = extra;
    const action = $("confirm-action");
    action.textContent = label;
    action.className = `button ${danger ? "button--danger" : "button--primary"}`;
    $("confirm-icon").style.background = danger ? "var(--red-soft)" : "var(--green-soft)";
    $("confirm-icon").style.color = danger ? "var(--red)" : "var(--green)";
    els.confirm.returnValue = "cancel";
    els.confirm.showModal();
    return new Promise((resolve) => {
      const onClose = () => { els.confirm.removeEventListener("close", onClose); resolve(els.confirm.returnValue === "confirm"); };
      els.confirm.addEventListener("close", onClose);
    });
  }

  function askText({ title, message, label = "Salvar", placeholder = "", value = "" }) {
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    $("confirm-extra").innerHTML = `<input id="confirm-text" type="text" maxlength="40" placeholder="${esc(placeholder)}" value="${esc(value)}" style="margin-top:0.75rem">`;
    const action = $("confirm-action");
    action.textContent = label;
    action.className = "button button--primary";
    $("confirm-icon").style.background = "var(--green-soft)";
    $("confirm-icon").style.color = "var(--green)";
    els.confirm.returnValue = "cancel";
    els.confirm.showModal();
    const input = $("confirm-text");
    input.focus();
    /* Enter dentro do campo confirma; sem isto ele acionaria o primeiro botão
       do formulário, que é o Cancelar. */
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); action.click(); }
    });
    return new Promise((resolve) => {
      const onClose = () => {
        els.confirm.removeEventListener("close", onClose);
        resolve(els.confirm.returnValue === "confirm" ? input.value.trim() : "");
      };
      els.confirm.addEventListener("close", onClose);
    });
  }

  /* Renderização e eventos ---------------------------------------------- */
  function renderCurrentPage() {
    if (els.app.hidden) return;
    const renderers = { overview: renderOverview, users: renderUsers, diagnostics: renderDiagnostics, traces: renderTraces, analytics: renderAnalytics, versions: renderVersions, services: renderServices, whatsapp: renderWhatsapp, broadcast: renderBroadcast };
    els.page.innerHTML = renderers[state.page]?.() || "";
    if (state.page === "broadcast") {
      growComposer($("broadcast-message"));
      stickChatToBottom();
    }
    if (state.page === "users") {
      if ($("user-license-filter")) $("user-license-filter").value = state.userFilter.license;
      if ($("user-activity-filter")) $("user-activity-filter").value = state.userFilter.activity;
      if ($("user-verification-filter")) $("user-verification-filter").value = state.userFilter.verification;
      if ($("user-sort")) $("user-sort").value = state.userFilter.sort;
    }
  }

  function retryResource(resource) {
    const loaders = { devices: loadDevices, diagnostics: loadDiagnostics, statistics: loadStatistics, versions: loadVersions, traces: loadTraces, health: loadHealth, whatsapp: loadWhatsapp, verification: loadVerification, recipients: loadRecipients };
    loaders[resource]?.();
  }

  function refreshUser(account) {
    if (!account) return;
    state.detailData.delete(account.userId || account.key);
    loadDevices({ quiet: true }).then(() => openUser(account.key));
  }

  els.page.addEventListener("click", (event) => {
    const target = event.target.closest("button, [data-nav], [data-action]");
    if (!target) return;
    if (target.dataset.nav) return setPage(target.dataset.nav);
    if (target.dataset.retry) return retryResource(target.dataset.retry);
    if (target.dataset.userScope) { state.userFilter.scope = target.dataset.userScope; return renderCurrentPage(); }
    if (target.dataset.openUser) return openUser(target.dataset.openUser);
    if (target.dataset.openDiagnostic) return openDiagnostic(target.dataset.openDiagnostic);
    if (target.dataset.diagnosticStatus) { state.diagnosticFilter.status = target.dataset.diagnosticStatus; return renderCurrentPage(); }
    if (target.dataset.openTrace) return openTrace(target.dataset.openTrace);
    if (target.dataset.whatsappAction) return whatsappAction(target.dataset.whatsappAction);
    if (target.dataset.broadcastMode) { state.broadcast.mode = target.dataset.broadcastMode; return renderCurrentPage(); }
    if (target.hasAttribute("data-toggle-internal")) {
      state.broadcast.includeInternal = !state.broadcast.includeInternal;
      selectSegment(state.broadcast.segment);
      return renderCurrentPage();
    }
    if (target.hasAttribute("data-select-all")) { selectSegment(state.broadcast.segment); return renderCurrentPage(); }
    if (target.hasAttribute("data-select-none")) { state.broadcast.selected = new Set(); return renderCurrentPage(); }
    if (target.hasAttribute("data-save-list")) return saveCurrentList();
    if (target.dataset.loadList) return applyList(target.dataset.loadList);
    if (target.dataset.deleteList) return deleteList(target.dataset.deleteList);
    if (target.hasAttribute("data-send-broadcast")) return sendBroadcast();
    if (target.hasAttribute("data-attach-media")) return $("broadcast-file")?.click();
    if (target.hasAttribute("data-remove-media")) return removeBroadcastMedia();
    if (target.dataset.refreshResource) return retryResource(target.dataset.refreshResource);
    if (target.hasAttribute("data-download-broadcast-failures")) {
      const failures = state.broadcast.results.filter((item) => item.status !== "sent").map((item) => `${item.phone}\t${item.error || item.status}`).join("\n");
      return downloadText("gain-comunicado-falhas.txt", failures);
    }
  });

  els.page.addEventListener("input", (event) => {
    if (event.target.id === "user-search") {
      state.userFilter.search = event.target.value;
      const results = $("users-results"); if (results) results.innerHTML = renderUserResults();
    }
    if (event.target.id === "diagnostic-search") {
      state.diagnosticFilter.search = event.target.value;
      const results = $("diagnostic-results"); if (results) results.innerHTML = renderDiagnosticResults();
    }
    if (event.target.id === "trace-search") {
      state.traceFilter = event.target.value;
      const position = event.target.selectionStart;
      renderCurrentPage();
      $("trace-search")?.focus(); $("trace-search")?.setSelectionRange(position, position);
    }
    if (event.target.id === "broadcast-message") {
      state.broadcast.message = event.target.value;
      growComposer(event.target);
      syncBroadcastComposer();
      stickChatToBottom();
    }
    if (event.target.id === "broadcast-manual") {
      state.broadcast.manual = event.target.value;
      syncBroadcastRecipients();
    }
    if (event.target.id === "broadcast-search") {
      state.broadcast.search = event.target.value;
      const lista = $("recipient-list");
      if (lista) lista.innerHTML = renderCandidateRows(visibleCandidates(), segmentCandidates());
    }
  });

  /* Se a miniatura não carregar (Storage fora do ar, arquivo removido), o
     cartão cai para o ícone de documento em vez de exibir imagem quebrada. */
  els.page.addEventListener("error", (event) => {
    const alvo = event.target;
    if (!(alvo instanceof HTMLImageElement) || !alvo.classList.contains("media-thumb")) return;
    const substituto = document.createElement("span");
    substituto.className = "media-thumb media-thumb--doc";
    substituto.innerHTML = icon("package");
    alvo.replaceWith(substituto);
  }, true);

  els.page.addEventListener("keydown", (event) => {
    if (event.target.id !== "broadcast-message") return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!$("broadcast-send")?.disabled) sendBroadcast();
    }
  });

  els.page.addEventListener("change", (event) => {
    if (event.target.id === "broadcast-file") {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) uploadBroadcastMedia(file);
      return;
    }
    if (event.target.id === "broadcast-segment") { selectSegment(event.target.value); return renderCurrentPage(); }
    if (event.target.matches("input[type=checkbox][data-phone]")) {
      const selecionados = ensureSelection();
      event.target.checked ? selecionados.add(event.target.dataset.phone) : selecionados.delete(event.target.dataset.phone);
      event.target.closest(".recipient-row")?.classList.toggle("is-picked", event.target.checked);
      return syncBroadcastRecipients();
    }
    if (event.target.id === "user-license-filter") { state.userFilter.license = event.target.value; $("users-results").innerHTML = renderUserResults(); }
    if (event.target.id === "user-activity-filter") { state.userFilter.activity = event.target.value; $("users-results").innerHTML = renderUserResults(); }
    if (event.target.id === "user-verification-filter") { state.userFilter.verification = event.target.value; $("users-results").innerHTML = renderUserResults(); }
    if (event.target.id === "user-sort") { state.userFilter.sort = event.target.value; $("users-results").innerHTML = renderUserResults(); }
    if (event.target.id === "diagnostic-manufacturer") { state.diagnosticFilter.manufacturer = event.target.value; $("diagnostic-results").innerHTML = renderDiagnosticResults(); }
    if (event.target.id === "diagnostic-version") { state.diagnosticFilter.version = event.target.value; $("diagnostic-results").innerHTML = renderDiagnosticResults(); }
  });

  els.page.addEventListener("keydown", (event) => {
    const row = event.target.closest("tr[data-action]");
    if (row && ["Enter", " "].includes(event.key)) { event.preventDefault(); row.click(); }
  });

  els.detailContent.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.hasAttribute("data-close-detail")) return els.detail.close();
    if (target.dataset.openUser) return openUser(target.dataset.openUser);
    if (target.dataset.userTab) {
      state.detailTab = target.dataset.userTab;
      const account = findAccount(state.detail?.key);
      if (account) renderUserDetail(account);
      return;
    }
    if (target.dataset.refreshUser) return refreshUser(findAccount(target.dataset.refreshUser));
    if (target.dataset.copy != null) return copyText(target.dataset.copy, "Identificador copiado");
    if (target.dataset.licenseAction) return handleLicenseAction(findAccount(target.dataset.account), target.dataset.licenseAction);
    if (target.dataset.restoreBackup) return restoreBackup(findAccount(target.dataset.account), target.dataset.restoreBackup);
    if (target.dataset.setDiagnosticStatus) return setDiagnosticStatus(target.dataset.diagnosticId, target.dataset.setDiagnosticStatus);
    if (target.dataset.copyDiagnosticLog) { const report = state.diagnostics.find((item) => asNumber(item.id) === asNumber(target.dataset.copyDiagnosticLog)); return copyText(report?.log_text, "Log copiado"); }
    if (target.dataset.downloadDiagnosticLog) { const report = state.diagnostics.find((item) => asNumber(item.id) === asNumber(target.dataset.downloadDiagnosticLog)); return downloadText(`gain-diagnostico-${report?.id || "log"}.txt`, report?.log_text || ""); }
    if (target.dataset.copyMetadata) { const report = state.diagnostics.find((item) => asNumber(item.id) === asNumber(target.dataset.copyMetadata)); return copyText(JSON.stringify(safeJson(report?.metadata), null, 2), "Metadata copiada"); }
    if (target.dataset.reloadTrace) return openTrace(target.dataset.reloadTrace, asNumber($("trace-detail-hours")?.value, state.detail.hours));
    if (target.dataset.refreshUserTrace) { const account = findAccount(target.dataset.refreshUserTrace); const store = detailStore(account); return ensureUserTraceLoaded(account, asNumber($("user-trace-hours")?.value, store.traceHours), true); }
    if (target.dataset.copyTrace) {
      const text = target.dataset.copyTrace === "detail" ? state.detail?.data?.text : detailStore(findAccount(state.detail?.key)).trace?.text;
      return copyText(text, "Rastro copiado");
    }
    if (target.dataset.downloadTrace) {
      const account = findAccount(state.detail?.key);
      const text = target.dataset.downloadTrace === "detail" ? state.detail?.data?.text : detailStore(account).trace?.text;
      return downloadText(`gain-rastro-${account?.email || state.detail?.userId || "testador"}.txt`, text || "");
    }
  });

  els.detailContent.addEventListener("change", (event) => {
    if (event.target.id === "trace-detail-hours" && state.detail?.type === "trace") openTrace(state.detail.userId, asNumber(event.target.value, 24));
    if (event.target.id === "user-trace-hours") {
      const account = findAccount(state.detail?.key); const store = detailStore(account);
      store.traceHours = asNumber(event.target.value, 24); ensureUserTraceLoaded(account, store.traceHours, true);
    }
  });

  els.detail.addEventListener("click", (event) => { if (event.target === els.detail) els.detail.close(); });
  els.detail.addEventListener("close", () => { state.detail = null; });

  /* Moldura e autenticação ---------------------------------------------- */
  document.querySelectorAll(".nav-item[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  $("open-sidebar").addEventListener("click", openSidebar);
  $("close-sidebar").addEventListener("click", closeSidebar);
  els.backdrop.addEventListener("click", closeSidebar);
  $("refresh-page").addEventListener("click", refreshCurrentPage);
  $("sidebar-account").addEventListener("click", () => { $("account-menu").hidden = !$("account-menu").hidden; });
  $("topbar-account").addEventListener("click", () => { $("account-menu").hidden = false; openSidebar(); });
  $("logout").addEventListener("click", () => logout(false));
  document.addEventListener("click", (event) => { if (!event.target.closest("#sidebar-account, #account-menu, #topbar-account")) $("account-menu").hidden = true; });
  window.addEventListener("hashchange", () => { if (state.session) setPage(pageFromHash(), { updateHistory: false }); });
  window.addEventListener("beforeunload", (event) => { if (state.broadcast.sending) { event.preventDefault(); event.returnValue = ""; } });

  $("show-email-login").addEventListener("click", () => {
    const form = $("email-login-form"); form.hidden = !form.hidden;
    $("show-email-login").querySelector("svg").style.transform = form.hidden ? "" : "rotate(180deg)";
    if (!form.hidden) $("email").focus();
  });

  $("google-login").addEventListener("click", () => {
    const redirect = encodeURIComponent(location.origin + location.pathname);
    location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${redirect}`;
  });

  $("email-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("email-login"), message = $("auth-message");
    message.hidden = true; button.disabled = true; button.innerHTML = `${icon("loader", "icon spin")} Entrando…`;
    try { await validateAndEnter(await passwordLogin($("email").value.trim(), $("password").value)); }
    catch (error) { showAuthError(error); }
    finally { button.disabled = false; button.textContent = "Entrar no painel"; }
  });

  async function initialize() {
    let session = null;
    try { session = sessionFromHash() || readSession(); }
    catch (error) { showAuthError(error); }
    if (!session) return;
    const googleButton = $("google-login");
    googleButton.disabled = true; googleButton.innerHTML = `${icon("loader", "icon spin")} Validando sessão…`;
    try { await validateAndEnter(session); }
    catch (error) { clearSession(); showAuthError(error); }
    finally { googleButton.disabled = false; googleButton.innerHTML = `<svg class="google-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.8 6.1C12.2 13.3 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.2 5.3-4.7 6.9l7.3 5.7c4.3-3.9 6.8-9.7 6.8-17.1z"/><path fill="#FBBC05" d="M10.3 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.5 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.8-3.8-13.7-9.1l-7.8 6.1C6.4 42.6 14.6 48 24 48z"/></svg> Continuar com o Google`; }
  }

  initialize();
})();
