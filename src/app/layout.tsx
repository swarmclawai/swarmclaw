import type { Metadata, Viewport } from "next"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import "./globals.css"

export const metadata: Metadata = {
  title: "SwarmClaw",
  description: "Self-hosted AI orchestration control plane for OpenClaw, agent swarms, runtime skills, and wallets.",
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
    <html lang="en" className="dark">
      <body className="antialiased" cz-shortcut-listen="true">
        <TooltipProvider>
          <DashboardShell>
            {children}
          </DashboardShell>
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  )
}
