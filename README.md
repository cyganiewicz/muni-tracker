# Municipal Client Tracker

A small, real web app that replaces the "FY 26 Review Sheet" shared-drive
Excel file. It fixes the specific problem you had — people saving over each
other's edits — by having every edit go through a server as a discrete,
per-record save instead of a whole-file overwrite. If two people edit the
same client at nearly the same moment, the second save is rejected with a
clear "someone else just updated this" message instead of silently winning
or losing.

One nuance worth knowing: a client's static details (name, town, notes) and
its current-cycle review (dates, done status, etc.) are two separate
records under the hood, each with their own conflict check. They save
independently — a conflict on one never blocks or silently drops the
other. This matters most for the "Review complete" checkbox: if someone
else happened to edit that same client's notes at nearly the same moment,
you'll be told that specific part needs to be redone, but your review
completion still goes through and still counts. Marking a review done is
never lost to an unrelated conflict.

What's included:

- A shared client roster (household/entity name, community/town, review
  dates, notes, done status) grouped by the same 16 advisor territories as
  the old workbook (already migrated in — see **Data migration** below).
- Support for a municipality having multiple linked client accounts (e.g. a
  Town and a separate water/broadband/library district in the same place) —
  add them as separate clients under the same community.
- A dashboard mirroring your old Dashboard tab: % complete per advisor, per
  territory, a list of upcoming reviews, and a few extra metrics worth
  keeping an eye on — see **Dashboard metrics** below.
- One-click CSV export, and automatic push to your Datawrapper map whenever
  data changes (once you configure it — see below).
- A change history on every client record, so if something looks wrong you
  can see who changed what and when.
- Shared team access with one password (no individual accounts to manage) —
  each person just picks their name from a dropdown when they sign in.
- An **Admin panel** (separate password) for managing reps and territories,
  and for starting a new review cycle.
- **Review cycles**: "done", next-review date, material count etc. are all
  scoped to the current cycle. Starting a new cycle resets everyone to
  "not done" for the next round without deleting anything — old cycles stay
  browsable on the Dashboard for history/trend.
- Real autocomplete on the Community/Town and Mailing City fields when
  adding or editing a client, so spelling stays consistent for the map.
- An optional embedded view of your Datawrapper map right on the Dashboard.
- Bartholomew & Company branding — full logo on the sign-in screen, the "B"
  mark in the app header.

## Logo files

`public/img/bartco-black.png` (full logo) and `public/img/bartco-black-B.png`
(the "B" mark) need to live at exactly those paths for the app to find them.
They're already included in this delivery — if you'd separately added your
own copies elsewhere in the repo, either delete those or just make sure the
ones at `public/img/` are the ones you want, since that's the path the code
references.

## How it's built

Plain Node.js/Express backend + SQLite (a single database file, no separate
database service to pay for or manage) + a plain HTML/JS frontend (no build
step). This keeps it cheap to run and easy for someone else to maintain
later if needed.

```
server/     the API + database
public/     the web UI
migration/  the one-time import from your old Excel file (already run — see seed.json)
```

## Running it locally (to try it out first)

You'll need [Node.js](https://nodejs.org) 18+ installed.

```
cd server
npm install
cp ../.env.example .env
# edit .env and set APP_PASSWORD to something real
npm start
```

