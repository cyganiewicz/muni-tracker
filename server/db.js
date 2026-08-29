const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "tracker.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

function isSeeded() {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").get();
  return !!row;
}

function markSeeded() {
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded', '1')").run();
}

function seedIfEmpty() {
  if (isSeeded()) return;

  const teamNames = (process.env.TEAM_NAMES || "Sue,Brian,Kath,Michelle,Assistant")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const insertTeamMember = db.prepare("INSERT OR IGNORE INTO team_members (name) VALUES (?)");
  const tmTx = db.transaction(() => { for (const n of teamNames) insertTeamMember.run(n); });
  tmTx();

  const seedPath = process.env.SEED_FILE || path.join(__dirname, "..", "migration", "seed.json");
  if (!fs.existsSync(seedPath)) {
    console.log("No seed.json found, starting with an empty database (still created default team members and an initial cycle).");
    db.prepare("INSERT INTO cycles (label, started_by) VALUES (?, 'system')").run("Cycle 1");
    markSeeded();
    return;
  }

  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const insertRegion = db.prepare(
    "INSERT OR IGNORE INTO regions (id, label, advisor) VALUES (?, ?, ?)"
  );
  const insertCommunity = db.prepare(
    "INSERT OR IGNORE INTO communities (name, municipal_type, county, region_id, status) VALUES (?, ?, ?, ?, ?)"
  );
  const getCommunityId = db.prepare("SELECT id FROM communities WHERE name = ?");
  const insertCycle = db.prepare("INSERT INTO cycles (label, started_by) VALUES (?, 'migration')");
  const insertClient = db.prepare(`
    INSERT INTO clients (
      household_name, community_id, mailing_city, region_id,
      special_notes, coverage_note, active, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'migration')
  `);
  const insertReview = db.prepare(`
    INSERT INTO reviews (
      client_id, cycle_id,
      last_review_text, last_review_date, next_review_text, next_review_date,
      material_count, assigned_rep_note, done, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration')
  `);

  const tx = db.transaction(() => {
    for (const r of seed.regions) {
      insertRegion.run(r.id, `${r.id}-${r.advisor}`, r.advisor);
    }
    for (const c of seed.communities) {
      insertCommunity.run(c.name, c.municipal_type, c.county, c.region || null, c.status || "client");
    }
    const cycleInfo = insertCycle.run("FY26");
    const cycleId = cycleInfo.lastInsertRowid;

    for (const cl of seed.clients) {
      let communityId = null;
      if (cl.community) {
        const row = getCommunityId.get(cl.community);
        communityId = row ? row.id : null;
      }
      const clientInfo = insertClient.run(
        cl.household_name,
        communityId,
        cl.mailing_city || null,
        cl.region,
        cl.special_notes || null,
        cl.coverage_note || null
      );
      insertReview.run(
        clientInfo.lastInsertRowid,
        cycleId,
        cl.last_review_text || null,
        cl.last_review_date || null,
        cl.next_review_text || null,
        cl.next_review_date || null,
        cl.material_count != null ? cl.material_count : null,
        cl.assigned_rep_note || null,
        cl.done ? 1 : 0
      );
    }
  });
  tx();
  markSeeded();
  console.log(`Seeded ${seed.clients.length} clients across ${seed.communities.length} communities into cycle "FY26".`);
}

seedIfEmpty();

module.exports = db;
