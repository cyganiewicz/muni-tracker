require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const cookieSession = require("cookie-session");
const db = require("./db");
const { buildTownCsv, buildClientCsv, syncToDatawrapper, getCurrentCycleId } = require("./datawrapper");

const app = express();
const PORT = process.env.PORT || 8080;
const APP_PASSWORD = process.env.APP_PASSWORD || "changeme";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-in-production";
const AUTO_SYNC_DATAWRAPPER = process.env.AUTO_SYNC_DATAWRAPPER !== "false";

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(
  cookieSession({
    name: "mtsession",
    secret: SESSION_SECRET,
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days - this is a low-stakes internal tool
  })
);

// ---------- auth ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.authed && req.session.isAdmin) return next();
  return res.status(403).json({ error: "admin_required" });
}

app.get("/api/team-names", (req, res) => {
  const rows = db.prepare("SELECT name FROM team_members WHERE active = 1 ORDER BY name").all();
  res.json({ names: rows.map((r) => r.name) });
});

app.get("/api/config", (req, res) => {
  // Prefer an exact embed URL pasted from Datawrapper's own "Embed" tab
  // (it includes a version number we can't reliably guess, e.g. .../TvOY0/6/).
  // Falls back to a best-guess unversioned URL if only the chart id is set.
  const explicitEmbed = process.env.DATAWRAPPER_EMBED_URL || null;
  const chartId = process.env.DATAWRAPPER_CHART_ID || null;
  res.json({
    datawrapperEmbedUrl: explicitEmbed || (chartId ? `https://datawrapper.dwcdn.net/${chartId}/` : null),
    adminAvailable: !!ADMIN_PASSWORD,
  });
});

app.post("/api/login", (req, res) => {
  const { password, name } = req.body || {};
  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: "wrong_password" });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  req.session.authed = true;
  req.session.name = String(name).trim();
  req.session.isAdmin = false;
  res.json({ ok: true, name: req.session.name, isAdmin: false });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (req.session && req.session.authed) {
    return res.json({ authed: true, name: req.session.name, isAdmin: !!req.session.isAdmin });
  }
  res.json({ authed: false });
});

app.post("/api/admin/unlock", requireAuth, (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(400).json({ error: "admin_not_configured" });
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "wrong_password" });
  }
  req.session.isAdmin = true;
  res.json({ ok: true, isAdmin: true });
});

app.post("/api/admin/lock", requireAuth, (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true, isAdmin: false });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/login" || req.path === "/logout" || req.path === "/me" || req.path === "/team-names" || req.path === "/config") return next();
  return requireAuth(req, res, next);
});

function logChange(entityType, entityId, field, oldVal, newVal, changedBy) {
  db.prepare(
    "INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(entityType, entityId, field, oldVal == null ? null : String(oldVal), newVal == null ? null : String(newVal), changedBy);
}

// ---------- regions / territories ----------
app.get("/api/regions", (req, res) => {
  res.json(db.prepare("SELECT * FROM regions ORDER BY id").all());
});

app.post("/api/admin/regions", requireAdmin, (req, res) => {
  const { label, advisor } = req.body || {};
  if (!label || !advisor) return res.status(400).json({ error: "label_and_advisor_required" });
  const info = db.prepare("INSERT INTO regions (label, advisor) VALUES (?, ?)").run(String(label).trim(), String(advisor).trim());
  logChange("region", info.lastInsertRowid, "created", null, `${label} / ${advisor}`, req.session.name);
  res.status(201).json(db.prepare("SELECT * FROM regions WHERE id = ?").get(info.lastInsertRowid));
});

app.patch("/api/admin/regions/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM regions WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "not_found" });
  const { label, advisor } = req.body || {};
  const newLabel = label !== undefined ? String(label).trim() : current.label;
  const newAdvisor = advisor !== undefined ? String(advisor).trim() : current.advisor;
  db.prepare("UPDATE regions SET label = ?, advisor = ? WHERE id = ?").run(newLabel, newAdvisor, req.params.id);
  if (newLabel !== current.label) logChange("region", current.id, "label", current.label, newLabel, req.session.name);
  if (newAdvisor !== current.advisor) logChange("region", current.id, "advisor", current.advisor, newAdvisor, req.session.name);
  res.json(db.prepare("SELECT * FROM regions WHERE id = ?").get(req.params.id));
});

// ---------- team members (reps) ----------
app.get("/api/admin/team-members", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM team_members ORDER BY active DESC, name").all());
});

