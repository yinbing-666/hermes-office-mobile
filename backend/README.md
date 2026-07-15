# Hermes Office Mobile Backend

Read-only FastAPI BFF for the Hermes Office Mobile frontend. It reads safe status metadata from `/home/agentuser/.hermes`, reports configured local ports, returns redacted recent gateway activity, and summarizes cron and skill/profile evolution data.

The backend does not modify Hermes files and does not read `.env`, configuration files, or secrets.

## Install

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

For mobile-device testing on a trusted local network, bind to `0.0.0.0` instead and use the machine's LAN address. Do not expose this read-only local status API to the public internet.

## Verify

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS http://127.0.0.1:8787/api/agents
curl -sS http://127.0.0.1:8787/api/activity
curl -sS http://127.0.0.1:8787/api/evolution
curl -sS http://127.0.0.1:8787/api/cron
```

Interactive OpenAPI documentation is available at `http://127.0.0.1:8787/docs` while the server is running.
