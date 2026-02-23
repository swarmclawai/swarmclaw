'use client'

import * as React from 'react'

type Theme = 'light' | 'dark'

interface ThemeProviderContext {
    theme: Theme
    setTheme: (theme: Theme) => void
    toggleTheme: () => void
}

const ThemeContext = React.createContext<ThemeProviderContext | undefined>(undefined)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setThemeState] = React.useState<Theme>('dark')

    React.useEffect(() => {
        const savedTheme = localStorage.getItem('theme') as Theme | null
        if (savedTheme) {
            setThemeState(savedTheme)
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            setThemeState('dark')
        } else {
            setThemeState('light')
        }
    }, [])

    React.useEffect(() => {
        const root = window.document.documentElement
        root.classList.remove('light', 'dark')
        root.classList.add(theme)
        localStorage.setItem('theme', theme)
        console.log(`[ThemeProvider] Applied theme: ${theme} to documentElement`)
    }, [theme])

    const setTheme = (t: Theme) => setThemeState(t)
    const toggleTheme = () => setThemeState((prev) => (prev === 'light' ? 'dark' : 'light'))

    return (
        <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    const context = React.useContext(ThemeContext)
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider')
    }
    return context
}
