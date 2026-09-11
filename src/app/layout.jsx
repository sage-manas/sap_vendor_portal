import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ShellProvider } from "@/lib/shell-context";
import { PortalProvider } from "@/lib/portal-context";
import { ThemeProvider } from "@/lib/theme-context";
import PortalLayout from "@/components/portal/PortalLayout";

// Runs before first paint to resolve the theme and avoid a light→dark flash.
const themeScript = `(function(){try{var t=localStorage.getItem('vc-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;if(t==='dark'){r.classList.add('dark');}r.style.colorScheme=t;}catch(e){}})();`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Serif display face for page-level headings only (claude/DESIGN.md's
// Copernicus/Tiempos is a licensed Anthropic face; Source Serif 4 is an
// open, screen-legible stand-in that still reads editorial at 20-28px —
// Cormorant/EB Garamond, the doc's own suggested substitutes, get too
// delicate at the sizes a dense console actually uses for its headers).
const sourceSerif = Source_Serif_4({
  variable: "--font-serif-display",
  subsets: ["latin"],
  weight: ["500", "600"],
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