app.post("/api/admin/team-members", requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });
  try {
    const info = db.prepare("INSERT INTO team_members (name) VALUES (?)").run(String(name).trim());
    logChange("team_member", info.lastInsertRowid, "created", null, name, req.session.name);
    res.status(201).json(db.prepare("SELECT * FROM team_members WHERE id = ?").get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "already_exists" });
    res.status(500).json({ error: "server_error", detail: e.message });
  }
});

app.patch("/api/admin/team-members/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM team_members WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "not_found" });
  const { name, active } = req.body || {};
  const newName = name !== undefined ? String(name).trim() : current.name;
  const newActive = active !== undefined ? (active ? 1 : 0) : current.active;
  db.prepare("UPDATE team_members SET name = ?, active = ? WHERE id = ?").run(newName, newActive, req.params.id);
  if (newName !== current.name) logChange("team_member", current.id, "name", current.name, newName, req.session.name);
  if (newActive !== current.active) logChange("team_member", current.id, "active", current.active, newActive, req.session.name);
  res.json(db.prepare("SELECT * FROM team_members WHERE id = ?").get(req.params.id));
});

// ---------- communities ----------
app.get("/api/communities", (req, res) => {
  res.json(db.prepare("SELECT * FROM communities ORDER BY name").all());
});

app.get("/api/mailing-cities", (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT name FROM (
      SELECT mailing_city AS name FROM clients WHERE mailing_city IS NOT NULL AND mailing_city != ''
      UNION
      SELECT name FROM communities
    )
    ORDER BY name
  `).all();
  res.json(rows.map((r) => r.name));
});

app.post("/api/communities", (req, res) => {
  const { name, municipal_type, county, region_id, status } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });
  try {
    const info = db
      .prepare("INSERT INTO communities (name, municipal_type, county, region_id, status) VALUES (?, ?, ?, ?, ?)")
      .run(String(name).trim(), municipal_type || "Town", county || null, region_id || null, status || "client");
    res.status(201).json(db.prepare("SELECT * FROM communities WHERE id = ?").get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      const existing = db.prepare("SELECT * FROM communities WHERE name = ?").get(String(name).trim());
      return res.status(409).json({ error: "already_exists", community: existing });
    }
    res.status(500).json({ error: "server_error", detail: e.message });
  }
});

// ---------- cycles ----------
function currentCycle() {
  return db.prepare("SELECT * FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get();
}

function cycleStats(cycleId) {
  return db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN rv.done = 1 THEN 1 ELSE 0 END) AS done
    FROM reviews rv JOIN clients cl ON cl.id = rv.client_id
    WHERE rv.cycle_id = ? AND cl.active = 1
  `).get(cycleId);
}

app.get("/api/cycles", (req, res) => {
  const cycles = db.prepare("SELECT * FROM cycles ORDER BY id DESC").all();
  res.json(cycles.map((c) => {
    const stats = cycleStats(c.id);
    return { ...c, total: stats.total || 0, done: stats.done || 0, pct_done: stats.total ? stats.done / stats.total : 0 };
  }));
});

app.get("/api/cycles/current", (req, res) => {
  const c = currentCycle();
  if (!c) return res.status(404).json({ error: "no_active_cycle" });
  const stats = cycleStats(c.id);
  res.json({ ...c, total: stats.total || 0, done: stats.done || 0, pct_done: stats.total ? stats.done / stats.total : 0 });
});

