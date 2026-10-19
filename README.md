# Go Home Time

Tiny static calculator for the flexible office window:

- Check in: `08:30` to `09:30`
- Leave: `17:45` to `18:45`
- Work span: `9h 15m`

It also includes a shared team board. Anyone can select a person, update today's come-in time, and add leave ranges that move the final go-home time earlier. Older daily entries stay in the person's history instead of being shown as today's update.

A **`/dashboard`** page visualizes everyone's come-in time across all recorded history: an arrival-time trend chart, a team ranking (earliest average first), per-user stats (average, earliest, latest, on-time %), and a daily heatmap. It is backed by `GET /api/stats` and renders with a vendored Chart.js build (no external CDN).

## Run Locally

```bash
docker compose up -d --build
curl http://127.0.0.1:46403/
```

The board is stored in the Docker volume `go-home-time-data` at `/data/people.json`. Dates use `Asia/Ho_Chi_Minh`.

API smoke checks:

```bash
curl http://127.0.0.1:46403/api/people
curl http://127.0.0.1:46403/api/stats
curl -X POST http://127.0.0.1:46403/api/people \
  -H 'Content-Type: application/json' \
  -d '{"name":"nghiaph","arrival":"09:00","leaveRanges":[{"start":"16:45","end":"17:45"}]}'
```

The nginx tunnel repo maps this service through `gohome.${DOMAIN}` by proxying to `127.0.0.1:46403`.
