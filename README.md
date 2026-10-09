# Pluvia Sense Greater Tunis

Real-time pluvial flood watch: live 3D map, sensor ingestion, risk engine, report verification, decision-maker dashboard.
Backend: Node >= 18, **no dependencies**. Frontend: one static page (MapLibre GL).

## Run locally
    OPS_TOKEN=choose-a-code DEVICE_KEY=choose-a-key node server.js
    # open http://localhost:3000   (camera and GPS work on localhost and on https only)

## Deploy (the backend needs a Node host; GitHub Pages cannot run it)
1. Put this folder in a GitHub repository.
2. On render.com (or Railway / Fly.io): New > Web Service > connect the repository.
   Build command: *(empty)*   Start command: `node server.js`
3. Set environment variables: `OPS_TOKEN` (decision-makers' access code), `DEVICE_KEY` (sensors' key).
4. Optional: attach a persistent disk and set `DATA_DIR` to its path. Without one, reports are lost on restart.
5. Open the service URL. Press **Operations** and sign in with `OPS_TOKEN`.

## Sensor API (ESP32, LoRa gateway, anything that can POST)
    curl -X POST https://YOUR-APP/api/readings \
      -H "content-type: application/json" -H "x-device-key: YOUR_DEVICE_KEY" \
      -d '{"node":"N4","level_cm":87.5,"rain_mmh":22.0,"frame":"data:image/jpeg;base64,..."}'
`node` is N1..N8 (see `NODES` in server.js; edit names, coordinates and overflow thresholds `thr` in cm).
`frame` is optional (JPEG, max 2 MB): it is attached to the alert when the node reaches Warning or Critical.
A node that has not reported for 2 minutes falls back to a simulation driven by live rainfall.
Send a reading every 30-60 s (every 10 s during heavy rain).

## Other endpoints
| Method | Path | Access |
|---|---|---|
| GET | /api/state, /api/stream (SSE) | public view; add `x-ops-token` or `?token=` for full detail |
| POST | /api/reports (+ /api/reports/:id/video) | public, rate-limited, Greater Tunis only |
| PATCH | /api/items/:id `{status}` | operations |
| POST | /api/sim/storm `{on}` | operations |
| GET | /api/media/:file | operations |

## Notes
- Base imagery is Esri World Imagery draped on real terrain (not live). The live layer is the animated radar (RainViewer). Live rainfall and 3-hour forecast come from Open-Meteo, fetched by the server.
- Risk levels and suggested actions are rule-based (water level vs threshold, rain intensity, forecast, rate of rise).
- Use https in production. The operations code travels in a header or query string: rotate it if it leaks.
- Next steps for production: per-user accounts, SMS/WhatsApp alerts, a database (Postgres) instead of the JSON file, and calibrating thresholds with ONAS / municipality data.