// Start a new review cycle: closes the current one and creates a fresh
// review row per active client. Nothing is deleted -- the old cycle's rows
// (and their done/notes/dates) stay exactly as they were for history and
// trend reporting.
app.post("/api/admin/cycles/new", requireAdmin, (req, res) => {
  const { label } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: "label_required" });

  const prev = currentCycle();
  if (!prev) return res.status(400).json({ error: "no_active_cycle_to_close" });

  const clients = db.prepare("SELECT id FROM clients WHERE active = 1").all();
  const getPrevReview = db.prepare("SELECT * FROM reviews WHERE client_id = ? AND cycle_id = ?");
  const insertReview = db.prepare(`
    INSERT INTO reviews (client_id, cycle_id, last_review_text, last_review_date, material_count, assigned_rep_note, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let newCycleId;
  const tx = db.transaction(() => {
    db.prepare("UPDATE cycles SET closed_at = datetime('now') WHERE id = ?").run(prev.id);
    const info = db.prepare("INSERT INTO cycles (label, started_by) VALUES (?, ?)").run(String(label).trim(), req.session.name);
    newCycleId = info.lastInsertRowid;

    for (const c of clients) {
      const old = getPrevReview.get(c.id, prev.id);
      // the new cycle's "last review" is whatever was scheduled/done as
      // "next review" last time (falls back to the old last-review if that
      // was never filled in), so the review trail carries forward.
      const lastText = (old && (old.next_review_text || old.last_review_text)) || null;
      const lastDate = (old && (old.next_review_date || old.last_review_date)) || null;
      insertReview.run(
        c.id, newCycleId, lastText, lastDate,
        old ? old.material_count : null,
        old ? old.assigned_rep_note : null,
        req.session.name
      );
    }
    logChange("cycle", newCycleId, "started", prev.label, String(label).trim(), req.session.name);
  });
  tx();

  maybeSync();
  res.status(201).json(db.prepare("SELECT * FROM cycles WHERE id = ?").get(newCycleId));
});

// ---------- clients + current-cycle reviews ----------
const CLIENT_FIELDS = ["household_name", "community_id", "mailing_city", "region_id", "special_notes", "coverage_note", "treasurer_start_date", "active"];
const REVIEW_FIELDS = [
  "last_review_text", "last_review_date", "next_review_text", "next_review_date",
  "material_count", "assigned_rep_note", "review_notes", "done",
];

function resolveCycleId(req) {
  if (req.query.cycle_id) return Number(req.query.cycle_id);
  const c = currentCycle();
  return c ? c.id : null;
}

function clientWithReview(clientId, cycleId) {
  const client = db.prepare(`
    SELECT cl.*, c.name AS community_name, c.county, c.municipal_type, r.advisor, r.label AS region_label
    FROM clients cl
    LEFT JOIN communities c ON c.id = cl.community_id
    LEFT JOIN regions r ON r.id = cl.region_id
    WHERE cl.id = ?
  `).get(clientId);
  if (!client) return null;
  const review = db.prepare("SELECT * FROM reviews WHERE client_id = ? AND cycle_id = ?").get(clientId, cycleId);
  return { ...client, review: review || null };
}

app.get("/api/clients", (req, res) => {
  const cycleId = resolveCycleId(req);
  if (!cycleId) return res.status(400).json({ error: "no_active_cycle" });

  const { region, advisor, community_id, status, search, active } = req.query;
  let sql = `
    SELECT cl.*, c.name AS community_name, c.county, c.municipal_type, r.advisor, r.label AS region_label,
           rv.id AS review_id, rv.cycle_id, rv.last_review_text, rv.last_review_date,
           rv.next_review_text, rv.next_review_date, rv.material_count, rv.assigned_rep_note,
           rv.review_notes, rv.done, rv.version AS review_version, rv.updated_at AS review_updated_at,
           rv.updated_by AS review_updated_by
    FROM clients cl
    LEFT JOIN communities c ON c.id = cl.community_id
    LEFT JOIN regions r ON r.id = cl.region_id
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    WHERE 1=1
  `;
  const params = [cycleId];
  if (active === undefined || active === "1" || active === "true") sql += " AND cl.active = 1";
  if (region) { sql += " AND cl.region_id = ?"; params.push(region); }
  if (advisor) { sql += " AND r.advisor = ?"; params.push(advisor); }
  if (community_id) { sql += " AND cl.community_id = ?"; params.push(community_id); }
  if (status === "done") sql += " AND rv.done = 1";
  else if (status === "pending") sql += " AND (rv.done = 0 OR rv.done IS NULL)";
  if (search) {
    sql += " AND (cl.household_name LIKE ? OR c.name LIKE ? OR cl.special_notes LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  sql += " ORDER BY cl.region_id, c.name, cl.household_name";

  const rows = db.prepare(sql).all(...params).map((row) => {
    const { review_id, cycle_id, last_review_text, last_review_date, next_review_text, next_review_date,
            material_count, assigned_rep_note, review_notes, done, review_version, review_updated_at, review_updated_by,
            ...client } = row;
    return {
      ...client,
      review: review_id ? {
        id: review_id, cycle_id, last_review_text, last_review_date, next_review_text, next_review_date,
        material_count, assigned_rep_note, review_notes, done, version: review_version,
        updated_at: review_updated_at, updated_by: review_updated_by,
      } : null,
    };
  });
  res.json(rows);
});

app.get("/api/clients/:id", (req, res) => {
  const cycleId = resolveCycleId(req);
  const row = clientWithReview(req.params.id, cycleId);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

app.post("/api/clients", (req, res) => {
  const body = req.body || {};
  if (!body.household_name || !String(body.household_name).trim()) {
    return res.status(400).json({ error: "household_name_required" });
  }
  if (!body.region_id) return res.status(400).json({ error: "region_id_required" });
  const cycle = currentCycle();
  if (!cycle) return res.status(400).json({ error: "no_active_cycle" });

  const cCols = ["household_name", "region_id"];
  const cVals = [String(body.household_name).trim(), body.region_id];
  for (const f of ["community_id", "mailing_city", "special_notes", "coverage_note", "treasurer_start_date"]) {
    if (body[f] !== undefined) { cCols.push(f); cVals.push(body[f]); }
  }
  cCols.push("updated_by"); cVals.push(req.session.name || "unknown");

  let clientId;
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO clients (${cCols.join(", ")}) VALUES (${cCols.map(() => "?").join(", ")})`).run(...cVals);
    clientId = info.lastInsertRowid;

    const rCols = ["client_id", "cycle_id"];
    const rVals = [clientId, cycle.id];
    for (const f of REVIEW_FIELDS) {
      if (body[f] !== undefined) {
        rCols.push(f);
        rVals.push(f === "done" ? (body[f] ? 1 : 0) : body[f]);
      }
    }
    rCols.push("updated_by"); rVals.push(req.session.name || "unknown");
    db.prepare(`INSERT INTO reviews (${rCols.join(", ")}) VALUES (${rCols.map(() => "?").join(", ")})`).run(...rVals);

    logChange("client", clientId, "created", null, body.household_name, req.session.name || "unknown");
  });
  tx();

  maybeSync();
  res.status(201).json(clientWithReview(clientId, cycle.id));
});

