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
 * (one row per community, with client/done counts). Open the existing
 * Datawrapper chart's "Data" tab once after first deploy and confirm the
 * column names line up with what the map is keyed on -- adjust buildCsv()
 * below if not.
 */

const DW_API = "https://api.datawrapper.de/v3";

function getCurrentCycleId(db) {
  const row = db.prepare("SELECT id FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get();
  return row ? row.id : null;
}

function buildCsv(db, cycleId) {
  const cid = cycleId || getCurrentCycleId(db);
  const rows = db.prepare(`
    SELECT
      c.name AS community,
      c.municipal_type,
      c.county,
      r.advisor,
      r.id AS region,
      COUNT(cl.id) AS clients,
      SUM(CASE WHEN rv.done = 1 THEN 1 ELSE 0 END) AS done
    FROM communities c
    LEFT JOIN clients cl ON cl.community_id = c.id AND cl.active = 1
    LEFT JOIN reviews rv ON rv.client_id = cl.id AND rv.cycle_id = ?
    LEFT JOIN regions r ON r.id = c.region_id
    GROUP BY c.id
    ORDER BY c.name
  `).all(cid);

  const header = ["community", "municipal_type", "county", "advisor", "region", "clients", "done", "pct_done"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const pct = row.clients > 0 ? Math.round((row.done / row.clients) * 100) : 0;
    const vals = [
      row.community, row.municipal_type || "", row.county || "",
      row.advisor || "", row.region || "", row.clients || 0, row.done || 0, pct,
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
