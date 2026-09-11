"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

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
  // meaning Next has already committed its render. Skipped on the very
  // first render (mount), which fires with no prior `start()` call.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    finish();
  }, [pathname, searchParams]);

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

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[2000]">
      <div
        ref={barRef}
        style={{ width: "0%", opacity: 0 }}
        className="h-[2.5px] bg-gradient-to-r from-sky-500 via-blue-600 to-sky-500"
      />
    </div>
  );
}
