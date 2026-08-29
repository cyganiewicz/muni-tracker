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
 * IMPORTANT: this ships with a *reasonable guess* at the CSV columns
 * (see buildCsv() below). Open the existing Datawrapper chart's "Data"
 * tab once after first deploy and confirm the column names line up with
 * what the map is keyed on -- adjust buildCsv() below if not.
 *
 * The `datawrapper_code` column is populated from
 * migration/ma_towns_canonical.json, matched from a Datawrapper-exported
 * key file for Massachusetts municipalities -- if the map uses Datawrapper's
 * built-in MA basemap, this is very likely the actual id it matches rows on
 * (more reliable than matching by town name spelling).
 */

const DW_API = "https://api.datawrapper.de/v3";

function getCurrentCycleId(db) {
  const row = db.prepare("SELECT id FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get();
  return row ? row.id : null;
}

// One row per active client, PLUS one row for every community that has no
// active client at all (so all 351 MA towns are represented on the map,
// not just the ones we currently have a client in -- a prospect town
// should still show up, just with no client/done data).
function buildCsv(db, cycleId) {
  const cid = cycleId || getCurrentCycleId(db);
  const rows = db.prepare(`
    SELECT
      cl.household_name,
      c.name AS community,
      c.datawrapper_code,
      cl.mailing_city,
      c.municipal_type,
      c.county,
      c.status AS community_status,
      r.id AS region,
      r.label AS region_label,
      r.advisor,
      rv.done,
      rv.last_review_text,
      rv.last_review_date,
      rv.next_review_text,
      rv.next_review_date
    FROM communities c
    LEFT JOIN regions r ON r.id = c.region_id
    LEFT JOIN clients cl ON cl.community_id = c.id AND cl.active = 1
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    ORDER BY c.name, cl.household_name
  `).all(cid);

  const header = [
    "household_name", "community", "datawrapper_code", "mailing_city", "municipal_type", "county",
    "region", "region_label", "advisor", "has_client", "done",
    "last_review", "next_review",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const hasClient = !!row.household_name;
    const vals = [
      row.household_name || "", row.community || "", row.datawrapper_code || "", row.mailing_city || "",
      row.municipal_type || "", row.county || "",
      row.region || "", row.region_label || "", row.advisor || "",
      hasClient ? "Yes" : "No",
      hasClient ? (row.done ? "Yes" : "No") : "",
      row.last_review_text || row.last_review_date || "",
      row.next_review_text || row.next_review_date || "",
    ].map((v) => {
      const s = String(v ?? "");
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
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

  const csv = buildCsv(db);

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

module.exports = { buildCsv, syncToDatawrapper, getCurrentCycleId };
