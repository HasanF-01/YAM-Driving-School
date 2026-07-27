# Running YAM

Quick command reference for running the app locally, running the checks, and building the
Docker image. For what the app *is*, see [README.md](README.md).

## Prerequisites

- **Node 20 or newer** — no `npm install` needed, the server uses only Node built-ins.
- **Docker** — only for the container build, not for local development.

```powershell
node --version   # v20.19.0 verified working
```

## Run locally

The app **needs the server**: it hands out the questions and marks the answers. Opening
`index.html` by double-clicking will not work — the exam never starts.

```powershell
node serve.js
```

Then open <http://localhost:8777>.

Stop it with `Ctrl+C`.

### Different port

The server reads `PORT` and `HOST` from the environment.

```powershell
$env:PORT = 8778; node serve.js
```

```bash
PORT=8778 node serve.js          # bash / Git Bash
```

### Open it from your phone

By default the server binds to `127.0.0.1`, reachable only from this machine. Bind to all
interfaces to reach it from another device on the same Wi-Fi:

```powershell
$env:HOST = "0.0.0.0"; node serve.js
```

Then browse to `http://<your-LAN-IP>:8777` from the phone. Find the IP with:

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' }).IPAddress
```

You may need to allow Node through the Windows firewall the first time.

## Run the checks

Both scripts are what CI runs on every push.

```powershell
node scripts/validate.js    # question banks + every local file reference
node scripts/smoke.js       # boots serve.js and exercises every page and /api route
```

`smoke.js` starts its own server on port **8778**. If that port is busy, point it elsewhere:

```powershell
$env:SMOKE_PORT = 8779; node scripts/smoke.js
```

## Build and run the Docker image

Requires the Docker engine to be running (start Docker Desktop first).

```powershell
docker build -t yam-driving-school .
docker run --rm -p 8777:8777 yam-driving-school
```

Then open <http://localhost:8777>.

Run it detached instead, and stop it by name:

```powershell
docker run -d --name yam -p 8777:8777 yam-driving-school
docker logs -f yam
docker stop yam
```

Map to a different host port — the container always listens on 8777 internally:

```powershell
docker run --rm -p 3000:8777 yam-driving-school     # → http://localhost:3000
```

### Pull the prebuilt image

CI publishes to GitHub Container Registry on every green build of `main`:

```bash
docker pull ghcr.io/hasanf-01/yam-driving-school:latest
docker run -d -p 8777:8777 ghcr.io/hasanf-01/yam-driving-school:latest
```

Tags are `latest` and `sha-<commit>`.

## Troubleshooting

### `EADDRINUSE: address already in use 127.0.0.1:8777`

Another server is already holding the port — usually one you started earlier and left running.
Find it and stop it:

```powershell
Get-NetTCPConnection -LocalPort 8777 -State Listen | Select-Object OwningProcess
Stop-Process -Id <pid>
```

Or just use a different port (see above).

> An old server left running keeps serving the **old code**. If `/questions.json` returns
> `200` instead of `403`, or `POST /api/exam/start` returns `404`, you are talking to a
> stale pre-refactor process — stop it and start `serve.js` again.

### Quick health check

The server is healthy when the pages return `200`, the question banks return `403`, and the
exam API answers:

```powershell
Invoke-WebRequest http://localhost:8777/ -UseBasicParsing | Select-Object StatusCode
Invoke-RestMethod http://localhost:8777/api/exam/start -Method POST `
  -Body '{"bank":"car_questions.json"}' -ContentType "application/json"
```

The `start` response must contain 30 questions and **no** `correctIndex` field.

## Note on restarts

- Editing a **question JSON** file takes effect immediately — the server reloads a bank when
  its modification time changes. No restart needed.
- Editing **`serve.js`** requires a restart.
- Exam sessions live **in process memory**. Restarting the server (or the container) cancels
  every exam in progress.