// PATCH client-level fields (name, community, territory, persistent notes). Optimistic concurrency via client.version.
app.patch("/api/clients/:id", (req, res) => {
  const id = req.params.id;
  const current = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!current) return res.status(404).json({ error: "not_found" });

  const body = req.body || {};
  if (body.version === undefined) return res.status(400).json({ error: "version_required" });
  if (Number(body.version) !== current.version) {
    const cycleId = resolveCycleId(req);
    return res.status(409).json({ error: "conflict", detail: "Someone else updated this client since you loaded it.", current: clientWithReview(id, cycleId) });
  }

  const updates = []; const vals = []; const changedBy = req.session.name || "unknown"; const logEntries = [];
  for (const f of CLIENT_FIELDS) {
    if (body[f] === undefined) continue;
    const newVal = f === "active" ? (body[f] ? 1 : 0) : body[f];
    const oldVal = current[f];
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      updates.push(`${f} = ?`); vals.push(newVal); logEntries.push([f, oldVal, newVal]);
    }
  }
  if (updates.length === 0) {
    const cycleId = resolveCycleId(req);
    return res.json(clientWithReview(id, cycleId));
  }
  updates.push("version = version + 1", "updated_at = datetime('now')", "updated_by = ?");
  vals.push(changedBy, id);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE clients SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
    for (const [field, oldV, newV] of logEntries) logChange("client", id, field, oldV, newV, changedBy);
  });
  tx();

  maybeSync();
  const cycleId = resolveCycleId(req);
  res.json(clientWithReview(id, cycleId));
});

app.delete("/api/clients/:id", (req, res) => {
  const current = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "not_found" });
  db.prepare("UPDATE clients SET active = 0, version = version + 1, updated_at = datetime('now'), updated_by = ? WHERE id = ?").run(req.session.name || "unknown", req.params.id);
  logChange("client", req.params.id, "active", "1", "0", req.session.name || "unknown");
  maybeSync();
  res.json({ ok: true });
});

