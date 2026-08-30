/**
 * Pushes the current cycle's dataset to a Datawrapper chart/map via their
 * public API (https://developer.datawrapper.de/reference/putchartsiddata).
 *
 * Requires two env vars:
 *   DATAWRAPPER_API_TOKEN  - a Datawrapper API token (Account Settings > API Tokens)
 *   DATAWRAPPER_CHART_ID   - the chart ID from the map's URL, e.g. for
 *                            https://datawrapper.dwcdn.net/TvOY0/6/ the id is "TvOY0"
 *
 * If either is missing, sync is a no-op (safe to leave unconfigured while
 * testing) and callers get { skipped: true } back.
 *
 * Two different exports, for two different jobs:
 *
 *  - buildTownCsv(): ONE ROW PER TOWN (all 351), which is what actually
 *    feeds the live map / the auto-sync. Datawrapper's tooltip templates
 *    ({{column}}) do simple substitution from whichever single CSV row
 *    matched that map area/marker -- they do NOT loop over multiple rows
 *    that share the same town. So a town with several clients can only
 *    bind to one row; to make "{{household_name}}" show all of them in
 *    one hover, this pre-joins every client's name in that town into a
 *    single cell with <br> already in it (Datawrapper tooltips render
 *    basic HTML, so that line-breaks correctly).
 *
 *  - buildClientCsv(): one row per client (the detailed, audit-style
 *    export) -- not what's synced to the map, but useful as a plain data
 *    dump. Available at /api/export/clients.csv.
 *
 * IMPORTANT: open the existing Datawrapper chart's "Data" tab once after
 * a sync and confirm the column names below line up with what the map is
 * actually keyed on / what its tooltip template expects -- adjust as
 * needed. The `datawrapper_code` column is populated from
 * migration/ma_towns_canonical.json (sourced from a Datawrapper-exported
 * key file for MA municipalities) -- if the map uses Datawrapper's built-in
 * MA basemap, this is very likely the actual id it matches rows on, more
 * reliable than matching by town name spelling.
 */

const DW_API = "https://api.datawrapper.de/v3";

function csvEscape(v) {
  const s = String(v ?? "");
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function getCurrentCycleId(db) {
  const row = db.prepare("SELECT id FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get();
  return row ? row.id : null;
}

// ONE ROW PER TOWN (all 351) -- what feeds the map. Multiple clients in
// the same town are joined into a single household_name cell with <br>
// between them, e.g. "BECKET, TOWN OF<br>BECKET BROADBAND DISTRICT", so a
// tooltip template referencing {{household_name}} lists all of them.
function buildTownCsv(db, cycleId) {
  const cid = cycleId || getCurrentCycleId(db);
  const clientRows = db.prepare(`
    SELECT
      c.id AS community_id,
      cl.household_name,
      rv.done,
      rv.next_review_date
    FROM communities c
    JOIN clients cl ON cl.community_id = c.id AND cl.active = 1
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    ORDER BY cl.household_name
  `).all(cid);

  const byCommunity = new Map();
  for (const r of clientRows) {
    if (!byCommunity.has(r.community_id)) byCommunity.set(r.community_id, []);
    byCommunity.get(r.community_id).push(r);
  }

  const towns = db.prepare(`
    SELECT c.id, c.name AS community, c.datawrapper_code, c.municipal_type, c.county,
           r.id AS region, r.label AS region_label, r.advisor
    FROM communities c
    LEFT JOIN regions r ON r.id = c.region_id
    ORDER BY c.name
  `).all();

  const header = [
    "community", "datawrapper_code", "municipal_type", "county",
    "region", "region_label", "advisor", "has_client",
    "client_count", "done_count", "pct_done", "household_name", "next_upcoming_review",
  ];
  const lines = [header.join(",")];

  for (const t of towns) {
    const clients = byCommunity.get(t.id) || [];
    const clientCount = clients.length;
    const doneCount = clients.filter((c) => c.done).length;
    const pctDone = clientCount > 0 ? Math.round((doneCount / clientCount) * 100) : "";
    const householdNames = clients.map((c) => c.household_name).join("<br>");
    const upcoming = clients
      .filter((c) => !c.done && c.next_review_date)
      .map((c) => c.next_review_date)
      .sort()[0] || "";

    // Every one of the 351 towns gets a row even with zero clients -- this
    // is how a zero-client town still shows up on the map as a prospect
    // instead of being blank/absent.
    const vals = [
      t.community, t.datawrapper_code || "", t.municipal_type || "", t.county || "",
      t.region || "", t.region_label || "", t.advisor || "", clientCount > 0 ? "Yes" : "No",
      clientCount, doneCount, pctDone, householdNames, upcoming,
    ].map(csvEscape);
    lines.push(vals.join(","));
  }
  return lines.join("\n");
}

// One row per active client (detail/audit export -- not what's synced to
// the map). Available at /api/export/clients.csv.
function buildClientCsv(db, cycleId) {
  const cid = cycleId || getCurrentCycleId(db);
  const rows = db.prepare(`
    SELECT
      cl.household_name,
      c.name AS community,
      c.datawrapper_code,
      cl.mailing_city,
      c.municipal_type,
      c.county,
      r.id AS region,
      r.label AS region_label,
      r.advisor,
      rv.done,
      rv.last_review_text,
      rv.last_review_date,
      rv.next_review_text,
      rv.next_review_date
    FROM clients cl
    LEFT JOIN communities c ON c.id = cl.community_id
    LEFT JOIN regions r ON r.id = cl.region_id
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    WHERE cl.active = 1
    ORDER BY c.name, cl.household_name
  `).all(cid);

  const header = [
    "household_name", "community", "datawrapper_code", "mailing_city", "municipal_type", "county",
    "region", "region_label", "advisor", "done", "last_review", "next_review",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const vals = [
      row.household_name, row.community || "", row.datawrapper_code || "", row.mailing_city || "",
      row.municipal_type || "", row.county || "",
      row.region || "", row.region_label || "", row.advisor || "", row.done ? "Yes" : "No",
      row.last_review_text || row.last_review_date || "",
      row.next_review_text || row.next_review_date || "",
    ].map(csvEscape);
    lines.push(vals.join(","));
  }
  return lines.join("\n");
}

async function syncToDatawrapper(db) {
  const token = process.env.DATAWRAPPER_API_TOKEN;
  const chartId = process.env.DATAWRAPPER_CHART_ID;
  if (!token || !chartId) {
    return { skipped: true, reason: "DATAWRAPPER_API_TOKEN / DATAWRAPPER_CHART_ID not configured" };
  }

  const csv = buildTownCsv(db);

  const dataRes = await fetch(`${DW_API}/charts/${chartId}/data`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/csv",
    },
    body: csv,
  });
  if (!dataRes.ok) {
    const text = await dataRes.text().catch(() => "");
    throw new Error(`Datawrapper data upload failed: ${dataRes.status} ${text}`);
  }

  const publishRes = await fetch(`${DW_API}/charts/${chartId}/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!publishRes.ok) {
    const text = await publishRes.text().catch(() => "");
    throw new Error(`Datawrapper publish failed: ${publishRes.status} ${text}`);
  }

  return { skipped: false, ok: true, syncedAt: new Date().toISOString() };
}

module.exports = { buildTownCsv, buildClientCsv, syncToDatawrapper, getCurrentCycleId };
