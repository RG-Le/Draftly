# Draftly Frontend

Frontend workspace for Draftly, built in a separate `frontend` folder as requested.

## Stack

- Vite + React + TypeScript
- React Router (multi-page app shell)
- TanStack Query (server state + cache invalidation)
- Socket.IO client (live draft/sync/send updates)

## Screens implemented

- Landing + local auth + Google OAuth entry
- Auth callback
- Inbox workspace (`/app/inbox`, `/app/inbox/:threadId`)
- Drafts queue
- Send history
- Usage dashboard
- Settings / profile / connection controls

## Run

```bash
cd frontend
npm install
npm run dev
```

## Quick startup script (Windows)

PowerShell:

```powershell
cd frontend
.\start-frontend.ps1
```

Custom port:

```powershell
.\start-frontend.ps1 -Port 3010
```

CMD:

```cmd
cd frontend
start-frontend.cmd
```

Custom port:

```cmd
start-frontend.cmd 3010
```

The script will:
1. Create `.env` from `.env.example` (if missing)
2. Install dependencies (if `node_modules` is missing)
3. Block startup if the chosen port is backend-reserved (`3000`, `5432`, `6379`, `6432`, `8000`)
4. Block startup if the chosen port is already in use
5. Start the dev server on `http://localhost:<port>` with strict port mode

Default frontend port is `3001`, which does not clash with backend endpoints in this repo.

## Environment

Create `.env` from `.env.example`:

```bash
VITE_API_BASE_URL=http://localhost:3000
```

## API compatibility

The frontend supports both:

1. Final API contracts from `docs/api-contracts.md`
2. Current gateway routes already implemented in `gateway/src/infrastructure/http/routes`

For endpoints not yet available in backend, pages degrade gracefully with empty states instead of hard crashes.

## Architecture documentation (agents)

Deep-dive for structure, routing, API modules, and Socket.IO conventions: **[`../docs/frontend-documentation/README.md`](../docs/frontend-documentation/README.md)**.
