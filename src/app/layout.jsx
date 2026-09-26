import localFont from "next/font/local";
import Script from "next/script";
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
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

// Serif display face for page-level headings only (claude/DESIGN.md's
// Copernicus/Tiempos is a licensed Anthropic face; Source Serif 4 is an
// open, screen-legible stand-in that still reads editorial at 20-28px —
// Cormorant/EB Garamond, the doc's own suggested substitutes, get too
// delicate at the sizes a dense console actually uses for its headers).
const sourceSerif = localFont({
  src: "./fonts/SourceSerif4-Variable.woff2",
  variable: "--font-serif-display",
  weight: "500 600",
});

export const metadata = {
  title: "Supplier Portal",
  description: "Register as a supplier, quote for requests, manage purchase orders and shipments, submit invoices, and track payments — all in one place.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-script"
          strategy="beforeInteractive"
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
