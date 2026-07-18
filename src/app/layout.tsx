import type { Metadata, Viewport } from "next"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { AppQueryProvider } from "@/components/providers/app-query-provider"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { I18nProvider } from "@/components/providers/i18n-provider"  // ✅ 新增
import "./globals.css"

// ❌ 删除这一行：import '../i18n';

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

export const dynamic = "force-dynamic"

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>  {/* 改成 zh-CN */}
      <body className="antialiased" cz-shortcut-listen="true">
        <ThemeProvider>
          <AppQueryProvider>
            <TooltipProvider>
              <I18nProvider>   {/* ✅ 用 I18nProvider 包裹所有需要翻译的内容 */}
                <DashboardShell>
                  {children}
                </DashboardShell>
                <Toaster />
              </I18nProvider>
            </TooltipProvider>
          </AppQueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