Then open http://localhost:8080 — sign in with the password you set and
your name. The database seeds itself automatically from
`migration/seed.json` the first time it starts (342 clients, matching your
old dashboard's totals exactly).

## Deploying it for real (so your team can use it from anywhere)

This needs to live somewhere permanently online. I can't host it myself —
it has to run on a service under your account so it keeps running and the
data stays put. **Railway** is the easiest fit (free tier is enough for a
team this size, and it supports a persistent disk so the database doesn't
get wiped on redeploy):

1. Create a free account at [railway.app](https://railway.app).
2. New Project → **Deploy from GitHub repo** (push this folder to a new
   GitHub repo first — private is fine), or **Empty Project** and use their
   CLI (`railway up`) to deploy this folder directly without GitHub.
3. Once deployed, open the service's **Variables** tab and add everything
   from `.env.example` (at minimum `APP_PASSWORD`, `SESSION_SECRET`,
   `TEAM_NAMES`).
4. Add a **Volume**: on the service, go to Settings → Volumes → mount it at
   `/app/data` (that path is already baked into the Dockerfile as the
   default `DATA_DIR`, so you don't need to set that variable yourself —
   just make sure the volume's mount path matches). This is the step that
   makes your data survive redeploys — don't skip it.
5. Railway gives you a public URL (e.g. `yourapp.up.railway.app`) — that's
   the link your wife's team uses. You can attach a custom domain later
   under Settings → Domains if you want something nicer.

**Render** works the same way if you'd rather use that (Web Service +
a Disk mounted at `/app/data`, same env vars). A `Dockerfile` is included
so either platform (or any other that runs Docker) will work without
changes.

## Data migration (already done)

`migration/export_from_excel.py` reads your uploaded workbook and produced
`migration/seed.json`, which the app loads on first boot. It cross-checked
itself against your old Dashboard tab's numbers — 342 total clients, 18
done, and the exact same count in every one of the 16 territories — so the
migration is a faithful copy, not a guess. It also cleaned up a few known
data-entry artifacts (e.g. the Goshen row, which had gotten its City/
Community columns shifted when it was manually moved between tabs).

If you find something migrated wrong, it's much easier to just fix it in
the app itself (each field saves independently) than to re-run the import.

## The full Massachusetts town list

The **Community/Town** field (when adding or editing a client) offers all
351 Massachusetts cities and towns as autocomplete suggestions — not just
the ones that already have a client — each pre-linked to the correct
territory/region. Picking a known town auto-assigns its territory for you;
you don't need to know or look up which region number a town belongs to.

This list lives in `migration/ma_towns_canonical.json` (name, municipal
type, county, region, and a Datawrapper matching code — see below) and is
kept in sync with the database automatically **on every server start**,
not just the first one — so if that file is ever updated (a town added, a
territory reassigned) and redeployed, existing client data is untouched;
only the reference town list refreshes. Source data:
`migration/datawrapper_ma_town_codes.csv` supplied the per-town Datawrapper
matching codes; the town/type/county/region list itself came from you.

## Datawrapper auto-sync

Set two environment variables to turn this on:

- `DATAWRAPPER_API_TOKEN` — Datawrapper account → Settings → API Tokens →
  create one with chart-edit permission.
- `DATAWRAPPER_CHART_ID` — the id in your map's URL. Your dashboard tab had
  `https://datawrapper.dwcdn.net/TvOY0/6/`, so that id is `TvOY0`.

Once both are set, every client edit pushes an updated dataset to that
chart automatically (batched — it waits 5 seconds after the last edit
before pushing, so a flurry of changes becomes one update, not dozens).

### Two exports, for two different jobs

There are actually two CSV exports now, because they serve different
purposes:

- **Map export** (`/api/export/datawrapper.csv`, the "Export map CSV"
  button) — this is exactly what gets pushed to the live map. It has
  **one row per town, for all 351 MA towns, no more and no fewer.** A town
  with several clients (say, a Town Hall and a separate water/broadband
  district) does **not** get multiple rows — it gets one row whose
  `household_name` column contains every client's name in that town,
  joined with `<br>` between them. A town with zero clients still gets its
  own row, with `has_client` = "No", an empty `household_name`, and
  `client_count` = 0 — so it shows up on the map as a prospect instead of
  being blank or absent. Columns: `community, datawrapper_code,
  municipal_type, county, region, region_label, advisor, has_client,
  client_count, done_count, pct_done, household_name,
  next_upcoming_review`.

- **Client list export** (`/api/export/clients.csv`, the "Export client
  list CSV" button) — the flat, one-row-per-client detail/audit export
  (342 rows). This is *not* what's synced to the map; it's just a plain
  data dump for when you want to see every client's own row, including
  `mailing_city`. Columns: `household_name, community, datawrapper_code,
  mailing_city, municipal_type, county, region, region_label, advisor,
  done, last_review, next_review`.

**Why the split:** Datawrapper's tooltip templates (the `{{column}}`
syntax you use when annotating the map) do simple substitution from
whichever single CSV row matched that map area — they don't loop over
multiple rows that happen to share the same town. If the map export had
one row per client (like it briefly did), a town with several clients
would only ever bind to one of those rows, and a tooltip referencing
`{{household_name}}` would silently show just one client and drop the
rest. Pre-joining the names into one cell, one row per town, is what
makes a tooltip like

```
Region: {{region}} <hr>
<b>Clients:</b>
{{ household_name }}<br>
```

correctly list *every* client in that town, each on its own line,
because Datawrapper tooltips render basic HTML and `<br>` is already baked
into the cell. You don't need to change that template — `household_name`
is still the column name, it just now holds a multi-line value when a
town has more than one client.

`datawrapper_code` is each town's id from the file you provided
(`migration/datawrapper_ma_town_codes.csv`) — since Datawrapper itself
generated that file, it's very likely the actual key its Massachusetts
basemap matches rows on, which is more reliable than matching by town
name spelling. **One thing to check yourself:** I haven't seen your live
chart's own data table, so confirm in Datawrapper's "Data" tab that it's
actually matching on this column (or on `community`, or something else)
— adjust `server/datawrapper.js`'s `buildTownCsv()` if not. You can always
fetch `/api/export/datawrapper.csv` to see exactly what gets sent to the
map, or `/api/export/clients.csv` for the per-client detail list.

## Admin panel

Set `ADMIN_PASSWORD` in your environment variables to turn this on (leave
it blank to disable the admin panel entirely). Anyone who knows that
password can click **Admin sign-in** in the top bar to unlock it for their
session. From there:

- **Reps** — add a new rep, rename one, or deactivate one (deactivating
  just removes them from the sign-in dropdown; it doesn't touch any of
  their past history).
- **Territories** — rename a territory's label or reassign which advisor
  owns it, or add a brand-new territory.
- **Review cycles** — see below.

Note on the security model here: since regular sign-in has no per-person
password (by design, per what you asked for), "admin" is enforced by a
*second* shared password, not by which name someone picked. Anyone who
knows the admin password gets admin powers, regardless of whose name
they're signed in as. That's consistent with the rest of this app's trust
level (a small internal team) — if you want it tied to specific people
instead, that's the next upgrade, along with individual logins.

## Review cycles (the "reset for next quarter" problem)

Every client's "done" status, next-review date, material count, and
assigned rep are scoped to a **review cycle** — the app starts you off with
one (labeled "FY26", carried over from your old sheet). When it's time to
start the next round — quarterly, bi-annually, whatever cadence works —
an admin goes to **Admin → Review cycles**, types a label (e.g. "Q2 2027"),
and clicks **Start new cycle**. That:

- Closes out the current cycle exactly as it stood (nothing is deleted —
  every note, date, and done-checkbox stays intact and viewable).
- Creates a fresh, unchecked review for every active client in the new
  cycle, with the last cycle's "next review" date automatically carried
  forward as this cycle's "last review" (and material count / assigned rep
  carried forward as a starting point, since those tend to repeat).
- Nobody has to manually uncheck 342 boxes.

The Dashboard's "Review cycle history" table lets you look back at any
past cycle's completion numbers — that's your quarter-over-quarter or
year-over-year tracking without any extra spreadsheet.

One thing this doesn't do automatically: it won't fire itself on a
schedule (quarterly, etc.) — someone has to click the button when your
team is ready to start the next round. That's deliberate (auto-resetting
live data on a timer felt risky without knowing your exact cadence), but
if you'd rather it happen automatically I can add that.

