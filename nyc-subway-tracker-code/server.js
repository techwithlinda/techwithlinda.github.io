/**
 * NYC Subway Tracker — server
 *
 * Serves the station catalog from a local SQLite database (built from the
 * MTA static GTFS bundle) and live arrivals from the MTA GTFS-RT feeds
 * (no API key required).
 *
 *   GET /api/stations                  -> [{id, name, lat, lon, lines[]}]
 *   GET /api/routes                    -> {routeId: {shortName, color}}
 *   GET /api/station/:id/arrivals      -> {station, feedTime, arrivals[]}
 *
 * Run:  npm install && npm run build-db && npm start
 */
const express = require("express");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const GtfsRealtime = require("gtfs-realtime-bindings");

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "transit.db");
const FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";
const FEED_TTL_MS = 20_000; // MTA refreshes roughly every 30s; cache 20s
const DELAY_THRESHOLD_SECS = 120; // >2 min late counts as "Delayed"
const MAX_ARRIVALS = 12;

// route_id -> realtime feed name (MTA groups several lines per feed)
const FEED_FOR_ROUTE = {
  1: "gtfs", 2: "gtfs", 3: "gtfs", 4: "gtfs", 5: "gtfs", 6: "gtfs", "6X": "gtfs",
  GS: "gtfs", FS: "gtfs", H: "gtfs",
  7: "gtfs-7", "7X": "gtfs-7",
  A: "gtfs-ace", C: "gtfs-ace", E: "gtfs-ace",
  B: "gtfs-bdfm", D: "gtfs-bdfm", F: "gtfs-bdfm", FX: "gtfs-bdfm", M: "gtfs-bdfm",
  J: "gtfs-jz", Z: "gtfs-jz",
  N: "gtfs-nqrw", Q: "gtfs-nqrw", R: "gtfs-nqrw", W: "gtfs-nqrw",
  L: "gtfs-l",
  G: "gtfs-g",
  SI: "gtfs-si",
};

const db = new DatabaseSync(DB_PATH);
const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ---- timezone helpers (schedule times are in America/New_York) ----
function tzOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUTC - date.getTime();
}
// midnight (start of service date) in New York, as epoch ms
function nyMidnightMs(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), mo = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  const guess = Date.UTC(y, mo - 1, d, 12, 0, 0);
  return Date.UTC(y, mo - 1, d, 0, 0, 0) - tzOffsetMs("America/New_York", new Date(guess));
}

