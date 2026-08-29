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
 * (one row per CLIENT, including its community and region). Open the
 * existing Datawrapper chart's "Data" tab once after first deploy and
 * confirm the column names line up with what the map is keyed on --
 * adjust buildCsv() below if not.
 */

const DW_API = "https://api.datawrapper.de/v3";

function getCurrentCycleId(db) {
  const row = db.prepare("SELECT id FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get();
  return row ? row.id : null;
}

// One row per active client -- each client carries its own community,
// county, municipal type, region/territory, and advisor, plus this
// cycle's review status.
function buildCsv(db, cycleId) {
  const cid = cycleId || getCurrentCycleId(db);
  const rows = db.prepare(`
    SELECT
      cl.household_name,
      c.name AS community,
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
    "household_name", "community", "municipal_type", "county",
    "region", "region_label", "advisor", "done",
    "last_review", "next_review",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const vals = [
      row.household_name, row.community || "", row.municipal_type || "", row.county || "",
      row.region || "", row.region_label || "", row.advisor || "", row.done ? "Yes" : "No",
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
