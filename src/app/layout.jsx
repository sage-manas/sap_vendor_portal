import localFont from "next/font/local";
import Script from "next/script";
import { headers } from "next/headers";
import "./globals.css";
import { ShellProvider } from "@/lib/shell-context";
import { PortalProvider } from "@/lib/portal-context";
import { ThemeProvider } from "@/lib/theme-context";
import PortalLayout from "@/components/portal/PortalLayout";

// Runs before first paint to resolve the theme and avoid a light→dark flash.
const themeScript = `(function(){try{var t=localStorage.getItem('vc-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;if(t==='dark'){r.classList.add('dark');}r.style.colorScheme=t;}catch(e){}})();`;

// Fonts are self-hosted (src/app/fonts, the Latin subsets Google Fonts
// serves) rather than loaded through next/font/google, which downloads them
// from fonts.gstatic.com during every build — a network hiccup there failed
// CI's frontend build with nothing wrong in the code.
//
// IBM Plex Sans for the interface, IBM Plex Mono for identifiers and amounts
// only (docs/redesign/design-system.md). Each comes as two faces: the Latin
// subset, preloaded, and Latin Extended, which carries the rupee sign (U+20B9)
// and is fetched only when a glyph in its range is on the page. globals.css
// lists both families in --font-sans / --font-mono, so the browser picks per
// glyph. (Font loader options must be literals, so the Latin Extended range is
// written out in both calls.) adjustFontFallback is off on every face: its
// size-adjusted Arial face has no unicode-range, so it would sit between the
// two Plex faces in the stack and serve the rupee sign itself. adjustFontFallback is off everywhere: its
// size-adjusted Arial face has no unicode-range, so it would sit between the
// two Plex faces and serve the rupee sign itself.
const plexSans = localFont({
  src: "./fonts/IBMPlexSans-Latin-Variable.woff2",
  variable: "--font-plex-sans",
  weight: "100 700",
  display: "swap",
  adjustFontFallback: false,
});

const plexSansExt = localFont({
  src: "./fonts/IBMPlexSans-LatinExt-Variable.woff2",
  variable: "--font-plex-sans-ext",
  weight: "100 700",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+20A0-20AB, U+20AD-20C0, U+2113, U+A720-A7FF" }],
});

const plexMono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-Latin-400.woff2", weight: "400" },
    { path: "./fonts/IBMPlexMono-Latin-500.woff2", weight: "500" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
  adjustFontFallback: false,
});

const plexMonoExt = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-LatinExt-400.woff2", weight: "400" },
    { path: "./fonts/IBMPlexMono-LatinExt-500.woff2", weight: "500" },
  ],
  variable: "--font-plex-mono-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+20A0-20AB, U+20AD-20C0, U+2113, U+A720-A7FF" }],
});

export const metadata = {
  title: "Supplier Portal",
  description: "Register as a supplier, quote for requests, manage purchase orders and shipments, submit invoices, and track payments — all in one place.",
};

export default async function RootLayout({ children }) {
  // Minted per request in src/proxy.js. The theme script is inline, so it only
  // runs under the Content-Security-Policy if it carries this.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexSansExt.variable} ${plexMono.variable} ${plexMonoExt.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-script"
          strategy="beforeInteractive"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-base text-text-primary" suppressHydrationWarning>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <ThemeProvider>
          <ShellProvider>
            <PortalProvider>
              <PortalLayout>
                {children}
              </PortalLayout>
            </PortalProvider>
          </ShellProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
