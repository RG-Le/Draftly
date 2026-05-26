# Components Catalog

Purpose: orientation for agents choosing where to extend UI vs create new primitives.

All paths under **`frontend/src/components/`**.

| Component | Responsibility |
|-----------|----------------|
| **`AppShell.tsx`** | Two-column chrome: sidebar nav (**Inbox, Drafts, Sent, Usage, Settings**), user identity, logout. |
| **`RequireAuth.tsx`** | Guard outlet; redirects to `/` preserving `location.state.from` optionally (currently only uses pathname for Navigate). |
| **`ToastViewport.tsx`** | Reads `ToastContext`; renders stacked toasts |
| **`Button.tsx`** | Variants (`primary`, `secondary`, `ghost`, `danger` — see props in file); shared click styling |
| **`Badge.tsx`** | Small status capsule (classification / connection state coloring) |
| **`EmptyState.tsx`** | Illustrated empty placeholders |
| **`LoadingCard.tsx`** | Spinner / skeleton placeholders |
| **`MetricCard.tsx`** | Numeric summary tiles (Used on Usage/dashboard-like views) |
| **`ConnectionBanner.tsx`** | Gmail connect + sync CTAs wired from `AppLayout` props (`connection`, `onConnect`, `onSync`, `syncInProgress`, `syncStatusHint`) |
| **`ThreadList.tsx`** | Inbox sidebar list rendering + badges for triage + draft status |
| **`MessageTimeline.tsx`** | Thread message chronological display |
| **`DraftEditor.tsx`** | Text editing + toolbar actions delegated from `InboxPage` |
| **`Dialog.tsx`** | Overlay-based modal dialog (see below) |

Pages may import components directly (`../components/...`).

**Adding a new global nav item:** update **`navItems` array** in **`AppShell.tsx`** **and** add matching `<Route>` in **`App.tsx`**.

## Styling extension pattern

Prefer new BEM-ish class prefixes consistent with **`styles.css`** blocks (landing, inbox, drafts, shell). Inspect existing sections before inventing unrelated naming.

---

## `Dialog` component

A simple overlay-based modal dialog used for confirmations and form dialogs.

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controls visibility. When `false`, renders nothing. |
| `title` | `string` | Header text displayed in the dialog. |
| `onClose` | `() => void` | Called when overlay is clicked or close button is pressed. |
| `children` | `React.ReactNode` | Dialog body content (forms, text, buttons). |

**Behavior:**
- Renders a full-screen `.dialog-overlay` that closes on click
- Inner `.dialog-box` stops event propagation (clicking inside doesn't close)
- Close button (`×`) in the header with `aria-label="Close"`
- Returns `null` when `open` is `false` (no DOM rendered)

**Usage examples:**
- **Sync dialog** (`SettingsPage`): daysBack selector + Start Sync / Cancel buttons
- **Delete account confirmation** (`SettingsPage`): warning text + Delete / Cancel buttons

```tsx
<Dialog open={showDeleteDialog} title="Delete Account" onClose={() => setShowDeleteDialog(false)}>
  <p>This will permanently delete all your data.</p>
  <Button variant="danger" onClick={handleDelete}>Delete my account</Button>
</Dialog>
```