// ---- realtime feed fetching with a short in-memory cache ----
const feedCache = new Map(); // feedName -> {at, feed}
async function getFeed(feedName) {
  const hit = feedCache.get(feedName);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.feed;
  const res = await fetch(FEED_BASE + feedName, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`MTA feed ${feedName} returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buf);
  feedCache.set(feedName, { at: Date.now(), feed });
  return feed;
}
const toMs = (t) => (t == null ? null : Number(t) * 1000); // protobuf int64 -> ms

// ---- API ----
app.get("/api/stations", (req, res) => {
  const rows = db.prepare("SELECT complex_id, name, lat, lon, lines FROM stations ORDER BY name").all();
  res.json(rows.map((r) => ({
    id: r.complex_id, name: r.name, lat: r.lat, lon: r.lon,
    lines: r.lines ? r.lines.split(",") : [],
  })));
});

app.get("/api/routes", (req, res) => {
  const out = {};
  for (const r of db.prepare("SELECT route_id, short_name, long_name, color FROM routes").all()) {
    out[r.route_id] = { shortName: r.short_name, longName: r.long_name, color: r.color };
  }
  res.json(out);
});

app.get("/api/station/:id/arrivals", async (req, res) => {
  try {
    const st = db.prepare("SELECT complex_id, name, lines FROM stations WHERE complex_id = ?").get(req.params.id);
    if (!st) return res.status(404).json({ error: "Unknown station id" });
    const lines = st.lines ? st.lines.split(",") : [];
    const children = db.prepare("SELECT child_stop_id FROM station_children WHERE complex_id = ?")
      .all(st.complex_id).map((r) => r.child_stop_id);
    const childSet = new Set(children);
    const feeds = [...new Set(lines.map((l) => FEED_FOR_ROUTE[l]).filter(Boolean))];
    if (feeds.length === 0) {
      return res.json({ station: { id: st.complex_id, name: st.name, lines }, feedTime: null, arrivals: [] });
    }

    const now = Date.now();
    const feedResults = await Promise.allSettled(feeds.map(getFeed));
    let feedTime = null;
    const arrivals = [];

    // prepared once per request (node:sqlite prepares are cheap, but no need to redo them per row)
    const qDestExact = db.prepare("SELECT destination FROM destinations WHERE trip_suffix = ?");
    const qDestPattern = db.prepare("SELECT destination FROM destinations WHERE trip_suffix LIKE ? ESCAPE '\\' LIMIT 1");
    const qSched = db.prepare("SELECT arrival_secs FROM schedule WHERE child_stop_id = ? AND trip_suffix = ? LIMIT 1");
    const qParent = db.prepare("SELECT complex_id FROM station_children WHERE child_stop_id = ?");
    const qStationName = db.prepare("SELECT name FROM stations WHERE complex_id = ?");
    const parentName = (childStopId) => {
      const p = qParent.get(childStopId);
      if (!p) return "";
      const s = qStationName.get(p.complex_id);
      return s ? s.name : "";
    };

    for (const r of feedResults) {
      if (r.status !== "fulfilled") continue;
      const feed = r.value;
      const ts = toMs(feed.header.timestamp);
      if (ts && (!feedTime || ts > feedTime)) feedTime = ts;

      for (const entity of feed.entity) {
        const tu = entity.tripUpdate;
        if (!tu || !tu.trip) continue;
        const routeId = tu.trip.routeId;
        const tripId = tu.trip.tripId; // e.g. "056450_N..N33R" (matches schedule trip_suffix)
        const stus = tu.stopTimeUpdate || [];

        // Destination, best-effort in three tiers:
        // 1. exact static trip -> terminal station (also enables delay status)
        // 2. route/pattern portion -> terminal (every pattern maps to one station)
        // 3. last stop listed in this realtime trip update
        // (NYCT realtime trips carry no headsign of their own.)
        let headsign = "";
        const destExact = qDestExact.get(tripId);
        if (destExact) {
          headsign = destExact.destination;
        } else {
          const pattern = tripId.slice(tripId.indexOf("_") + 1);
          const destPat = qDestPattern.get("%\\_" + pattern);
          if (destPat) headsign = destPat.destination;
          else if (stus.length) headsign = parentName(stus[stus.length - 1].stopId);
        }
        const startDate = tu.trip.startDate; // YYYYMMDD
        for (const stu of stus) {
          if (!childSet.has(stu.stopId)) continue;
          const arrMs = stu.arrival ? toMs(stu.arrival.time) : null;
          if (arrMs == null || arrMs < now - 60_000) continue; // drop long-gone trains

          // delay vs. the static schedule (honest "on time / delayed")
          let status = null;
          if (startDate && /^\d{8}$/.test(startDate)) {
            const sched = qSched.get(stu.stopId, tripId);
            if (sched) {
              let scheduledMs = nyMidnightMs(startDate) + sched.arrival_secs * 1000;
              // handle trips crossing midnight: keep scheduled within 12h of predicted
              while (scheduledMs - arrMs > 12 * 3600_000) scheduledMs -= 24 * 3600_000;
              while (arrMs - scheduledMs > 12 * 3600_000) scheduledMs += 24 * 3600_000;
              const delaySecs = Math.round((arrMs - scheduledMs) / 1000);
              status = delaySecs > DELAY_THRESHOLD_SECS ? "Delayed" : "On time";
            }
          }

          arrivals.push({
            routeId,
            destination: headsign,
            arrivalTime: arrMs,
            inSeconds: Math.max(0, Math.round((arrMs - now) / 1000)),
            direction: stu.stopId.endsWith("N") ? "Northbound" : stu.stopId.endsWith("S") ? "Southbound" : null,
            status,
          });
        }
      }
    }

    arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);
    res.json({
      station: { id: st.complex_id, name: st.name, lines },
      feedTime,
      arrivals: arrivals.slice(0, MAX_ARRIVALS),
      feedsQueried: feeds,
    });
  } catch (err) {
    console.error("arrivals error:", err.message);
    res.status(502).json({ error: "Could not reach MTA realtime data. Try again in a moment." });
  }
});

app.listen(PORT, () => console.log(`NYC Subway Tracker on http://localhost:${PORT}`));
