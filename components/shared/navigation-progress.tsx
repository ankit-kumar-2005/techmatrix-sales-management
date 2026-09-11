"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * How many route-level loading fallbacks (app/(app)/*\/loading.tsx) are
 * currently on screen. Module-level rather than React state because the
 * bar and the fallbacks live in completely different branches of the
 * tree — the bar is mounted once in the root layout, each fallback is
 * mounted deep inside whichever route is loading — so there is no
 * sensible common ancestor to hold this in, and a context provider for
 * one integer would be more machinery than the problem deserves.
 */
let routeLoadingHolds = 0;
const holdListeners = new Set<(holds: number) => void>();

function notifyHoldListeners() {
  holdListeners.forEach((listener) => listener(routeLoadingHolds));
}

/**
 * Rendered by each route's loading.tsx. Renders nothing — it exists only
 * to tell NavigationProgress "this route has committed, but its real
 * content still isn't here."
 *
 * WHY THIS EXISTS: adding loading.tsx changes *when* Next commits a
 * navigation. Without one, the router holds the old page until the new
 * route's payload is ready, so pathname changes late and the bar
 * naturally spans the whole wait. With one, Next commits immediately and
 * shows the fallback — pathname changes within a few milliseconds, which
 * would make the bar shoot to 100% and vanish while the skeleton sits
 * there loading. The bar would still technically "appear" on every
 * navigation, but it would stop meaning anything. This keeps the bar
 * running until the skeleton is replaced by real content.
 */
export function RouteLoadingIndicator() {
  useEffect(() => {
    routeLoadingHolds += 1;
    notifyHoldListeners();
    return () => {
      routeLoadingHolds -= 1;
      notifyHoldListeners();
    };
  }, []);

  return null;
}

