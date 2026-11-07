# Go Home Time

Tiny static calculator for the flexible office window:

- Check in: `08:30` to `09:30`
- Leave: `17:45` to `18:45`
- Work span: `9h 15m`

It also includes a shared team board. Anyone can select a person and update today's come-in time; the go-home time is come-in + 9h 15m. (The API still accepts a legacy `leaveRanges` array, but the UI no longer sends it.) Older daily entries stay in the person's history instead of being shown as today's update. Removing a person asks first and offers a 10-second undo.

A **`/dashboard`** page visualizes everyone's come-in time across all recorded history: an arrival-time trend chart, a team ranking (earliest average first), per-user stats (average, earliest, latest, on-time %), and a daily heatmap. It is backed by `GET /api/stats` and renders with a vendored Chart.js build (no external CDN).

## Run Locally

```bash
docker compose up -d --build
curl http://127.0.0.1:46403/
```

The board is stored in the Docker volume `go-home-time-data` at `/data/people.json`. Dates use `Asia/Ho_Chi_Minh`.

API smoke checks (read-only — on the owner's server `127.0.0.1:46403` is the live board):

```bash
curl http://127.0.0.1:46403/api/health
curl http://127.0.0.1:46403/api/people
curl http://127.0.0.1:46403/api/stats
```

Write paths (`POST /api/people`, `DELETE /api/people/:name`, restore) are covered by the tests, which start their own copies of `server.js` on free loopback ports with temp data files:

```bash
node --check server.js && node --test test/*.test.js
```

The nginx tunnel repo maps this service through `gohome.${DOMAIN}` by proxying to `127.0.0.1:46403`.
