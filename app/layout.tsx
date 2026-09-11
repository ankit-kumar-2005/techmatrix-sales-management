import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { NavigationProgress } from "@/components/shared/navigation-progress";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Techmatrix Sales Management",
  description: "Manage your sales activities efficiently and securely with Techmatrix Sales Management.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* overflow-x-hidden here is a deliberate, defensive backstop: no
          single element in the app should ever force the page wider than
          the viewport, but a single sub-pixel/decorative-offset slip
          anywhere (a blurred hero orb, a floating badge, a marquee) is
          enough to make the *whole page* horizontally scrollable on a
          phone — which is what actually made the footer look "broken"
          (it's a normal 100%-width block; it just rides along with
          whatever else pushed the page wide). This guarantees that can
          never happen, regardless of which component it might be. */}
      <body className="flex min-h-full flex-col overflow-x-hidden">
        {/* useSearchParams() inside NavigationProgress requires its own
            Suspense boundary (a Next.js App Router rule) — scoped to
            just this leaf so it can't force the rest of the app (marketing
            pages that are otherwise statically rendered, e.g. /about)
            into dynamic rendering. fallback={null}: the bar is 0-width/
            invisible until mounted anyway, so there's nothing meaningful
            to show while this one boundary resolves. */}
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
