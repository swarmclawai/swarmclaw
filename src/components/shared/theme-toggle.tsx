'use client'

import * as React from 'react'
import { Sun, Moon } from 'lucide-react'
import { useTheme } from '@/components/providers/theme-provider'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

interface ThemeToggleProps {
    variant?: 'default' | 'sidebar'
}

export function ThemeToggle({ variant = 'default' }: ThemeToggleProps) {
    const { theme, setTheme } = useTheme()

    if (variant === 'sidebar') {
        return (
            <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
                <button
                    onClick={() => setTheme('light')}
                    className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${theme === 'light' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground/40 hover:text-muted-foreground'
                        }`}
                    title="Light mode"
                >
                    <Sun size={14} strokeWidth={2.5} />
                </button>
                <button
                    onClick={() => setTheme('dark')}
                    className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${theme === 'dark' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground/40 hover:text-muted-foreground'
                        }`}
                    title="Dark mode"
                >
                    <Moon size={14} strokeWidth={2.5} />
                </button>
            </div>
        )
    }

    const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light')

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    onClick={toggleTheme}
                    className="rail-btn relative transition-all duration-300"
                    title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
                >
                    <div className="relative w-5 h-5">
                        <Sun
                            className={`absolute inset-0 transition-transform duration-500 delay-100 ${theme === 'light' ? 'scale-100 rotate-0 opacity-100' : 'scale-0 rotate-90 opacity-0'
                                }`}
                            size={20}
                            strokeWidth={2}
                        />
                        <Moon
                            className={`absolute inset-0 transition-transform duration-500 delay-100 ${theme === 'dark' ? 'scale-100 rotate-0 opacity-100' : 'scale-0 -rotate-90 opacity-0'
                                }`}
                            size={20}
                            strokeWidth={2}
                        />
                    </div>
                </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}
                className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[10px] px-3.5 py-2.5">
                <div className="font-display text-[13px] font-600">Theme</div>
                <div className="text-[11px] text-text-3 leading-[1.4]">
                    Switch to {theme === 'light' ? 'dark' : 'light'} mode
                </div>
            </TooltipContent>
        </Tooltip>
    )
}
