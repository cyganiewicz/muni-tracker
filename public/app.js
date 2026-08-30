(function () {
  "use strict";

  const state = {
    me: null,
    config: {},
    regions: [],
    communities: [],
    mailingCities: [],
    clients: [],
    currentCycle: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Datawrapper's own responsive-embed script: the chart posts its
  // rendered height across, and this resizes whichever iframe on the page
  // matches the source window. Straight port of the snippet Datawrapper
  // gives you on the chart's "Publish & Embed" tab, so the map iframe
  // sizes itself instead of scrolling inside a fixed box.
  window.addEventListener("message", (event) => {
    const heights = event.data && event.data["datawrapper-height"];
    if (!heights) return;
    const frames = document.querySelectorAll("iframe");
    for (const key in heights) {
      for (const frame of frames) {
        if (frame.contentWindow === event.source) {
          frame.style.height = heights[key] + "px";
        }
      }
    }
  });

  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------------- boot ----------------
  async function boot() {
    try {
      const [names, config] = await Promise.all([api("/team-names"), api("/config")]);
      const sel = $("#loginName");
      sel.innerHTML = names.names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
      state.config = config;
    } catch (e) { /* ignore */ }

    try {
      const me = await api("/me");
      if (me.authed) {
        state.me = me;
        await enterApp();
        return;
      }
    } catch (e) { /* ignore */ }
    showLogin();
  }

  function showLogin() {
    $("#loginScreen").hidden = false;
    $("#app").hidden = true;
  }

  async function enterApp() {
    $("#loginScreen").hidden = true;
    $("#app").hidden = false;
    $("#whoName").textContent = state.me.name;
    applyAdminUi();

    const [regions, communities, mailingCities, cycle] = await Promise.all([
      api("/regions"), api("/communities"), api("/mailing-cities"), api("/cycles/current"),
    ]);
    state.regions = regions;
    state.communities = communities;
    state.mailingCities = mailingCities;
    state.currentCycle = cycle;
    $("#cycleBadge").textContent = cycle ? cycle.label : "";

    populateFilterOptions();
    populateFormOptions();

    await loadClients();
    switchView("clients");
  }

  function applyAdminUi() {
    const isAdmin = state.me && state.me.isAdmin;
    $("#adminTabBtn").hidden = !isAdmin;
    $("#adminUnlockBtn").hidden = isAdmin || !(state.config && state.config.adminAvailable);
    $("#adminLockBtn").hidden = !isAdmin;
    if (!isAdmin) {
      $("#view-admin").hidden = true;
      const activeTab = $(".tabbtn.active");
      if (activeTab && activeTab.dataset.view === "admin") switchView("clients");
    }
  }

  // ---------------- login form ----------------
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginError").hidden = true;
    try {
      const me = await api("/login", {
        method: "POST",
        body: { password: $("#loginPassword").value, name: $("#loginName").value },
      });
      state.me = me;
      await enterApp();
    } catch (err) {
      $("#loginError").textContent = err.data?.error === "wrong_password" ? "Wrong password." : "Could not sign in.";
      $("#loginError").hidden = false;
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await api("/logout", { method: "POST" });
    location.reload();
  });

  // ---------------- admin unlock ----------------
  $("#adminUnlockBtn").addEventListener("click", () => {
    $("#adminUnlockError").hidden = true;
    $("#adminUnlockPassword").value = "";
    $("#adminUnlockBackdrop").hidden = false;
  });
  $("#adminUnlockClose").addEventListener("click", () => { $("#adminUnlockBackdrop").hidden = true; });
  $("#adminUnlockCancel").addEventListener("click", () => { $("#adminUnlockBackdrop").hidden = true; });

  $("#adminUnlockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const result = await api("/admin/unlock", { method: "POST", body: { password: $("#adminUnlockPassword").value } });
      state.me.isAdmin = result.isAdmin;
      $("#adminUnlockBackdrop").hidden = true;
      applyAdminUi();
    } catch (err) {
      $("#adminUnlockError").textContent = "Wrong admin password.";
      $("#adminUnlockError").hidden = false;
    }
  });

  $("#adminLockBtn").addEventListener("click", async () => {
    await api("/admin/lock", { method: "POST" });
    state.me.isAdmin = false;
    applyAdminUi();
  });

  // ---------------- nav ----------------
  $$(".tabbtn").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

  function switchView(view) {
    $$(".tabbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#view-clients").hidden = view !== "clients";
    $("#view-dashboard").hidden = view !== "dashboard";
    $("#view-admin").hidden = view !== "admin";
    if (view === "dashboard") loadDashboard();
    if (view === "admin") loadAdmin();
  }

  // ---------------- filter/option population ----------------
  function populateFilterOptions() {
    const regionSel = $("#filterRegion");
    regionSel.innerHTML = '<option value="">All regions</option>' +
      state.regions.map((r) => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join("");

    const advisors = Array.from(new Set(state.regions.map((r) => r.advisor))).sort();
    const advisorSel = $("#filterAdvisor");
    advisorSel.innerHTML = '<option value="">All advisors</option>' +
      advisors.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  }

  function populateFormOptions() {
    const regionSel = $("#f_region_id");
    regionSel.innerHTML = state.regions.map((r) => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join("");
  }

  // ---------------- client list ----------------
  let searchDebounce = null;
  $("#search").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadClients, 250);
  });
  $("#filterRegion").addEventListener("change", loadClients);
  $("#filterAdvisor").addEventListener("change", loadClients);
  $("#filterStatus").addEventListener("change", loadClients);

  async function loadClients() {
    const params = new URLSearchParams();
    const search = $("#search").value.trim();
    const region = $("#filterRegion").value;
    const advisor = $("#filterAdvisor").value;
    const status = $("#filterStatus").value;
    if (search) params.set("search", search);
    if (region) params.set("region", region);
    if (advisor) params.set("advisor", advisor);
    if (status) params.set("status", status);

    const rows = await api("/clients?" + params.toString());
    state.clients = rows;
    renderClientList(rows);
  }

  function renderClientList(rows) {
    const container = $("#clientList");
    $("#clientCount").textContent = `${rows.length} client${rows.length === 1 ? "" : "s"}`;

    if (rows.length === 0) {
      container.innerHTML = '<p class="muted">No clients match these filters.</p>';
      return;
    }

    const groups = new Map();
    for (const r of rows) {
      const key = r.region_label || `Region ${r.region_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const sortedKeys = Array.from(groups.keys()).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    container.innerHTML = sortedKeys.map((key) => {
      const items = groups.get(key);
      return `<div class="region-group"><h3>${escapeHtml(key)}</h3>${items.map(clientRowHtml).join("")}</div>`;
    }).join("");

    container.querySelectorAll(".client-row").forEach((el) => {
      el.addEventListener("click", () => openClientModal(Number(el.dataset.id)));
    });
  }

  function formatNextReview(rv) {
    if (!rv) return "—";
    const parts = [];
    if (rv.next_review_date) parts.push(rv.next_review_date);
    if (rv.next_review_text) parts.push(rv.next_review_text);
    return parts.length ? parts.join(" — ") : "—";
  }

  function clientRowHtml(r) {
    const rv = r.review || {};
    const nextDate = formatNextReview(rv);
    const notes = r.special_notes || rv.review_notes || "";
    const done = !!rv.done;
    return `
      <div class="client-row" data-id="${r.id}">
        <div>
          <div class="name">${escapeHtml(r.household_name)}</div>
          <div class="sub">${escapeHtml(r.community_name || r.mailing_city || "")}</div>
        </div>
        <div class="sub">${escapeHtml(r.advisor || "")}</div>
        <div class="sub">Last: ${escapeHtml(rv.last_review_text || "—")}</div>
        <div class="sub">Next: ${escapeHtml(nextDate)}</div>
        <div class="notes-preview" title="${escapeHtml(notes)}">${escapeHtml(notes)}</div>
        <div><span class="badge ${done ? "done" : "pending"}">${done ? "Done" : "Pending"}</span></div>
      </div>
    `;
  }

  // ---------------- autocomplete widget ----------------
  function attachAutocomplete(input, getOptions, opts = {}) {
    let list = null;
    let items = [];
    let activeIndex = -1;

    function close() {
      if (list) { list.remove(); list = null; }
      activeIndex = -1;
    }

    function render() {
      const val = input.value.trim().toLowerCase();
      const all = getOptions();
      let matches = val ? all.filter((o) => o.toLowerCase().includes(val)) : all.slice(0, 30);
      matches = matches.slice(0, 12);

      const showAddNew = opts.allowNew && val && !all.some((o) => o.toLowerCase() === val);

      if (matches.length === 0 && !showAddNew) { close(); return; }

      if (!list) {
        list = document.createElement("div");
        list.className = "ac-list";
        input.parentElement.appendChild(list);
      }
      items = matches.slice();
      list.innerHTML = items.map((m, i) => `<div class="ac-item" data-index="${i}">${escapeHtml(m)}</div>`).join("") +
        (showAddNew ? `<div class="ac-item ac-new" data-index="new">+ Use "${escapeHtml(input.value.trim())}"</div>` : "");
      activeIndex = -1;

      list.querySelectorAll(".ac-item").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const idx = el.dataset.index;
          input.value = idx === "new" ? input.value.trim() : items[Number(idx)];
          close();
          input.dispatchEvent(new Event("change"));
        });
      });
    }

    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(close, 150));
    input.addEventListener("keydown", (e) => {
      if (!list) return;
      const nodes = Array.from(list.children);
      if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, nodes.length - 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); }
      else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); nodes[activeIndex].dispatchEvent(new MouseEvent("mousedown")); return; }
      else if (e.key === "Escape") { close(); return; }
      else return;
      nodes.forEach((n, i) => n.classList.toggle("active", i === activeIndex));
    });
  }

  attachAutocomplete($("#f_community"), () => state.communities.map((c) => c.name), { allowNew: true });
  attachAutocomplete($("#f_mailing_city"), () => state.mailingCities, { allowNew: true });

  // Every MA town has one correct territory -- once the rep picks a known
  // community, auto-assign its region instead of making them look it up.
  $("#f_community").addEventListener("change", () => {
    const name = $("#f_community").value.trim().toLowerCase();
    const match = state.communities.find((c) => c.name.toLowerCase() === name);
    if (match && match.region_id) {
      $("#f_region_id").value = match.region_id;
    }
  });

  // ---------------- client modal ----------------
  let editing = null;

  $("#addClientBtn").addEventListener("click", () => openClientModal(null));
  $("#modalClose").addEventListener("click", closeModal);
  $("#cancelBtn").addEventListener("click", closeModal);
  $("#modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });

  async function openClientModal(id) {
    $("#formError").hidden = true;
    $("#deleteClientBtn").hidden = id === null;
    $("#historyList").innerHTML = "";
    $("#modalTitle").textContent = id === null ? "Add client" : "Edit client";

    if (id === null) {
      editing = null;
      $("#f_id").value = ""; $("#f_version").value = "";
      $("#f_review_id").value = ""; $("#f_review_version").value = "";
      $("#f_household_name").value = "";
      $("#f_region_id").value = state.regions[0]?.id || "";
      $("#f_community").value = "";
      $("#f_mailing_city").value = "";
      $("#f_last_review_date").value = "";
      $("#f_last_review_text").value = "";
      $("#f_next_review_date").value = "";
      $("#f_next_review_text").value = "";
      $("#f_material_count").value = "";
      $("#f_assigned_rep_note").value = "";
      $("#f_coverage_note").value = "";
      $("#f_treasurer_start_date").value = "";
      $("#f_special_notes").value = "";
      $("#f_review_notes").value = "";
      $("#f_done").checked = false;
    } else {
      const row = await api(`/clients/${id}`);
      editing = row;
      const rv = row.review || {};
      $("#f_id").value = row.id; $("#f_version").value = row.version;
      $("#f_review_id").value = rv.id || ""; $("#f_review_version").value = rv.version || "";
      $("#f_household_name").value = row.household_name || "";
      $("#f_region_id").value = row.region_id || "";
      $("#f_community").value = row.community_name || "";
      $("#f_mailing_city").value = row.mailing_city || "";
      $("#f_last_review_date").value = rv.last_review_date || "";
      $("#f_last_review_text").value = rv.last_review_text || "";
      $("#f_next_review_date").value = rv.next_review_date || "";
      $("#f_next_review_text").value = rv.next_review_text || "";
      $("#f_material_count").value = rv.material_count ?? "";
      $("#f_assigned_rep_note").value = rv.assigned_rep_note || "";
      $("#f_coverage_note").value = row.coverage_note || "";
      $("#f_treasurer_start_date").value = row.treasurer_start_date || "";
      $("#f_special_notes").value = row.special_notes || "";
      $("#f_review_notes").value = rv.review_notes || "";
      $("#f_done").checked = !!rv.done;

      loadHistory(id);
    }

    $("#modalBackdrop").hidden = false;
  }

  function closeModal() {
    $("#modalBackdrop").hidden = true;
    editing = null;
  }

  async function loadHistory(id) {
    try {
      const rows = await api(`/clients/${id}/history`);
      $("#historyList").innerHTML = rows.length
        ? rows.map((h) => `<div>${escapeHtml(h.changed_at)} — <b>${escapeHtml(h.changed_by || "?")}</b> changed <i>${escapeHtml(h.field)}</i>: "${escapeHtml(h.old_value || "")}" → "${escapeHtml(h.new_value || "")}"</div>`).join("")
        : '<div class="muted">No changes logged yet.</div>';
    } catch (e) { /* ignore */ }
  }

  // Checking "Review complete" auto-fills the Last review date with
  // whatever was on the books as the scheduled (next) review date -- on
  // the theory that if it got done, it got done on/around when it was
  // supposed to. This only touches the visible form field the advisor is
  // about to save, so it's freely overridable before submitting, and it
  // has no effect on completed_at (which the server always stamps with
  // the actual moment "done" is checked) -- so the cycle-tracking metrics
  // that depend on completed_at are untouched by this.
  $("#f_done").addEventListener("change", () => {
    if ($("#f_done").checked && $("#f_next_review_date").value) {
      $("#f_last_review_date").value = $("#f_next_review_date").value;
    }
  });

  function describeSaveError(label, err) {
    if (err.status === 409) return `Someone else just updated ${label} — please redo that part of your change and save again.`;
    return `Could not save ${label}: ${err.message || "unknown error"}`;
  }

  async function resolveCommunityId(name) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = state.communities.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;
    const region_id = Number($("#f_region_id").value) || null;
    const created = await api("/communities", { method: "POST", body: { name: trimmed, region_id } });
    state.communities.push(created);
    return created.id;
  }

  $("#clientForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#formError").hidden = true;

    try {
      const community_id = await resolveCommunityId($("#f_community").value);
      const clientPayload = {
        household_name: $("#f_household_name").value.trim(),
        region_id: Number($("#f_region_id").value),
        community_id,
        mailing_city: $("#f_mailing_city").value.trim() || null,
        coverage_note: $("#f_coverage_note").value.trim() || null,
        treasurer_start_date: $("#f_treasurer_start_date").value || null,
        special_notes: $("#f_special_notes").value.trim() || null,
      };
      const reviewPayload = {
        last_review_date: $("#f_last_review_date").value || null,
        last_review_text: $("#f_last_review_text").value.trim() || null,
        next_review_date: $("#f_next_review_date").value || null,
        next_review_text: $("#f_next_review_text").value.trim() || null,
        material_count: $("#f_material_count").value ? Number($("#f_material_count").value) : null,
        assigned_rep_note: $("#f_assigned_rep_note").value.trim() || null,
        review_notes: $("#f_review_notes").value.trim() || null,
        done: $("#f_done").checked,
      };

      if (editing) {
        // Client-level fields and this cycle's review are two separate
        // records with their own version numbers, saved independently --
        // a conflict on one (someone else edited that specific record)
        // must never silently swallow the other. In particular, marking
        // a review "done" is the whole point of this app's metrics, so it
        // must never get lost just because an unrelated client field (say,
        // a coverage note) was edited by someone else at nearly the same
        // moment.
        let clientErr = null, reviewErr = null;
        try {
          await api(`/clients/${editing.id}`, { method: "PATCH", body: { ...clientPayload, version: Number($("#f_version").value) } });
        } catch (err) {
          clientErr = err;
        }
        if (editing.review && editing.review.id) {
          try {
            await api(`/reviews/${editing.review.id}`, { method: "PATCH", body: { ...reviewPayload, version: Number($("#f_review_version").value) } });
          } catch (err) {
            reviewErr = err;
          }
        }
        if (clientErr || reviewErr) throw { combined: true, clientErr, reviewErr };
      } else {
        await api("/clients", { method: "POST", body: { ...clientPayload, ...reviewPayload } });
      }

      closeModal();
      if (!state.mailingCities.includes($("#f_mailing_city").value.trim())) await refreshMailingCities();
      await loadClients();
    } catch (err) {
      if (err && err.combined) {
        const parts = [];
        if (err.clientErr) parts.push(describeSaveError("the client details", err.clientErr));
        if (err.reviewErr) parts.push(describeSaveError("this cycle's review", err.reviewErr));
        if (!err.clientErr) parts.unshift("Client details saved.");
        if (!err.reviewErr && editing.review) parts.unshift("This cycle's review saved.");
        $("#formError").innerHTML = parts.join("<br>");
        $("#formError").hidden = false;

        // Refresh to the latest server state so the version fields are
        // current if they retry, and so the list behind the modal shows
        // whichever half of the save actually went through.
        try {
          const latest = await api(`/clients/${editing.id}`);
          editing = latest;
          $("#f_version").value = latest.version;
          if (latest.review) {
            $("#f_review_id").value = latest.review.id;
            $("#f_review_version").value = latest.review.version;
          }
        } catch (e) { /* ignore */ }
        await loadClients();
      } else if (err.status === 409) {
        $("#formError").textContent = "Someone else just updated this client — reopening with their latest version. Please redo your change.";
        $("#formError").hidden = false;
        if (err.data && err.data.current) {
          editing = err.data.current;
          $("#f_version").value = err.data.current.version;
          if (err.data.current.review) {
            $("#f_review_id").value = err.data.current.review.id;
            $("#f_review_version").value = err.data.current.review.version;
          }
        }
      } else {
        $("#formError").textContent = "Could not save: " + (err.message || "unknown error");
        $("#formError").hidden = false;
      }
    }
  });

  async function refreshMailingCities() {
    state.mailingCities = await api("/mailing-cities");
  }

  $("#deleteClientBtn").addEventListener("click", async () => {
    if (!editing) return;
    if (!confirm(`Remove ${editing.household_name}? This can be restored later by an admin (it's a soft delete).`)) return;
    await api(`/clients/${editing.id}`, { method: "DELETE" });
    closeModal();
    await loadClients();
  });

  // ---------------- export / sync ----------------
  $("#exportCsvBtn").addEventListener("click", () => window.open("/api/export/datawrapper.csv", "_blank"));
  $("#exportClientsCsvBtn").addEventListener("click", () => window.open("/api/export/clients.csv", "_blank"));

  $("#syncDwBtn").addEventListener("click", async () => {
    $("#syncStatus").textContent = "Syncing…";
    try {
      const result = await api("/sync/datawrapper", { method: "POST" });
      $("#syncStatus").textContent = result.skipped ? "Map sync not configured (see README)." : "Map synced ✓";
    } catch (e) {
      $("#syncStatus").textContent = "Map sync failed.";
    }
    setTimeout(() => { $("#syncStatus").textContent = ""; }, 5000);
  });

  // ---------------- dashboard ----------------
  async function loadDashboard() {
    const [data, cycles] = await Promise.all([api("/dashboard"), api("/cycles")]);

    $("#dashTotalPct").textContent = Math.round((data.totals.pct_done || 0) * 100) + "%";
    $("#dashTotalDone").textContent = data.totals.done || 0;
    $("#dashTotalAll").textContent = data.totals.total || 0;

    $("#dashByAdvisor").innerHTML = data.perAdvisor.map(barRow).join("");
    $("#dashByRegion").innerHTML = data.perRegion.map((r) => barRow({ advisor: r.label, total: r.total, done: r.done, pct_done: r.pct_done })).join("");

    $("#dashUpcoming").innerHTML = data.upcoming.length
      ? data.upcoming.map((u) => `
          <tr>
            <td>${escapeHtml(formatNextReview(u))}</td>
            <td>${escapeHtml(u.household_name)}</td>
            <td>${escapeHtml(u.community_name || "")}</td>
            <td>${escapeHtml(u.advisor || "")}</td>
          </tr>`).join("")
      : '<tr><td colspan="4" class="muted">Nothing scheduled yet.</td></tr>';

    $("#dashStaleCount").textContent = data.staleReviews.count;
    $("#dashStaleNote").textContent = data.staleReviews.count > data.staleReviews.list.length
      ? `(showing ${data.staleReviews.list.length} of ${data.staleReviews.count})` : "";
    $("#dashStale").innerHTML = data.staleReviews.list.length
      ? data.staleReviews.list.map((r) => `
          <tr>
            <td>${escapeHtml(r.household_name)}</td>
            <td>${escapeHtml(r.community_name || "")}</td>
            <td>${escapeHtml(r.advisor || "")}</td>
            <td>${escapeHtml(r.effective_last_review || "Never")}</td>
          </tr>`).join("")
      : '<tr><td colspan="4" class="muted">None — everyone’s been reviewed within the last year.</td></tr>';

    $("#dashLast30Count").textContent = data.completedLast30.count;
    $("#dashCompletedRecent").innerHTML = data.completedLast30.list.length
      ? data.completedLast30.list.map((r) => `
          <tr>
            <td>${escapeHtml(r.completed_date || "")}</td>
            <td>${escapeHtml(r.household_name)}</td>
            <td>${escapeHtml(r.community_name || "")}</td>
            <td>${escapeHtml(r.advisor || "")}</td>
          </tr>`).join("")
      : '<tr><td colspan="4" class="muted">Nothing completed in the last 30 days yet.</td></tr>';

    $("#dashNewTreasurers").innerHTML = data.newTreasurers.list.length
      ? data.newTreasurers.list.map((r) => `
          <tr>
            <td>${escapeHtml(r.household_name)}</td>
            <td>${escapeHtml(r.community_name || "")}</td>
            <td>${escapeHtml(r.advisor || "")}</td>
            <td>${escapeHtml(r.treasurer_start_date || "")}</td>
          </tr>`).join("")
      : '<tr><td colspan="4" class="muted">None right now.</td></tr>';

    $("#cycleHistory").innerHTML = cycles.map((c) => `
      <tr>
        <td>${escapeHtml(c.label)}${c.closed_at ? "" : ' <span class="badge done" style="margin-left:6px;">current</span>'}</td>
        <td>${escapeHtml((c.started_at || "").slice(0, 10))}</td>
        <td>${escapeHtml(c.closed_at ? c.closed_at.slice(0, 10) : "—")}</td>
        <td>${c.done}/${c.total} (${Math.round((c.pct_done || 0) * 100)}%)</td>
      </tr>`).join("");

    const mapCard = $("#mapCard");
    const frame = $("#datawrapperFrame");
    if (state.config.datawrapperEmbedUrl) {
      mapCard.hidden = false;
      if (frame.src !== state.config.datawrapperEmbedUrl) frame.src = state.config.datawrapperEmbedUrl;
    } else {
      mapCard.hidden = true;
    }
  }

  function barRow(r) {
    const pct = Math.round((r.pct_done || 0) * 100);
    return `
      <div class="bar-row">
        <div>${escapeHtml(String(r.advisor))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="muted">${r.done}/${r.total}</div>
      </div>
    `;
  }

  // ---------------- admin ----------------
  async function loadAdmin() {
    const [members, regions, cycle] = await Promise.all([
      api("/admin/team-members"), api("/regions"), api("/cycles/current"),
    ]);

    $("#adminTeamList").innerHTML = members.map((m) => `
      <div class="admin-row" data-id="${m.id}" data-kind="member">
        <input type="text" value="${escapeHtml(m.name)}" class="member-name" />
        <span class="tag">${m.active ? "active" : "inactive"}</span>
        <button type="button" class="linklike toggle-active">${m.active ? "Deactivate" : "Activate"}</button>
      </div>
    `).join("");

    $("#adminRegionList").innerHTML = regions.map((r) => `
      <div class="admin-row" data-id="${r.id}" data-kind="region">
        <input type="text" value="${escapeHtml(r.label)}" class="region-label" style="max-width:120px" />
        <input type="text" value="${escapeHtml(r.advisor)}" class="region-advisor" />
        <button type="button" class="linklike save-region">Save</button>
      </div>
    `).join("");

    $("#adminCurrentCycle").textContent = cycle
      ? `Current cycle: "${cycle.label}" — started ${cycle.started_at.slice(0, 10)}, ${cycle.done}/${cycle.total} done.`
      : "No active cycle.";

    $$("#adminTeamList .toggle-active").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const row = e.target.closest(".admin-row");
        const id = row.dataset.id;
        const active = row.querySelector(".tag").textContent === "inactive";
        await api(`/admin/team-members/${id}`, { method: "PATCH", body: { active } });
        loadAdmin();
      });
    });
    $$("#adminTeamList .member-name").forEach((input) => {
      input.addEventListener("change", async (e) => {
        const row = e.target.closest(".admin-row");
        await api(`/admin/team-members/${row.dataset.id}`, { method: "PATCH", body: { name: input.value.trim() } });
      });
    });
    $$("#adminRegionList .save-region").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const row = e.target.closest(".admin-row");
        const label = row.querySelector(".region-label").value.trim();
        const advisor = row.querySelector(".region-advisor").value.trim();
        await api(`/admin/regions/${row.dataset.id}`, { method: "PATCH", body: { label, advisor } });
        state.regions = await api("/regions");
        populateFilterOptions();
        populateFormOptions();
      });
    });
  }

  $("#addTeamMemberForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#newTeamMemberName").value.trim();
    if (!name) return;
    await api("/admin/team-members", { method: "POST", body: { name } });
    $("#newTeamMemberName").value = "";
    loadAdmin();
  });

  $("#addRegionForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = $("#newRegionLabel").value.trim();
    const advisor = $("#newRegionAdvisor").value.trim();
    if (!label || !advisor) return;
    await api("/admin/regions", { method: "POST", body: { label, advisor } });
    $("#newRegionLabel").value = ""; $("#newRegionAdvisor").value = "";
    state.regions = await api("/regions");
    populateFilterOptions();
    populateFormOptions();
    loadAdmin();
  });

  $("#newCycleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = $("#newCycleLabel").value.trim();
    if (!label) return;
    if (!confirm(`Start new cycle "${label}"? This closes the current cycle (its history is kept) and creates a fresh, unchecked review for every active client.`)) return;
    await api("/admin/cycles/new", { method: "POST", body: { label } });
    $("#newCycleLabel").value = "";
    state.currentCycle = await api("/cycles/current");
    $("#cycleBadge").textContent = state.currentCycle ? state.currentCycle.label : "";
    await loadClients();
    loadAdmin();
  });

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  boot();
})();
