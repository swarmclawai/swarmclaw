import type { Metadata, Viewport } from "next"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { AppQueryProvider } from "@/components/providers/app-query-provider"
import { ThemeProvider } from "@/components/providers/theme-provider"
import "./globals.css"

export const metadata: Metadata = {
  title: "SwarmClaw",
  description: "Self-hosted AI runtime for OpenClaw, agent swarms, runtime skills, and wallets.",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
}

// Avoid static prerendering for the app shell. This prevents flaky
// Turbopack prerender failures seen in detached fresh-install builds.
export const dynamic = "force-dynamic"

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased" cz-shortcut-listen="true">
        <ThemeProvider>
          <AppQueryProvider>
            <TooltipProvider>
              <DashboardShell>
                {children}
              </DashboardShell>
              <Toaster />
            </TooltipProvider>
          </AppQueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
