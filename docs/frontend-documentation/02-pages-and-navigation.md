# Pages and Navigation

Route definitions live in **`frontend/src/App.tsx`**.

## Public routes

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | `LandingPage` | Marketing blurb + **local login/register** + **Google OAuth** launcher |
| `/auth/callback` | `AuthCallbackPage` | Completes Google **user** OAuth (handles redirect query params or legacy `code`+`state` API flow) |

## OAuth callback variants (Google login)

Two success shapes are handled in `AuthCallbackPage`:

1. **Redirect mode:** URL contains **`accessToken` + `refreshToken`** query params → `getMeWithToken` then `setSession`.
2. **Legacy JSON mode:** `code` + `state` → `completeGoogleCallback` hits **`GET /api/v1/auth/google/callback`** with query params → `setSession`.

```29:43:frontend/src/pages/AuthCallbackPage.tsx
        if (accessToken && refreshToken) {
          const user = await getMeWithToken(accessToken);
          setSession({ user, accessToken, refreshToken });
          ...
        }

        if (code && state) {
          const session = await completeGoogleCallback(code, state);
          setSession(session);
          ...
```

## Gmail connector OAuth (authenticated)

| Path | Component | Purpose |
|------|-----------|---------|
| `/app/oauth/callback` | `OAuthConnectionCallbackPage` | Frontend-side handler calling **`completeConnectionCallback`** (`GET /api/v1/connections/callback`), then navigates to inbox |

Connector flows pass **`redirect_uri`** when initiating Gmail OAuth from `SettingsPage` / `AppLayout` so Google may bounce the user **back onto the SPA** (`/app/inbox` with `gmail_connected` query, or `/app/oauth/callback` depending on gateway configuration).

**Note:** Backend may instead **302 redirect** straight to `redirect_uri` — in that case the SPA route above may not execute; **`AppLayout`** still watches for `gmail_connected=true` in query (see sync monitor effect).

## Authenticated shell (`/app`)

All routes below use **`RequireAuth`** + nested layout **`AppLayout`**.

```23:31:frontend/src/App.tsx
        <Route element={<RequireAuth />}>
          <Route path="/app" element={<AppLayout />}>
            <Route index element={<Navigate to="/app/inbox" replace />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="inbox/:threadId" element={<InboxPage />} />
            <Route path="drafts" element={<DraftsPage />} />
            <Route path="sent" element={<SentPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="settings" element={<SettingsPage />} />
```

| Path | Page | Highlights |
|------|------|------------|
| `/app` | redirect | → `/app/inbox` |
| `/app/inbox` | `InboxPage` | Thread list + filters + thread detail pane (routing param optional) |
| `/app/inbox/:threadId` | `InboxPage` | Same component; `:threadId` drives detail query |
| `/app/drafts` | `DraftsPage` | Cross-thread draft queue view |
| `/app/sent` | `SentPage` | Send history |
| `/app/usage` | `UsagePage` | Usage summaries / records (`api/usage.ts`) |
| `/app/settings` | `SettingsPage` | Gmail connect/sync/reconnect, profile/preferences |

## `AppLayout` responsibilities

Beyond rendering children via `<Outlet />`, **`AppLayout`** is the operational hub:

- Subscribes to **`useRealtimeEvents(true)`** (Socket.IO).
- **`useQuery` [`me`]** refreshes canonical user profile into `AuthContext.patchUser`.
- **`useQuery` [`connections`]** polls every **4s** while `syncMonitor` is active (post-sync UX).
- **Mutations:** Gmail connect (`startGmailConnection` / `reconnectGmailConnection`) and **manual sync** (`syncInbox`).
- **ConnectionBanner** always visible above routed content.

Fallthrough: **`NotFoundPage`** for unknown paths.
