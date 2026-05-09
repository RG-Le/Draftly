# Components Catalog

Purpose: orientation for agents choosing where to extend UI vs create new primitives.

All paths under **`frontend/src/components/`**.

| Component | Responsibility |
|-----------|----------------|
| **`AppShell.tsx`** | Two-column chrome: sidebar nav (**Inbox, Drafts, Sent, Usage, Settings**), user identity, logout. |
| **`RequireAuth.tsx`** | Guard outlet; redirects to `/` preserving `location.state.from` optionally (currently only uses pathname for Navigate). |
| **`ToastViewport.tsx`** | Reads `ToastContext`; renders stacked toasts |
| **`Button.tsx`** | Variants (`primary`, `secondary`, `ghost`, … — see props in file); shared click styling |
| **`Badge.tsx`** | Small status capsule (classification / connection state coloring) |
| **`EmptyState.tsx`** | Illustrated empty placeholders |
| **`LoadingCard.tsx`** | Spinner / skeleton placeholders |
| **`MetricCard.tsx`** | Numeric summary tiles (Used on Usage/dashboard-like views) |
| **`ConnectionBanner.tsx`** | Gmail connect + sync CTAs wired from `AppLayout` props (`connection`, `onConnect`, `onSync`, `syncInProgress`, `syncStatusHint`) |
| **`ThreadList.tsx`** | Inbox sidebar list rendering + badges for triage + draft status |
| **`MessageTimeline.tsx`** | Thread message chronological display |
| **`DraftEditor.tsx`** | Text editing + toolbar actions delegated from `InboxPage` |

Pages may import components directly (`../components/...`).

**Adding a new global nav item:** update **`navItems` array** in **`AppShell.tsx`** **and** add matching `<Route>` in **`App.tsx`**.

## Styling extension pattern

Prefer new BEM-ish class prefixes consistent with **`styles.css`** blocks (landing, inbox, drafts, shell). Inspect existing sections before inventing unrelated naming.
