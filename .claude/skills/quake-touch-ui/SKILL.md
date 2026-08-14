---
name: quake-touch-ui
description: Design rules for building touch UI on the Quake panel (1920x480 kiosk touchscreen viewed at arm's length). MUST be followed when creating or restyling any on-panel page, overlay, or control. Complements docs/design-system.md.
---

# Touch UI on the Quake panel

The panel is a 1920x480 landscape touchscreen viewed at ~24" (arm's length on a desk) — farther
than a phone (~13"). Phone-scale UI is ~1.6x too small here. The distance-calibrated references
are Android Auto/Automotive (76dp targets, 24dp minimum body text), not phone Material/HIG.
Read `docs/design-system.md` first; this file adds the touch/kiosk numbers and patterns.

## Sizes (CSS px on this panel)

| Thing | Number |
|---|---|
| Touch target minimum | 48px (never below; WCAG floor is 24 — that is a floor, not a goal) |
| Touch target standard | **64–80px** rows/buttons (Android Auto's 76dp is the anchor) |
| Gap between adjacent targets | **≥12px** |
| Body / list-item text | **22–28px** (26px is the proven size here — Keyboard Shortcuts app) |
| Primary labels / focal text | 28–32px |
| Tertiary metadata only | ≤18px — never for anything the user must read to act |
| Icons inside targets | ~44px primary, 36px secondary |

## Patterns

- **Long selection lists (pick 1 of N names): uniform-width, left-aligned rows.** Eyes scan the
  left edge; ragged variable-width chips/pills break the scan column. Chips are for filters, not
  selection sets. Alphabetical order only when users know the name they want.
- **50+ items: add jump navigation** — an A–Z strip (horizontal on this panel) that scrolls to the
  section. Long swipes on large screens are strenuous; never rely on flinging alone.
- **Always pair with a recents/favorites row** so the common 5–10 picks are one tap, no scrolling.
- **Folder/tree pickers:** the standard mobile pattern is tap-row = navigate in, plus a persistent
  "Use this folder" button that selects the *current* directory, breadcrumb + Up for location.
  (When the dominant use is picking one of N siblings, tap-name = select with a separate `›`
  browse zone is acceptable — but the `›` zone must itself be a full-size ≥48px target.)
- **Filter-as-you-type** beats scrolling for known names, but only where a keyboard is natural.
- **Pick-one settings (device, voice, theme…): show the CURRENT value on one big row ("Speaker —
  System default ›"); tapping opens a dedicated full-size picker overlay** with uniform rows and
  ▲/▼ paging. NEVER embed always-visible scrollable lists inside a settings dialog — they crowd
  the dialog, truncate labels, and force native scrollbars (violated + corrected 2026-08-12).

## Scrolling

**Every control on the Quake is designed for FINGERS — including the scroll control itself.**
A mouse also happens to work on this panel; that is never a reason to design for one.

- Every scroll region gets a **fat, finger-draggable scrollbar (~44px track, rounded thumb)**.
  **It MUST be a real DOM element driven by pointer events** — Chromium's
  `::-webkit-scrollbar`-styled bars are mouse-only and silently ignore touch, and native
  unstyled bars accept touch but can't be made finger-sized. Reference implementation:
  `syncProjThumb`/`wireProjScroll` in app/claudevoiceview.js (thumb drag + tap-track-to-page).
  (Generic mobile guidance says thumbs are decorative because phones fling — do NOT import that
  assumption here; the fat thumb is the established, user-preferred pattern on this panel.
  This was litigated 2026-08-12; don't relitigate it.)
- On scroll regions: `overscroll-behavior: contain;`. Globally: `touch-action: manipulation;`
  (kills double-tap-zoom tap delay).
- Scroll only the region that needs it (design-system rule); never the page.
- Do NOT add letter-index strips / jump rails — tried, rejected as too small to touch reliably
  on this screen height. Recents rows + the fat scrollbar are the navigation aids here.

## Focus vs selection (Chromium kiosk)

- Chromium shows a focus ring after tap. Suppress it the standard way — style `:focus-visible`
  for keyboard and remove the ring for pointer/touch:
  `button:focus:not(:focus-visible) { outline: none; }`
  Never blanket-remove `:focus` outlines (breaks keyboard use in the editor-hosted pages).
- **Selected state = container fill** (accent background + contrasting text), optionally with a
  checkmark. Never an outline/border — thin strokes read as focus rings and are weak at distance.
  Exactly ONE thing on screen may carry the selected fill.

## Checklist before shipping any panel UI

1. Every tappable thing ≥48px, standard ones 64–80px, ≥12px apart?
2. All action-critical text ≥22px, primary content ≥26px?
3. Lists: uniform rows, left-aligned, recents row, jump nav if 50+?
4. Scroll regions fling properly (`touch-action`, `overscroll-behavior`), no interactive-scrollbar dependence?
5. No focus rings after tap; selection shown by fill; only one selected fill on screen?
6. Wide-screen layout actually used (columns/panels), not a phone layout stretched?
7. Words match the device's vocabulary ("folder" not "project"; match Music/Meeting phrasing).

Sources: Android Auto/AAOS design system (sizing, typography), Apple HIG, Material 3 (targets,
selection), Fluent (targeting), WCAG 2.5.8, NN/g (alphabetical sorting, very-large touchscreens),
Chrome scrollbar/overscroll docs, MDN touch-action/:focus-visible.
