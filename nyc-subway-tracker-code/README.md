# NYC Subway Tracker

Live NYC subway arrivals in your browser. Pick from your 3 nearest stations
(via geolocation) or search the full 496-station catalog, then see upcoming
trains with countdowns, destinations, route bullets, on-time/delayed status,
and the feed timestamp. Data comes straight from the MTA's GTFS-RT feeds —
**no API key needed**.

## Run it

Requirements: Node.js 22+ and Python 3 (Python is only needed once, to build
the local station database).

```bash
npm install
npm run build-db   # downloads the MTA static GTFS bundle, builds data/transit.db
npm start          # serves http://localhost:3000
```

`npm run build-db` fetches
`http://web.mta.info/developers/data/nyct/subway/google_transit.zip`
(~5 MB) and extracts the station list plus schedule data used for the
on-time/delayed computation. Re-run it every few months to pick up MTA
schedule changes.

## Deploy it

**GitHub Pages alone will not work** — it only serves static files and cannot
run the Node server, so the `/api/*` requests return 404 (that's the console
error you saw). You need a host that runs Node. Easiest path:

1. Push this repo to GitHub (done).
2. Go to [render.com](https://render.com), sign up, and create a **Web
   Service** from your repo. Render reads `render.yaml` automatically:
   build command `npm install && npm run build-db`, start command
   `npm start`.
3. Open the URL Render gives you (e.g.
   `https://nyc-subway-tracker.onrender.com`) — the app runs there, frontend
   included. No API key needed.

Notes:

- On Render's free tier the service sleeps after inactivity; the first load
  after a nap takes ~30–60 seconds to wake up.
- If you prefer to keep the page on GitHub Pages and only host the server on
  Render: in `public/index.html`, uncomment the `window.API_BASE` line near
  the bottom and set it to your Render URL, then redeploy the page.
- To run on your own computer instead: `npm install && npm start`, then open
  http://localhost:3000.

## How it works

- `server.js` — Express server. `GET /api/stations` serves the station
  catalog from SQLite; `GET /api/station/:id/arrivals` fetches only the
  GTFS-RT feeds serving that station's lines, matches trip updates to the
  station's platforms, and compares each predicted arrival against the
  static schedule to label it **On time** (>2 min late = **Delayed**).
  Feeds are cached for 20 seconds.
- `public/index.html` — the whole frontend (no build step): geolocation →
  3 nearest stations, catalog search, arrivals board, 30-second auto-refresh
  plus a manual refresh button.
- `data/transit.db` — generated SQLite: 496 station complexes, schedule
  rows, route colors. Not committed; build it with `npm run build-db`.

## API

- `GET /api/stations` → `[{id, name, lat, lon, lines[]}]`
- `GET /api/routes` → `{routeId: {shortName, longName, color}}`
- `GET /api/station/:id/arrivals` →
  `{station, feedTime, arrivals[{routeId, destination, arrivalTime, inSeconds, direction, status}]}`

## Notes & limits

- Delay status is computed as predicted arrival minus scheduled arrival from
  the static GTFS; it's omitted when schedule data can't be matched.
- Arrivals are predictions from the MTA feed, refreshed roughly every 30
  seconds by the MTA.
- Your location never leaves your browser except as coordinates used locally
  to sort nearby stations — the server only ever receives a station id.