// ---------- reviews (per-cycle, mutable review fields) ----------
app.patch("/api/reviews/:id", (req, res) => {
  const id = req.params.id;
  const current = db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
  if (!current) return res.status(404).json({ error: "not_found" });

  const body = req.body || {};
  if (body.version === undefined) return res.status(400).json({ error: "version_required" });
  if (Number(body.version) !== current.version) {
    return res.status(409).json({ error: "conflict", detail: "Someone else updated this review since you loaded it.", current: clientWithReview(current.client_id, current.cycle_id) });
  }

  const updates = []; const vals = []; const changedBy = req.session.name || "unknown"; const logEntries = [];
  for (const f of REVIEW_FIELDS) {
    if (body[f] === undefined) continue;
    const newVal = f === "done" ? (body[f] ? 1 : 0) : body[f];
    const oldVal = current[f];
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      updates.push(`${f} = ?`); vals.push(newVal); logEntries.push([f, oldVal, newVal]);
    }
  }
  if (updates.length === 0) return res.json(clientWithReview(current.client_id, current.cycle_id));

  const nowDoneTrue = body.done && !current.done;
  const nowDoneFalse = body.done === false && current.done;
  if (nowDoneTrue) { updates.push("completed_at = datetime('now')"); }
  if (nowDoneFalse) { updates.push("completed_at = NULL"); }

  updates.push("version = version + 1", "updated_at = datetime('now')", "updated_by = ?");
  vals.push(changedBy, id);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE reviews SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
    for (const [field, oldV, newV] of logEntries) logChange("review", id, field, oldV, newV, changedBy);
  });
  tx();

  maybeSync();
  res.json(clientWithReview(current.client_id, current.cycle_id));
});

app.get("/api/clients/:id/history", (req, res) => {
  const rows = db.prepare(`
    SELECT cl.id AS client_history_owner, 'client' AS kind, cg.* FROM change_log cg
    JOIN clients cl ON cl.id = cg.entity_id AND cg.entity_type = 'client'
    WHERE cl.id = ?
    UNION ALL
    SELECT rv.client_id AS client_history_owner, 'review' AS kind, cg.* FROM change_log cg
    JOIN reviews rv ON rv.id = cg.entity_id AND cg.entity_type = 'review'
    WHERE rv.client_id = ?
    ORDER BY changed_at DESC
  `).all(req.params.id, req.params.id);
  res.json(rows);
});

// ---------- dashboard ----------
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function isoMonthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

