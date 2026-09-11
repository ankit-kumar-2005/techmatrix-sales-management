"use client";

import { useEffect, useRef } from "react";
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
      // NOTE: no `event.defaultPrevented` check, and this listener runs in
      // the CAPTURE phase (see addEventListener below). Both are load-
      // bearing. next/link's own click handler calls e.preventDefault()
      // for every local URL before doing its client-side navigation
      // (node_modules/next/dist/client/link.js:93). A bubble-phase
      // listener on `document` therefore sees defaultPrevented === true
      // for every single sidebar link, and bailing on that meant start()
      // was never called — the bar stayed at width 0 / opacity 0 and was
      // invisible on every Link navigation. Capture runs document -> target,
      // i.e. before React's handler, so the click is still pristine here.
      if (event.button !== 0) return;
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

    document.addEventListener("click", handleClick, true);
    window.addEventListener("popstate", handlePopState);
    return () => {
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // Scoped to the MAIN CONTENT COLUMN, not the viewport. AppShell renders
  // this as the first child of its content column (the flex sibling of
  // the <aside>), so the column itself defines the bar's left edge and
  // width — no hardcoded sidebar offset, and nothing to keep in sync when
  // the sidebar toggles between w-64 and w-[72px], or disappears entirely
  // below `lg` where the column becomes full-width. The geometry follows
  // the layout for free.
  //
  // `sticky top-0` (not `fixed`) keeps it pinned to the top of that column
  // as the page scrolls. `h-0` means it contributes no height, so adding
  // it shifts no content down; the 2.5px bar simply overflows the
  // zero-height sticky box. z-50 clears everything inside the column
  // (page headers, toolbars, sticky filters) without needing to compete
  // with the sidebar, modals or toasts, which it no longer overlaps.
  return (
    <div aria-hidden="true" className="pointer-events-none sticky top-0 z-50 h-0">
      <div
        ref={barRef}
        style={{ width: "0%", opacity: 0 }}
        className="h-[2.5px] bg-gradient-to-r from-sky-500 via-blue-600 to-sky-500"
      />
    </div>
  );
}
