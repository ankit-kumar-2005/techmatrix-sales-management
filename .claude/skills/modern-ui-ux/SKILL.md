---
name: modern-ui-ux
description: Modern enterprise B2B SaaS UI/UX design system for this project — visual hierarchy, typography, spacing, color, every component category (buttons, inputs, tables, cards, modals, sidebars, tabs), all interaction states, responsive behavior, and accessibility. Read before building or redesigning any UI screen, and before touching anything under components/ or features/*/components/.
---

# Modern UI/UX Design System — Techmatrix Sales Management

This is the design reference for every screen in this application. It exists because the
client flagged the current UI as "functional but visually basic" (the New Lead modal
specifically) — this document is how that gets fixed *systematically*, not screen by screen.

**Read this before:** building any new screen, adding any component under `components/` or
`features/*/components/`, or touching visual styling anywhere. When this document and ad hoc
instinct disagree, this document wins — it exists precisely to stop the app accumulating a new
one-off pattern per screen.

**What this document is not:** a redesign of any screen. Applying it is future work, tracked
separately. Nothing in the application changed as a result of writing this file.

---

## 0. Where the app stands today (read this first)

Inspected before writing this: `app/`, `components/`, `features/*/components/`, `tailwind`
setup, and every existing page. Grounding the rules below in what's *actually* here, not a
generic template:

- **shadcn/ui is documented as the intended stack but not yet initialized** — there is no
  `components.json`, no `components/ui/`. Every control so far (buttons, inputs, cards) is
  hand-built Tailwind, repeated inline per file.
- **`components/shared/form-field.tsx`** is the only genuinely reusable UI component that
  exists. Everything else — buttons, cards, badges — is copy-pasted className strings.
- **A real visual language already exists**, just not written down or fully consistent:
  - Primary color: `sky-600` / `sky-700` (buttons, links, active nav)
  - Neutral scale: `neutral-50` (page background), `neutral-100` (dividers), `neutral-300`
    (input borders), `neutral-500`/`600` (secondary text), `neutral-900` (headings)
  - Semantic colors already in use: `emerald` (success), `red` (error), `amber` (warning)
  - Buttons are pill-shaped: `rounded-full`, `min-h-11` (44px touch target)
  - Inputs are `rounded-lg border-neutral-300`, focus ring `sky-500/30`
  - Page `h1` is `text-2xl font-bold text-neutral-900`; eyebrow/label text is
    `text-xs font-medium uppercase tracking-wide text-neutral-500`
- **One concrete inconsistency found and worth fixing when next touched:** cards use two
  different shadow treatments in different places — `shadow-sm ring-1 ring-black/5`
  (dashboard stat cards) vs. `shadow-xl shadow-sky-950/10 ring-1 ring-black/5` (auth cards).
  Section 4 below picks one scale and both should converge on it.
- **The sidebar** (`features/sales-management/components/sidebar.tsx`) already has a decent
  pattern worth keeping: active-state `bg-sky-50 text-sky-700`, disabled/future items shown
  with a "Soon" badge rather than a dead link, off-canvas drawer on mobile.
- **No toast system, no modal/dialog primitive, no data table component exist yet** — these
  are genuinely new and should be built shadcn-first (Section 2).

Everything below is written to standardize and extend this — not replace it with something
unrelated.

---

## 1. Core enterprise UX priorities

In priority order, every screen should optimize for:

1. **Clarity** over cleverness — a sales rep should never have to think about the UI itself.
2. **Fast data entry** — minimize clicks/keystrokes/scrolling for the most frequent tasks
   (creating a lead, updating a stage, logging a call).
3. **Predictable navigation** — the same action always lives in the same place.
4. **Low cognitive load** — one primary action per screen, secondary actions visually quieter.
5. **Consistency** — a button, card, or input looks and behaves identically everywhere.
6. **Accessibility** — keyboard-operable, screen-reader-sane, sufficient contrast, by default.
7. **Responsiveness** — intentional per breakpoint, not "shrink until it fits."

**Explicitly avoid:** gradients, drop shadows heavier than a subtle 1px-equivalent lift,
rounded corners beyond `rounded-2xl` on any container, decorative icons/illustrations with no
functional purpose, animation longer than ~200ms or used where it doesn't clarify a state
change, more than one accent color per screen, oversized display-style headings, and dashboards
that show more than 4–6 stat cards at once. If a screen "looks like a template," it has too
much decoration and not enough hierarchy.

---

## 2. Component architecture & reuse

```
components/
  ui/          shadcn/ui primitives (Button, Input, Select, Dialog, Sheet, Table, Badge, ...)
  shared/      composed components used by 2+ features (already has form-field.tsx)
  forms/       reusable form-level patterns (field groups, form section headers)
  tables/      reusable table pieces (data table shell, pagination, column header, filters bar)
  layout/      page-level layout primitives (page header, section, empty-state shell)
  feedback/    toasts, inline banners, confirmation dialog wrapper
features/*/components/   feature-specific composition of the above — never raw HTML controls
```

**Rule: never hand-roll a control that a shadcn/ui primitive already covers.** Initialize
shadcn/ui (`components.json`, `components/ui/`) the next time any of the following is needed,
and configure its theme tokens to match Section 4 exactly (don't let shadcn's defaults drift
from the existing `sky`/`neutral` palette):

- **Button** → shadcn `Button` (all 5 variants in Section 5)
- **Dialog** → shadcn `Dialog` (confirmation dialogs, small forms)
- **Sheet** → shadcn `Sheet` (the New Lead side-panel — see Section 8)
- **Select** → shadcn `Select` (Stage, Owner, Source dropdowns)
- **Table** → shadcn `Table` (as the base for a project `DataTable` in `components/tables/`)
- **Badge** → shadcn `Badge` (stage/status pills)
- **Toast** (`sonner`, shadcn's recommended toast) → success/error notifications

`components/shared/form-field.tsx` stays as-is until it's naturally replaced by
shadcn `Form` + `Input` composition — don't rewrite it preemptively.

**Never build a one-off.** If a screen needs a button, a card, a badge, or a table, and one
already exists in `components/ui/` or `components/shared/`, use it — extend it with a prop
before reaching for a new inline className block. A second real usage of any new pattern is
the signal to extract it into `components/shared/` (same rule already established in
`CLAUDE.md` Section M).

---

## 3. Visual hierarchy

- Exactly **one primary action** per screen/panel (solid `sky-600` button). Everything else is
  secondary (outline) or tertiary (ghost/link).
- Page structure, top to bottom: **eyebrow/context** (optional) → **h1** → **one-line
  description** (optional) → **primary content**. Don't stack more than this above the fold.
- Group related fields/data visually (spacing + optional subtle divider), not with boxes
  around every group — reserve card borders for genuinely separate content blocks.
- The most important number/status on a card or row is the largest and darkest text in it;
  everything else is `neutral-500`/`600`.

## 4. Design tokens

Treat these as fixed — new UI reads values from here, it doesn't invent new ones.

**Color**
| Role | Token |
|---|---|
| Primary / brand | `sky-600` (hover `sky-700`, focus ring `sky-500/30`) |
| Page background | `neutral-50` |
| Surface (card/panel) | `white` |
| Border / divider | `neutral-100` (subtle), `neutral-300` (input borders) |
| Primary text | `neutral-900` |
| Secondary text | `neutral-600` |
| Tertiary / label text | `neutral-500` |
| Disabled text | `neutral-400` |
| Success | `emerald-600` text / `emerald-50` bg / `emerald-200` ring |
| Error / destructive | `red-600` text / `red-50` bg / `red-200` ring |
| Warning | `amber-800` text / `amber-50` bg / `amber-200` ring |

One accent color (`sky`) per screen. Semantic colors (`emerald`/`red`/`amber`) are for state
only, never decoration.

**Typography** (a single scale, reused everywhere — no new sizes invented per screen)
| Use | Classes |
|---|---|
| Page title (h1) | `text-2xl font-bold text-neutral-900` |
| Section title (h2) | `text-base font-semibold text-neutral-900` |
| Body | `text-sm text-neutral-900` |
| Secondary body | `text-sm text-neutral-600` |
| Label / eyebrow | `text-xs font-medium uppercase tracking-wide text-neutral-500` |
| Helper / caption | `text-xs text-neutral-500` |

**Spacing** — 4px base unit via Tailwind's default scale. Page padding `px-4 sm:px-6 lg:px-10`,
vertical rhythm between page sections `gap-6`, inside a card `p-5`/`p-6`, between form fields
`gap-4`.

**Radius** — `rounded-lg` for inputs/small controls, `rounded-2xl` for cards/panels/modals,
`rounded-full` for buttons and badges/pills. Nothing else.

**Elevation** — pick **one** scale and use it everywhere (resolves the inconsistency noted in
Section 0): `shadow-sm ring-1 ring-black/5` for resting cards, `shadow-xl ring-1 ring-black/5`
(no tinted shadow color) for anything floating above content — modals, sheets, dropdown
menus, popovers. Never stack more than one shadow strength on the same element.

---

## 5. Buttons

Five variants, one size scale (`sm` `h-9`, default `h-11`/`min-h-11`, never smaller than a
44px touch target on anything clickable):

| Variant | Use for | Style |
|---|---|---|
| **Primary** | The one main action on the screen | `rounded-full bg-sky-600 text-white hover:bg-sky-700` |
| **Secondary** | Alternative actions (Cancel next to Save) | `rounded-full border border-neutral-300 text-neutral-700 hover:bg-neutral-50` |
| **Destructive** | Delete/remove/irreversible actions | `rounded-full bg-red-600 text-white hover:bg-red-700` |
| **Ghost** | Low-emphasis actions inside tables/toolbars | `rounded-full text-neutral-600 hover:bg-neutral-100` |
| **Link** | Inline text-level actions | `text-sky-600 font-semibold hover:underline`, no button chrome |

Every button: `disabled:cursor-not-allowed disabled:opacity-60`, a loading state that swaps
the label (`"Save"` → `"Saving..."`) rather than only showing a spinner, and never more than
one primary button visible at once.

## 6. Inputs, selects, forms

- Input: `rounded-lg border border-neutral-300 px-3.5 py-2.5 text-sm` → focus
  `border-sky-500 ring-2 ring-sky-500/30` → error `border-red-400`.
- Every input has a real `<label>` (via `components/shared/form-field.tsx` or shadcn `Form`),
  never a placeholder used as the only label.
- **Field hierarchy:** Label (with a red `*` for required, nothing for optional — don't label
  optional fields, that's the default) → Input → helper text (`text-xs text-neutral-500`,
  shown only when it adds real guidance) → validation error (`text-xs text-red-600`, replaces
  helper text when present, `role="alert"`, linked via `aria-describedby`).
- Select/dropdown: same visual shell as a text input; use the shadcn `Select` once adopted
  rather than a native `<select>` styled ad hoc, for consistent keyboard behavior.
- **Form layout:** group related fields, two-column on desktop where fields are naturally
  paired (e.g. Email + Phone), single column for anything that reads top-to-bottom (name,
  address). Never split one logical field across columns. Primary action bottom-right (or
  full-width on mobile), secondary/cancel to its left.
- Validation is inline, on submit at minimum (real-time for password-policy-style feedback
  where a live checklist genuinely helps, per the existing `PasswordRequirements` pattern) —
  never only a toast with no field-level indication of what to fix.

## 7. Tables

- Desktop: a real `<table>` (or shadcn `Table`) — header row `text-xs uppercase
  tracking-wide text-neutral-500 border-b border-neutral-100`, rows separated by
  `border-neutral-100`, generous row padding (`py-3`) over dense packing.
- **Never load an unbounded list.** Every data table paginates or virtualizes at the query
  level — this is already the standing rule in `CLAUDE.md` Section O for Leads specifically.
- **Mobile: don't shrink the table.** Below `sm`, switch to a stacked card-per-row list (each
  row's primary field large, secondary fields as label/value pairs) — a table doesn't become
  usable by adding horizontal scroll on a form factor with no horizontal space to spare.
  Horizontal scroll inside a bounded container is acceptable only for genuinely wide data
  (e.g. a report with 12 numeric columns), not as the default mobile answer for every table.
- Row actions live in a trailing ghost-button/kebab-menu column, never as the only affordance
  requiring a hover state (hover-only actions are unreachable on touch).
- Search and filters sit directly above the table, left-aligned search + right-aligned filter
  controls on desktop, stacked full-width on mobile.

## 8. Cards, badges, avatars, status

- Card: `rounded-2xl bg-white p-5` (or `p-6` for content-heavier cards) with the elevation
  token from Section 4. A card groups genuinely related content — don't wrap every UI element
  in its own card "for structure."
- Badge/status pill: `rounded-full px-2.5 py-0.5 text-xs font-semibold`, semantic color pair
  from Section 4 (e.g. Active → `bg-emerald-50 text-emerald-700`, Inactive →
  `bg-neutral-100 text-neutral-500`). Status is never color-only — pair it with the word
  (`● Active`, not a bare colored dot) so it doesn't depend on color perception.
- Avatar: circular, initials-on-neutral-background fallback when no image, consistent
  `h-8 w-8` (table row) / `h-10 w-10` (profile/detail) sizing — don't introduce a third size.

## 9. Modals, dialogs, sheets

- **Dialog (centered modal):** short, focused interactions — confirmations, a single-field
  edit, a "delete this?" prompt. Max width `max-w-md`, `rounded-2xl`, the heavier shadow
  token, backdrop `bg-black/40`.
- **Sheet (side panel):** anything closer to a full form — creating/editing a record with
  several fields (see Section 10, this is exactly the New Lead case). Slides in from the
  right on desktop, full-height, keeps the underlying list visible/dimmed behind it so context
  isn't lost.
- **Full page:** reserve for genuinely multi-section, multi-step flows (an onboarding wizard,
  a settings page with many independent sections) — not for a single record's fields.
- Every dialog/sheet: focus moves into it on open and returns to the trigger on close, `Esc`
  closes it, clicking the scrim closes it (unless the action is destructive/irreversible —
  then require an explicit button), and it's rendered via a real `role="dialog"`
  `aria-modal="true"` primitive (shadcn `Dialog`/`Sheet` handle this correctly out of the box
  — don't hand-roll focus trapping).
- **Confirmation dialogs** specifically: state what will happen in one sentence, name the
  primary action after the actual verb ("Delete Lead", not "OK"), destructive action gets the
  destructive button variant, cancel is the secondary button and the default focus target for
  anything irreversible.

## 10. Sidebar & navigation

Keep the pattern already established in `features/sales-management/components/sidebar.tsx`:

- Desktop: fixed `w-64` sidebar, always visible, active route `bg-sky-50 text-sky-700`.
- Mobile: collapses behind a hamburger trigger into an off-canvas drawer with a scrim —
  already implemented in `app-shell.tsx`, keep using it rather than a bottom tab bar (this is
  a data-dense B2B app, not a consumer app; a left-nav drawer scales to more sections than a
  fixed bottom tab bar does).
- Modules not yet built are visible but disabled with a quiet "Soon" badge, never a dead
  link — this existing pattern is correct, keep it for any future incomplete section.
- Settings-style sub-navigation (already in the sidebar for Company Information / Add User /
  Profile) stays inline/expandable in the sidebar for ≤5 items; if a section grows past that,
  move it to in-page tabs (Section 11) instead of deepening the sidebar further.

## 11. Tabs

Use tabs to switch between views of the *same* object (e.g. a lead's Details / Activity /
Notes), never as a substitute for real navigation between different objects. Underline-style
active indicator (`border-b-2 border-sky-600 text-sky-700` vs. `text-neutral-500` inactive),
horizontal scroll on mobile if tabs don't fit rather than wrapping to a second line.

## 12. Empty, loading, error, success states

- **Empty state:** already-correct pattern on the dashboard — short bold statement
  (`text-sm font-medium text-neutral-700`) + one supporting sentence
  (`text-sm text-neutral-500`), centered, generous vertical padding (`py-14`). Add a primary
  action inside the empty state itself when there's an obvious next step (e.g. "No leads yet"
  + a "Create Lead" button), once that action exists.
- **Loading state:** inline — a button's own label changes (`"Save" → "Saving..."`,
  already the established pattern) plus `disabled`; for a whole section loading, a skeleton
  matching the final layout's shape, not a centered spinner replacing the entire page.
- **Error state:** an inline banner (`role="alert"`, red token) at the point of failure —
  above the form it belongs to, not a generic toast with no context. Never show a raw
  backend/Supabase error string (standing rule already in `CLAUDE.md` Section K).
- **Success state:** for a saved form, an inline confirmation (`role="status"`, emerald
  token) near the action, or a toast for actions taken from a list/table context where there's
  no obvious inline location.

## 13. Confirmation dialogs & toast notifications

- Confirm only genuinely destructive or hard-to-reverse actions (delete, bulk-remove,
  discard unsaved changes). Don't add a confirmation step to routine saves — that's friction
  without safety benefit.
- Toasts: transient, non-blocking, bottom-right on desktop, bottom-full-width on mobile,
  auto-dismiss (~4s) except errors that need the user to act. Use shadcn's `sonner`
  integration once adopted (Section 2) rather than a hand-rolled toast.

## 14. Responsive behavior

Don't shrink desktop layouts — redesign the layout per breakpoint with intent:

| | Desktop (≥1024px) | Tablet (640–1023px) | Mobile (<640px) |
|---|---|---|---|
| Navigation | Fixed sidebar | Fixed sidebar (narrower) or drawer | Off-canvas drawer |
| Forms | Two-column where fields pair naturally | Single or two-column depending on width | Always single column |
| Tables | Real table | Real table, horizontal scroll if wide | Stacked card list |
| Create/edit | Side sheet | Side sheet (full-width) | Full-screen view, not a modal |
| Stat cards | 4-across grid | 2-across grid | 1-across, stacked |

Touch targets ≥44px on any breakpoint below desktop. No horizontal page scroll, ever, at any
width — a wide table scrolls inside its own container, the page itself never does.

## 15. Accessibility & keyboard navigation

- Every interactive element is reachable and operable by keyboard alone, in a logical tab
  order matching visual order.
- Visible focus state on every focusable element (`focus:ring-2 focus:ring-sky-500/30` —
  already the established input pattern; extend it to buttons, links, and custom controls).
  Never `outline: none` without an equally visible replacement.
- Every form control has a real, associated `<label>`; every icon-only button has an
  `aria-label`; every error is linked to its field via `aria-describedby` and announced via
  `role="alert"` (already the pattern in `components/shared/form-field.tsx` — follow it
  everywhere else, including future shadcn-based forms).
- Dialogs/sheets: real `role="dialog"` + `aria-modal`, labelled via `aria-labelledby`, focus
  trapped inside while open, restored to the trigger on close.
- Color contrast: body text vs. background meets WCAG AA (4.5:1) at minimum — the established
  `neutral-600`/`700`/`900` on white/`neutral-50` already clears this; don't introduce a
  lighter gray for body text than `neutral-500`, and never `neutral-500` for anything smaller
  than 14px.
- State is never color-only (Section 8) — pair color with text, an icon, or both.

## 16. Interaction states (hover, focus, active, disabled, validation)

Every interactive element defines all of these explicitly, not just the resting state:

- **Hover:** a clear but subtle shift (`hover:bg-neutral-50` / `hover:bg-sky-700` / darken by
  one step) — never the only way an element communicates it's clickable (mobile has no hover).
- **Focus:** the ring token from Section 15, always visible, never removed for aesthetics.
- **Active/pressed:** a slightly darker shade of the hover state is enough — don't add scale
  transforms or bounce effects.
- **Disabled:** `opacity-60 cursor-not-allowed`, and disabled controls never carry a
  misleadingly "clickable" hover state.
- **Validation:** neutral border by default, `border-red-400` + message on error, no
  "success" green border on individual valid fields (reserve green for whole-form/action
  confirmation, per Section 12 — field-level green borders add noise without adding value).

---

## Case study: applying this to the New Lead experience

This section is a worked example of applying the rules above — not an implementation, and not
a copy of the reference screenshot (used only to confirm the field list below).

**Fields:** Company, Contact Name, Deal Value, Stage, Owner, Source, Next Step.

**Container decision (Section 9):** a **side sheet** on desktop/tablet, a **full-screen view**
on mobile — not a centered modal, and not a dedicated route.
- A centered modal for a 7-field form either feels cramped (small modal) or looks like a
  floating page in the middle of the screen with dead space around it (large modal) — this is
  very likely exactly what reads as "basic" in the client's feedback on the current version.
- A side sheet keeps the pipeline/list visible (dimmed) behind it, feels like a fast, native
  part of the workflow rather than an interruption, and is the standard modern-SaaS pattern
  for "create one record" (Linear, Height, Notion all use this for the equivalent action).
- A dedicated page is unnecessary friction for a form this size, and breaks the "stay in the
  pipeline view" mental model a sales rep wants while working a list of leads.
- On mobile, a side sheet has nowhere to slide from — use a full-screen view instead (still
  reachable via the same "New Lead" trigger), so touch targets and the keyboard have the
  whole viewport rather than fighting a half-width sheet.

**Field grouping (Section 6), two columns on desktop / one on mobile:**
1. **Lead identity:** Company, Contact Name (paired — always entered together)
2. **Deal:** Deal Value, Stage (paired — the two numbers-and-state fields a rep sets together)
3. **Assignment:** Owner, Source (paired — "who" and "where from")
4. **Follow-up:** Next Step — full width, it's free text and usually the longest value

**Primary action:** "Create Lead" (named after the verb, not "Save" or "Submit"), bottom-right
of the sheet, sticky if the sheet scrolls; "Cancel" as the secondary button to its left. On
mobile, both stack full-width at the bottom, primary on top.

**Fast entry for reps:** Stage and Owner default to sensible values (e.g. Stage → "New",
Owner → the current user) rather than forcing every field to be chosen from empty; Deal Value
uses a numeric input with currency formatting on blur, not free text; the whole form is
submittable via `Enter` from any single-line field.

---

## Checklist before shipping any new/redesigned screen

- [ ] Uses tokens from Section 4 — no new one-off color, radius, or shadow value
- [ ] One primary action, clearly the most visually prominent element
- [ ] Built from `components/ui/` or `components/shared/` — no new one-off control
- [ ] Has an intentional mobile layout, not a shrunk desktop layout
- [ ] Empty / loading / error / success states all defined, not just the happy path
- [ ] Every control keyboard-operable with a visible focus state
- [ ] Every input has a real label; every error is field-linked and screen-reader announced
- [ ] No raw backend error text ever reaches the UI
- [ ] Nothing color-only communicates state
