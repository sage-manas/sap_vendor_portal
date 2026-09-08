import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata = {
  title: "Supplier Portal",
  description: "Register as a supplier, quote for requests, manage purchase orders and shipments, submit invoices, and track payments — all in one place.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