/**
 * A thin, blue, top-of-viewport progress bar shown while an internal
 * route transition is in flight — purely a status indicator. It does
 * not intercept, delay, or alter navigation itself; it only reacts to
 * navigation that's already happening, the same way a browser's own
 * native loading indicator would, so it can never block a click, a
 * keyboard-triggered navigation, or a Server Action.
 *
 * Next.js's App Router has no built-in "navigation started"/"navigation
 * finished" event (unlike the old Pages Router's `Router.events`), so
 * this uses the two signals that ARE available:
 *  - START: a capturing `click` listener on `document` that recognizes a
 *    same-tab, same-origin, unmodified left-click on an internal link
 *    (this is what every sidebar/nav <Link> and in-page <a> resolves to
 *    in the DOM — no change to the Sidebar or any Link usage needed),
 *    plus `popstate` for browser Back/Forward.
 *  - FINISH: `usePathname()`/`useSearchParams()` changing is exactly the
 *    signal that the destination route has actually taken over — Next
 *    only commits a new pathname once the new segment's payload is
 *    ready, so this can't finish early and hide the bar before the page
 *    is actually there.
 *
 * Deliberately excluded from "start": external links (different
 * origin), links with target!=_self/download, hash-only links on the
 * same page, modified clicks (ctrl/cmd/shift/alt-click, middle-click),
 * and any click a handler already called preventDefault() on (a button
 * disguised as a link, or a link whose own onClick does something other
 * than navigate) — none of those actually trigger the kind of route
 * transition this bar exists to represent.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const barRef = useRef<HTMLDivElement>(null);
  const isNavigatingRef = useRef(false);
  const trickleTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isMounted, setIsMounted] = useState(false);

  // Gates the portal below — see its own comment for why this is needed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- createPortal needs a real `document`, which doesn't exist during SSR, so this one-time mount flag is the standard hydration-safe pattern (same exception AppShell takes for its localStorage-backed sidebar preference). One boolean, once, before anything is visible.
    setIsMounted(true);
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(trickleTimer.current);
      clearTimeout(finishTimer.current);
    };
  }, []);

  function start() {
    const bar = barRef.current;
    if (!bar || isNavigatingRef.current) return;
    isNavigatingRef.current = true;

    clearTimeout(finishTimer.current);
    clearInterval(trickleTimer.current);

    bar.style.transition = "none";
    bar.style.opacity = "1";
    bar.style.width = "0%";
    // Force a reflow so the width change below animates from 0 instead
    // of being batched together with the reset above.
    void bar.offsetWidth;
    bar.style.transition = "width 300ms ease-out, opacity 150ms ease-out";
    bar.style.width = "20%";

    let width = 20;
    trickleTimer.current = setInterval(() => {
      // Approach (but never reach) 90% while the destination route is
      // still loading — the remaining 10% is reserved for `finish()`,
      // so the bar always has visible room left to complete into.
      width += (90 - width) * 0.1;
      if (barRef.current) barRef.current.style.width = `${Math.min(width, 90)}%`;
    }, 300);
  }

  function finish() {
    if (!isNavigatingRef.current) return;
    isNavigatingRef.current = false;
    clearInterval(trickleTimer.current);

    const bar = barRef.current;
    if (!bar) return;

    bar.style.width = "100%";
    finishTimer.current = setTimeout(() => {
      if (!barRef.current) return;
      barRef.current.style.opacity = "0";
      finishTimer.current = setTimeout(() => {
        if (barRef.current) barRef.current.style.width = "0%";
      }, 150);
    }, 200);
  }

  // FINISH signal — the destination route has taken over the URL bar,
  // meaning Next has committed its render. Skipped on the very first
  // render (mount), which fires with no prior `start()` call.
  //
  // Deferred by one macrotask rather than finishing inline: for a route
  // that has a loading.tsx, the fallback mounts in the SAME commit that
  // changes the pathname, and effect order between two unrelated
  // branches of the tree (this bar in the root layout vs. the fallback
  // deep inside the route) is not something to rely on. A setTimeout(0)
  // is guaranteed to run after every effect from that commit has flushed,
  // so `routeLoadingHolds` is accurate by the time it's read.
  const isFirstRender = useRef(true);
  const awaitingHoldReleaseRef = useRef(false);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const timer = setTimeout(() => {
      if (routeLoadingHolds > 0) {
        // A skeleton is on screen — keep trickling until it's replaced.
        awaitingHoldReleaseRef.current = true;
        return;
      }
      finish();
    }, 0);

    return () => clearTimeout(timer);
  }, [pathname, searchParams]);

  // The other half of the above: a route whose skeleton was showing has
  // now been replaced by real content. Routes with no loading.tsx never
  // register a hold, so they finish on the pathname change alone exactly
  // as they did before this existed.
  useEffect(() => {
    function handleHoldChange(holds: number) {
      if (holds !== 0 || !awaitingHoldReleaseRef.current) return;

      // Re-check on the next macrotask instead of finishing immediately.
      // Clicking a second nav item while the first route's skeleton is
      // still on screen unmounts that skeleton and mounts the next one,
      // so the count dips 1 → 0 → 1 within a single commit. Reading the
      // momentary 0 as "the page arrived" would complete the bar mid-
      // chain and leave the final route with no indicator at all.
      setTimeout(() => {
        if (routeLoadingHolds === 0 && awaitingHoldReleaseRef.current) {
          awaitingHoldReleaseRef.current = false;
          finish();
        }
      }, 0);
    }

    holdListeners.add(handleHoldChange);
    return () => {
      holdListeners.delete(handleHoldChange);
    };
  }, []);

  // START signal — a capturing document-level click listener, so it
  // doesn't need to be wired into the Sidebar or any individual <Link>.
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      let destination: URL;
      try {
        destination = new URL(href, window.location.href);
      } catch {
        return;
      }

      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) {
        return; // Same route (e.g. a same-page hash link) — nothing will actually transition.
      }

      start();
    }

    function handlePopState() {
      start();
    }

    document.addEventListener("click", handleClick);
    window.addEventListener("popstate", handlePopState);
    return () => {
      document.removeEventListener("click", handleClick);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // PORTALED to document.body, for the same reason Modal is (see its own
  // comment): `position: fixed` escapes normal layout but does NOT escape
  // an ancestor's stacking context or containing block. Rendered in place
  // in the root layout, this bar sat BEFORE {children} in the DOM, so any
  // later-painted positioned sibling — the sticky sidebar wrapper in
  // AppShell, a sticky header — could cover it the moment anything
  // interfered with its z-index taking effect. A portal puts the node
  // last under <body>, in the root stacking context, independent of
  // wherever it's invoked from in the React tree.
  //
  // zIndex is an INLINE STYLE rather than a `z-[...]` utility so it can't
  // lose a cascade-layer or specificity fight. App layer ladder:
  //   30    sticky marketing / mobile headers
  //   40/50 mobile off-canvas nav drawer
  //   999   mobile-nav-drawer scrim / 1000 Modal
  //   1100  success toasts
  //   ^ this bar sits above all of them, by a wide margin.
  //
  // Mounted flag: this is a Client Component but it still server-renders,
  // and createPortal needs a real `document`. Rendering null until mount
  // costs nothing visually — the bar is 0-width and fully transparent
  // until a navigation starts, and a navigation can't start before
  // hydration anyway.
  if (!isMounted) {
    return null;
  }

  return createPortal(
    <div aria-hidden="true" style={{ zIndex: 9999 }} className="pointer-events-none fixed inset-x-0 top-0">
      <div
        ref={barRef}
        style={{ width: "0%", opacity: 0 }}
        className="h-[2.5px] bg-gradient-to-r from-sky-500 via-blue-600 to-sky-500"
      />
    </div>,
    document.body,
  );
}
