---
name: frontend-quality
description: React/UI quality conventions for this project — component architecture, Tailwind, shadcn/ui, accessibility, responsive design, loading/error/empty states, forms, and UX consistency. Use whenever building or reviewing UI components.
---

# Frontend Quality

This is the deep reference behind `CLAUDE.md` Sections B and M. Read those first for the
binding rules — this document explains the reasoning and gives concrete patterns.

## Component placement

```
components/ui/            Generic UI primitives (shadcn/ui) — no domain knowledge
components/shared/         Genuinely shared across 2+ features
features/*/components/     Feature-specific — the default location for new components
```

Start every new component in `features/*/components/`. Promote to `components/shared/` only
once a second, real consumer exists — not speculatively "in case it's needed elsewhere."

## Tailwind and shadcn/ui

- Tailwind utilities for all styling; avoid parallel one-off CSS files.
- shadcn/ui primitives are generated into `components/ui/` and owned by this repo — they can
  be edited, but avoid forking their internals repeatedly for one-off needs. If a primitive
  needs significant, recurring customization, wrap it in a feature-level component instead of
  editing the primitive's core behavior each time.
- Keep utility class lists readable — prefer `cn()`/`clsx` composition and, once a pattern
  repeats across call sites, consider whether it should be a variant on the component instead
  of copy-pasted utility strings.

## Accessibility

- Semantic HTML first — `button` for actions, `a`/`Link` for navigation, proper heading
  hierarchy, `label` associated with every form control.
- Every interactive element is keyboard-reachable and has a visible focus state (shadcn/ui
  primitives handle most of this — don't strip it out with custom styling).
- Icon-only buttons get an accessible name (`aria-label` or visually-hidden text).
- Color is never the only signal (e.g., a lead status shown by color also has a text label/
  icon, for colorblind users and for scannability).
- Data tables (Leads, Contacts, etc.) use real `<table>` semantics or an ARIA grid pattern
  where TanStack Table's headless output is styled — not a div soup with no table semantics.

## Responsive design

- Design mobile-first where practical, since a future mobile client will exist and the web
  app itself should work on smaller viewports (tablets, narrow windows) for field sales use.
- Use Tailwind's responsive variants rather than separate mobile/desktop component branches.

## Loading, error, and empty states

Every data-driven view handles three states explicitly, not just the happy path:

- **Loading** — a skeleton or spinner appropriate to the content shape (e.g., a table
  skeleton for the Leads table, not a full-page spinner replacing an otherwise-stable layout).
- **Error** — a real recovery affordance (retry action, clear message) rather than a blank
  screen or an unhandled exception reaching `error.tsx`.
- **Empty** — a deliberate empty state (e.g., "No leads yet — capture your first lead") for
  legitimate zero-result cases, distinct from an error state.

## Forms

- React Hook Form + a Zod resolver, using the same schema the server validates with (see the
  `api-design` skill).
- Inline, field-level error messages tied to the actual failing field — not a single generic
  banner for every validation failure.
- Disable/loading-state the submit control during submission; surface server-side errors
  (e.g., a uniqueness conflict) back into the form, not as an unrelated toast with no context.

## UX consistency

- Reuse existing shadcn/ui components and `components/shared/` patterns for recurring needs
  (confirmation dialogs, page headers, empty states) instead of each feature inventing its
  own variant.
- Keep interaction patterns consistent across modules — e.g., if Leads uses a slide-over panel
  for record detail, Contacts and Opportunities should follow the same pattern unless there's
  a specific reason not to.
- Match the sales-management interface's existing visual language (per `CLAUDE.md` Section A)
  rather than introducing a new style per feature.