app.get("/api/dashboard", (req, res) => {
  const cycleId = resolveCycleId(req);
  if (!cycleId) return res.status(400).json({ error: "no_active_cycle" });

  const perAdvisor = db.prepare(`
    SELECT r.advisor, COUNT(cl.id) AS total, SUM(CASE WHEN rv.done = 1 THEN 1 ELSE 0 END) AS done
    FROM clients cl
    JOIN regions r ON r.id = cl.region_id
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    WHERE cl.active = 1
    GROUP BY r.advisor ORDER BY r.advisor
  `).all(cycleId).map((r) => ({ ...r, pct_done: r.total > 0 ? r.done / r.total : 0 }));

  const perRegion = db.prepare(`
    SELECT r.id AS region, r.label, r.advisor, COUNT(cl.id) AS total, SUM(CASE WHEN rv.done = 1 THEN 1 ELSE 0 END) AS done
    FROM clients cl
    JOIN regions r ON r.id = cl.region_id
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    WHERE cl.active = 1
    GROUP BY r.id ORDER BY r.id
  `).all(cycleId).map((r) => ({ ...r, pct_done: r.total > 0 ? r.done / r.total : 0 }));

  const totals = cycleStats(cycleId);

  // "Upcoming" means strictly today-or-later -- a next_review_date that's
  // already passed shouldn't show up here even if it's still unchecked
  // (that's an overdue item, not an upcoming one).
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = db.prepare(`
    SELECT cl.id, cl.household_name, c.name AS community_name, rv.next_review_date, rv.next_review_text, r.advisor
    FROM reviews rv
    JOIN clients cl ON cl.id = rv.client_id
    LEFT JOIN communities c ON c.id = cl.community_id
    JOIN regions r ON r.id = cl.region_id
    WHERE rv.cycle_id = ? AND cl.active = 1 AND rv.done = 0
      AND rv.next_review_date IS NOT NULL AND rv.next_review_date >= ?
    ORDER BY rv.next_review_date ASC LIMIT 15
  `).all(cycleId, todayIso);

  const cycle = db.prepare("SELECT * FROM cycles WHERE id = ?").get(cycleId);

  // Reviews over 1 year old: the most recent *actual* review for each
  // active client -- prefer the precise completed_at timestamp (set the
  // moment someone checks "done"), falling back to whatever last-review
  // date is on file when there's no completed_at (e.g. a client that
  // came in already marked done from the original spreadsheet migration,
  // which had no timestamp to give it) -- is more than a year in the
  // past, or there's no review on record at all either way.
  const oneYearAgo = isoDaysAgo(365);
  const staleCandidates = db.prepare(`
    SELECT cl.id, cl.household_name, c.name AS community_name, r.advisor,
           COALESCE(date(rv.completed_at), rv.last_review_date) AS effective_last_review
    FROM clients cl
    JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    LEFT JOIN communities c ON c.id = cl.community_id
    JOIN regions r ON r.id = cl.region_id
    WHERE cl.active = 1
  `).all(cycleId);
  const staleReviewsList = staleCandidates
    .filter((r) => !r.effective_last_review || r.effective_last_review < oneYearAgo)
    .sort((a, b) => (a.effective_last_review || "").localeCompare(b.effective_last_review || ""));
  const staleReviews = { count: staleReviewsList.length, list: staleReviewsList.slice(0, 25) };

  // % of active reviews completed in the last 30 days -- a pace/momentum
  // indicator (how much is getting done lately), not tied to a due date.
  const thirtyDaysAgo = isoDaysAgo(30);
  const completedLast30Count = db.prepare(`
    SELECT COUNT(*) AS n FROM reviews rv JOIN clients cl ON cl.id = rv.client_id
    WHERE rv.cycle_id = ? AND cl.active = 1 AND rv.done = 1
      AND rv.completed_at IS NOT NULL AND date(rv.completed_at) >= ?
  `).get(cycleId, thirtyDaysAgo).n;
  const completedLast30 = {
    count: completedLast30Count,
    totalActive: totals.total || 0,
    pct: totals.total ? completedLast30Count / totals.total : 0,
  };

  // Towns/clients with a new treasurer in the last 6 months (by
  // treasurer_start_date), unless a review has already been completed for
  // them within that same window -- that's treated as the team having
  // already caught up with the new treasurer, so it drops off this list.
  // Checked against every review ever recorded for the client (not just
  // this cycle), since a qualifying review could have landed in a cycle
  // that's since closed.
  const sixMonthsAgo = isoMonthsAgo(6);
  const treasurerCandidates = db.prepare(`
    SELECT cl.id, cl.household_name, c.name AS community_name, r.advisor, cl.treasurer_start_date,
           (SELECT MAX(rv2.completed_at) FROM reviews rv2 WHERE rv2.client_id = cl.id AND rv2.done = 1) AS last_completed_at
    FROM clients cl
    LEFT JOIN communities c ON c.id = cl.community_id
    JOIN regions r ON r.id = cl.region_id
    WHERE cl.active = 1 AND cl.treasurer_start_date IS NOT NULL AND cl.treasurer_start_date >= ?
  `).all(sixMonthsAgo);
  const newTreasurersList = treasurerCandidates
    .filter((r) => !r.last_completed_at || r.last_completed_at.slice(0, 10) < sixMonthsAgo)
    .sort((a, b) => (b.treasurer_start_date || "").localeCompare(a.treasurer_start_date || ""));
  const newTreasurers = { count: newTreasurersList.length, list: newTreasurersList };

  res.json({
    cycle,
    perAdvisor, perRegion,
    totals: { total: totals.total || 0, done: totals.done || 0, pct_done: totals.total ? totals.done / totals.total : 0 },
    upcoming,
    staleReviews, completedLast30, newTreasurers,
  });
});

// ---------- export / datawrapper ----------
// One row per town (all 351) -- this is exactly what gets pushed to the
// live Datawrapper map, so downloading this shows exactly what it'll see.
app.get("/api/export/datawrapper.csv", (req, res) => {
  const csv = buildTownCsv(db, req.query.cycle_id ? Number(req.query.cycle_id) : undefined);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=datawrapper-export.csv");
  res.send(csv);
});

// One row per client -- a flat detail/audit export, not what's synced to the map.
app.get("/api/export/clients.csv", (req, res) => {
  const csv = buildClientCsv(db, req.query.cycle_id ? Number(req.query.cycle_id) : undefined);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=clients-export.csv");
  res.send(csv);
});

app.post("/api/sync/datawrapper", async (req, res) => {
  try {
    res.json(await syncToDatawrapper(db));
  } catch (e) {
    res.status(500).json({ error: "sync_failed", detail: e.message });
  }
});

let syncTimer = null;
function maybeSync() {
  if (!AUTO_SYNC_DATAWRAPPER) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncToDatawrapper(db).catch((e) => console.error("Datawrapper auto-sync failed:", e.message));
  }, 5000);
}

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "not_found" });
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Municipal Client Tracker listening on :${PORT}`);
});
