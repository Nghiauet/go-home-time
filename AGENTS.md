# Repository Guidelines

## Project Structure & Module Organization
This is a tiny Dockerized Node/static app for calculating flexible office leave times and sharing a team board.

- `server.js` is the Node HTTP server, static file handler, and JSON API.
- `index.html` contains the single-page app markup (minimal: come-in input → go-home result with live countdown + "Notify me" toggle, the team board, and a link to the dashboard).
- `sw.js` is the service worker that delivers the go-home notification on mobile (Android Chrome).
- `dashboard.html` is the team come-in analytics page (served at `/dashboard`).
- `script.20260618-min.js` contains browser-side calculator and board logic.
- `dashboard.20260618-min.js` fetches `/api/stats` (with transient-failure retry) and renders the dashboard charts.
- `styles.20260618-cols.css` styles the minimal main page (glass theme; single column on phones, two columns on wide screens). `styles.20260610-glass.css` is the shared base the dashboard is built on; `dashboard.20260610-glass.css` adds dashboard layout.
- `chart.umd.min.js` is the vendored Chart.js v4 UMD build used by the dashboard.
- `fonts/` holds the vendored Plus Jakarta Sans woff2 subsets (latin, latin-ext, vietnamese).
- `Dockerfile` builds the runtime image from `node:22-alpine`.
- `docker-compose.yml` publishes the app on `127.0.0.1:46403`.

There is no package manifest or separate test directory in the current repo.

## Architecture Overview
The container runs `node server.js` on port `80`. Static assets are served from `/app/public`; board data is persisted as versioned JSON at `/data/people.json`, backed by the Docker volume `go-home-time-data`. Daily records use `Asia/Ho_Chi_Minh`.

API endpoints:

- `GET /api/health` returns service health.
- `GET /api/people` returns all users, today status, leave calculation, and recent history.
- `GET /api/stats` returns every user's full come-in history plus per-user aggregates (`days`, `avgArrival`, `earliest`, `latest`, `onTimeRate`), and the sorted list of all recorded `dates`. Powers the `/dashboard` page.
- `POST /api/people` updates today's record with `{ "name": "...", "arrival": "HH:MM" }`. Go-home time is computed as come-in + 9h15m (noon break already included). A legacy `leaveRanges` array is still accepted and validated for backward compatibility, but the UI no longer sends it. A new name is refused with `409` once the board holds `MAX_PEOPLE` (100) people; updating an existing person always works. Bodies must be a JSON object of at most 16 KB.
- `DELETE /api/people/:name` removes a user and their history.

## Build, Test, and Development Commands
Run everything against localhost unless a different environment is explicitly requested.

```bash
docker compose up -d --build
curl http://127.0.0.1:46403/
curl http://127.0.0.1:46403/api/health
curl http://127.0.0.1:46403/api/people
```

Use `node --check server.js` and `node --test test/*.test.js` before rebuilding after server edits. The tests start copies of `server.js` on free loopback ports with temp data files (no Docker, no npm deps; never the `go-home-time-data` volume). For frontend edits, verify in the browser and use the curl checks above to confirm the container still serves the app.

## Coding Style & Naming Conventions
Use plain JavaScript with CommonJS on the server. Keep two-space indentation, double quotes, semicolons, and small helper functions matching the existing style. Use `camelCase` for variables/functions and `UPPER_SNAKE_CASE` for constants. Keep CSS class names kebab-case.

## Testing Guidelines
`test/server.test.js` (node:test, black-box over HTTP) covers the calculator, input validation, static-file containment and crash cases; add a case there for server changes. For any change, run syntax checks where applicable, rebuild the container, then smoke test with curl. For API changes, test success and failure cases such as invalid `arrival`, missing `name`, oversized or invalid JSON, and delete/update behavior.

## Commit & Pull Request Guidelines
This checkout does not include Git history, so use concise English imperative commits such as `Add board validation` or `Update local run docs`. Pull requests should describe the user-facing change, list local verification commands and results, note data/schema effects for `/data/people.json`, and include screenshots for UI changes.

## Security, Configuration & Deployment Notes
Keep the service bound to `127.0.0.1:46403` in Compose unless deployment requirements change. The nginx tunnel repo exposes it externally via `gohome.${DOMAIN}` by proxying to that localhost port. Do not commit local data from the `go-home-time-data` volume.