## Dashboard metrics

Beyond the original % complete by advisor/territory and the upcoming-reviews
list, the Dashboard tracks three more things:

- **Reviews over 1 year old** — a count (plus a table of the oldest 25) of
  active clients whose most recent *actual* review is more than a year in
  the past, or who have no review on record at all. "Most recent actual
  review" means: the exact timestamp a review was marked done (see below),
  falling back to whatever last-review date is on file when there's no
  timestamp — which mainly covers clients that came in already marked done
  from the original spreadsheet migration, which had no timestamp to give
  them. This is meant to surface accounts that are quietly going stale even
  if nobody's actively flagged them.
- **Completed in last 30 days** — the % (and raw count, out of all active
  clients) of reviews marked done within the past 30 days. This is a pace
  indicator — how much is actually getting done lately — not a measure of
  whether anyone's behind schedule.
- **New treasurers (last 6 months)** — a table of clients whose **Treasurer
  start date** (a new persistent field on the client — see below) falls
  within the last 6 months, meant to flag towns where a review might be
  worth prioritizing because whoever's handling the account changed
  recently. A client drops off this list once a review has been completed
  for them within that same 6-month window — the assumption being that if
  you've already met with the new treasurer, you don't need a second
  flag telling you to.

### Last review date, and how "done" drives these metrics

