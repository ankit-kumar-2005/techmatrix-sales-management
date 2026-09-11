import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
      {/* NavigationProgress deliberately does NOT live here any more. It's
          rendered by AppShell instead, inside the authenticated layout's
          content column, so it spans that column rather than the whole
          viewport (it used to sit behind/over the sidebar). Consequence:
          the marketing and auth routes, which don't use AppShell, have no
          progress bar — they're static or single-step pages where there's
          no multi-query navigation to report on. */}
      <body className="flex min-h-full flex-col overflow-x-hidden">{children}</body>
    </html>
  );
}
