import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "Viberon",
  title: "Viberon",
  description: "Local AI coding workspace.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/logo.png",
  },
};

/**
 * Apply the saved theme before first paint, so a light-theme user never sees
 * a dark flash. Mirrors `resolveTheme` in store/viberon.ts.
 */
const THEME_SCRIPT = `try{var s=JSON.parse(localStorage.getItem("viberon.settings.v2")||"{}");var t=s.theme||"dark";if(t==="system")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="antialiased min-h-screen bg-background text-foreground font-sans">
        {children}
        <Toaster position="top-right" offset={44} />
      </body>
    </html>
  );
}