The client form now has a real **Last review date** field (it existed in
the database before, but nothing in the UI actually let anyone set it —
only the free-text "Last review — note" field was ever saved). Two things
now use it:

- **Auto-fill on completion.** When you check "Review complete," Last
  review date automatically fills in with whatever was in Next review
  date — the idea being that if the review happened, it happened on/around
  when it was scheduled. You can always type over it with a different date
  before saving if the actual review happened on a different day.
- **This is purely a record-keeping convenience and does not touch the
  "completed in last 30 days" metric.** That metric — and the precise
  timestamp behind "Reviews over 1 year old" — is driven entirely by
  `completed_at`, a separate, invisible timestamp the server stamps the
  instant the "done" checkbox actually flips from unchecked to checked.
  Editing Last review date, whether auto-filled or typed in by hand, never
  changes `completed_at`. That's deliberate: your team wants to track how
  much is actually getting done during the review cycle, and that has to
  stay tied to the real moment someone checked the box, not to a
  schedule-derived date that could be edited.

### Treasurer start date

A new field on each client, alongside Coverage note in the edit form —
persists across review cycles just like the coverage note and client notes
do, since it's a fact about the account, not about any one review. Leave it
blank for clients where this doesn't apply or isn't known; it's entirely
optional and only clients with a date set are ever considered for the
"new treasurers" metric.

## Datawrapper map embed on the Dashboard

Set `DATAWRAPPER_EMBED_URL` to the exact iframe URL from your chart's
Datawrapper "Publish & Embed" tab (looks like
`https://datawrapper.dwcdn.net/TvOY0/6/` — note the version number at the
end) and it'll show up right on the Dashboard. If you only set
`DATAWRAPPER_CHART_ID`, the app will guess an unversioned URL, which may
or may not resolve — the explicit `DATAWRAPPER_EMBED_URL` is the reliable
option.

## Managing the team

Reps are now managed from the in-app **Admin** panel (see above), not an
environment variable. `TEAM_NAMES` is only used once, to create the
starting roster the very first time the app boots with an empty database.

## About the shared password

Everyone uses one password to sign in (no per-person accounts to manage,
per what you asked for) — but that password is the only thing standing
between this data and the public internet once it's deployed, so: pick
something that isn't easily guessed, and change it if anyone who
shouldn't have it gets it (Settings → Variables → `APP_PASSWORD`, then
redeploy). The same goes for `ADMIN_PASSWORD`, just more so. This is
appropriate for a low-stakes internal tracking tool; it is not bank-grade
security, and if that ever matters more, individual logins would be the
next upgrade.

## Backups

The whole database is one file (`server/data/tracker.db` locally, or
whatever `DATA_DIR` points to in production). Railway/Render volumes are
durable, but it's worth occasionally downloading a copy — or just export
the CSV from the toolbar, which covers the numbers even if not every note
field.
