# Draftly Frontend — Documentation for Humans & Agents

This folder describes the **`frontend/`** React application: structure, responsibilities, runtime behavior, API contracts assumed by the UI, and conventions for safe changes.

**Stack:** React 18, TypeScript (strict), Vite 5, React Router v6, TanStack Query v5, `socket.io-client`.

**Typical dev URL:** `http://localhost:3001` (`package.json`: `--port 3001 --strictPort`).

**Backend base URL:** `VITE_API_BASE_URL` (default `http://localhost:3000`) — see [`.env.example`](../../frontend/.env.example).

---

## Document Index

| Doc | Contents |
|-----|----------|
| [01-architecture-overview.md](./01-architecture-overview.md) | Layers, bootstrap, routing shell, styling |
| [02-pages-and-navigation.md](./02-pages-and-navigation.md) | Routes, layouts, flows per screen |
| [03-state-queries-and-hooks.md](./03-state-queries-and-hooks.md) | Context providers, TanStack Query, `useRealtimeEvents` |
| [04-api-modules.md](./04-api-modules.md) | `src/api/*`: endpoints, legacy vs modern fallbacks |
| [05-realtime-events.md](./05-realtime-events.md) | Socket.IO client, server event names, cache invalidation |
| [06-components-library.md](./06-components-library.md) | Reusable UI + feature components |
| [07-agent-cheatsheet.md](./07-agent-cheatsheet.md) | Checklist for edits, pitfalls, grep targets |

---

## Source Map (quick)

All application code lives under **`frontend/src/`** (omit `node_modules`, `dist`).

```
src/
  main.tsx           # React root + providers
  App.tsx            # Route table
  types.ts           # Shared domain/UI types (aligned with gateway where possible)
  styles.css         # Global layout & theme (single file)
  context/           # Auth, pipeline UI state, toasts
  hooks/             # useRealtimeEvents
  lib/               # HTTP client, storage, helpers
  api/               # Thin gateway clients (retry, dual-route fallbacks)
  pages/             # Route-level screens
  components/        # Presentation + composites
```

---

## Relation to Backend

This SPA talks to **Draftly Gateway** (`gateway/`) REST + Socket.IO unless you point `VITE_API_BASE_URL` elsewhere.

Many API modules intentionally support **multiple gateway API shapes** (see [04-api-modules.md](./04-api-modules.md)): “modern” paths like `/api/v1/inbox` vs “legacy” paths like `/api/v1/connections/gmail/threads`. Agents adding gateway routes should verify both paths or tighten the frontend to one contract.
