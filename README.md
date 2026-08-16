# Hermes Office Mobile

Hermes Office Mobile is a mobile-first office dashboard for local Hermes agent installations. A React progressive web app presents agents, tasks, knowledge, workspaces, usage, and workflows, while a FastAPI backend-for-frontend (BFF) reads local Hermes data and exposes a browser-oriented API.

## Architecture

```text
Browser / installed PWA
        |
        | same-origin HTTP (/api/*)
        v
React + TypeScript + Vite
        |
        v
FastAPI BFF
  |-- Hermes profiles, logs, jobs, and state database
  |-- Local wiki and vault directories
  |-- Hermes API processes
  `-- Runtime outbox and delivery records
```

The frontend uses relative API URLs. During development, Vite proxies `/api` to `http://127.0.0.1:8787`. In production, serve the built frontend and proxy `/api/*` to the BFF from the same origin.

## Features

- Mobile-first dashboard with PWA installation and an offline application shell
- Agent status, activity, profiles, tasks, and evolution views
- Cron, gateway, Kanban, sent-message, and outbox aggregation
- Message delivery through a local Hermes API with an outbox fallback
- Knowledge topics, graph views, workspaces, expert panels, and workflows
- Local usage and token-cost summaries when compatible data sources are available
- Optional password-based local authentication, server-side sessions, CSRF checks, idempotency, rate limiting, and audit records

Some workflow and integration views depend on local Hermes files or optional tools. Missing integrations are reported as unavailable rather than populated with synthetic results.

## Technology Stack

- Backend: Python, FastAPI, Uvicorn, PyYAML, PyJWT
- Frontend: React, TypeScript, Vite, React Flow, native CSS
- Storage and integrations: local JSON/JSONL files, SQLite, Hermes CLI and API processes

## Quick Start

Prerequisites: Python 3.11 or newer, Node.js 20 or newer, and npm.

1. Create the backend environment and start the API:

   ```bash
   cd backend
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   HERMES_AUTH_MODE=disabled \
     HERMES_ALLOWED_ORIGIN=https://localhost.example \
     .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
   ```

2. In another terminal, start the frontend:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. Open `http://127.0.0.1:5173`.

For a protected deployment, configure local authentication before exposing the service. The password setup utility is available at `backend/manage_local_auth.py`.

## Environment Variables

Do not commit real credentials or machine-specific paths. The values below are placeholders.

| Variable | Required | Example / default | Purpose |
| --- | --- | --- | --- |
| `HERMES_HOME` | No | `~/.hermes` | Hermes configuration, profiles, logs, jobs, scripts, and state |
| `HERMES_WIKI_HOME` | No | `<HERMES_HOME>/wiki` | Wiki content directory |
| `HERMES_VAULT_HOME` | No | `<HERMES_HOME>/vault` | Vault content directory |
| `HERMES_AUTH_MODE` | No | `disabled` | Authentication mode: `disabled` or `local` |
| `HERMES_ALLOWED_ORIGIN` | Yes for deployment | `https://office.example.com` | Exact HTTPS browser origin accepted by the BFF |
| `HERMES_LOCAL_AUTH_CONFIG` | For `local` mode | `/secure/path/local-auth.json` | Password configuration file |
| `HERMES_SESSION_TTL_SECONDS` | No | `604800` | Session lifetime in seconds |
| `DRAGON_BASE_URL` | For LLM-backed features | `https://api.example.com/v1` | OpenAI-compatible API base URL |
| `DRAGON_MODEL` | For LLM-backed features | `your-model-name` | Model identifier |
| `DRAGON_API_KEY` | For LLM-backed features | `replace-with-secret` | API credential |
| `TOKEN_TRACKER_SITE_PACKAGES` | No | `/optional/python/site-packages` | Optional token-tracker import path |
| `TOKEN_TRACKER_PYTHON` | No | Current Python executable | Python executable used by the usage aggregation script |

## Security

`HERMES_AUTH_MODE` defaults to `disabled`. In that mode, the BFF does not authenticate users. This is suitable only for local development on a trusted machine and must not be exposed to an untrusted network.

Before any deployment, set `HERMES_AUTH_MODE=local`, create a strong local password configuration, set an exact HTTPS `HERMES_ALLOWED_ORIGIN`, protect runtime files, and place the BFF behind a same-origin HTTPS reverse proxy. CORS is not an authentication boundary. Several POST endpoints can send messages, update task state, or trigger local workflows, so review the API and operational documentation before exposing them.

Keep `.env` files, credentials, private wiki indexes, runtime data, and machine-generated analysis output outside version control.

## Testing

Run backend syntax checks and tests:

```bash
backend/.venv/bin/python -m py_compile \
  backend/main.py \
  backend/local_security.py \
  backend/manage_local_auth.py
cd backend
.venv/bin/python -m unittest -v test_local_security.py
```

Run the frontend type check and production build:

```bash
cd frontend
npm install
npm run build
```

Optional read-only smoke test after starting the backend:

```bash
curl --fail http://127.0.0.1:8787/api/health
```

## License

This project is available under the MIT License. See [LICENSE](LICENSE).
