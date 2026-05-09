# Agent Cheatsheet (Making Frontend Changes Safely)

## Before coding

1. Read **`frontend/package.json`** for ports and tooling.
2. Confirm **`VITE_API_BASE_URL`** matches running gateway (`frontend/.env` or `.env.local`).
3. Map your feature into:
   - page (`pages/`), or
   - shared component (`components/`), plus
   - API surface (`api/`), plus
   - optional realtime event (`hooks/useRealtimeEvents.ts`).

## Typical change patterns

| Goal | Likely touch points |
|------|---------------------|
| New authenticated page | `App.tsx`, `AppShell.tsx` nav items, `pages/NewPage.tsx`, route-level query keys |
| New REST capability | New `src/api/foo.ts` or extend existing module → call from `useMutation` / `useQuery` |
| Persist user preference | Prefer gateway `/preferences` endpoints already wrapped in `api/profile.ts` |
| Invalidate after server push | Extend `invalidateCoreQueries()` or targeted `invalidateQueries` in `useRealtimeEvents` |
| Long-running backend job UX | Leverage realtime events + **`PipelineStatusContext`** + optional polling (see **`InboxPage`**) |

## Conventions preserved in this codebase

- **TanStack Query** for server-derived data; avoid duplicating that into Context unless globally cross-cutting (`Auth`).
- **`apiRequest` first** instead of scattering `fetch` (exception: OAuth token bootstrap paths like `getMeWithToken`).
- **`types.ts`** mirrors backend DTOs loosely — keep casing helpers in API modules (`toThreadSummary`), not sprinkled in JSX.
- **Dual-route fallback** logic is intentional compat glue — removing it requires verifying gateway contract.

## Verification checklist

- `npm run typecheck` passes.
- `npm run dev` → smoke test navigations impacted.
- Authenticated vs unauthenticated behavior (`RequireAuth`).
- Regression on **OAuth** flows if auth URLs or callback paths touched.
- If Socket events renamed: grep **`useRealtimeEvents`** and gateway emitter together.

## Quick grep anchors

```
frontend/src/App.tsx               # Routes
frontend/src/pages/AppLayout.tsx   # Queries + realtime + banner
frontend/src/api/inbox.ts          # Largest compatibility surface
frontend/src/hooks/useRealtimeEvents.ts # Event map
frontend/src/context/AuthContext.tsx
frontend/src/lib/http.ts           # Central fetch + refresh
```

## Known issues to acknowledge when debugging

1. **`triage:failed` handler references missing `markTriageFailed`** — fix by extending `PipelineStatusContext` or simplifying handler (`useRealtimeEvents.ts`).
2. **OAuth redirects:** multiple callback routes (`/auth/callback` vs `/app/oauth/callback`) — align with gateway redirect URIs documented in **`docs/code-walkthrough`**.
3. **`sync:completed` toast expects `payload.newThreads`/`updatedThreads`** — must match BullMQ worker payload shape or adjust toast template.
