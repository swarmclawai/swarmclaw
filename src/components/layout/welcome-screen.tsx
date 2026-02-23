'use client'

import { useAppStore } from '@/stores/use-app-store'

export function WelcomeScreen() {
    const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)

    return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background animate-in fade-in duration-500">
            <div className="flex flex-col items-center max-w-md text-center">
                {/* Big Fire Logo */}
                <div className="w-24 h-24 rounded-[24px] bg-primary/10 flex items-center justify-center mb-8 shadow-[0_0_40px_rgba(var(--primary-rgb),0.15)]">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
                        <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
                    </svg>
                </div>

                {/* Branding */}
                <h1 className="font-display text-[40px] font-900 tracking-[-0.04em] text-foreground leading-none mb-6">
                    Agent EMBER
                </h1>

                {/* Welcome Text */}
                <p className="text-[16px] text-muted-foreground mb-10 leading-relaxed max-w-[360px]">
                    Welcome back. Create a session to start chatting, running commands, and managing your workspace.
                </p>

                {/* Action */}
                <button
                    onClick={() => setNewSessionOpen(true)}
                    className="px-8 py-3.5 rounded-[14px] bg-primary text-primary-foreground font-600 text-[15px] shadow-[0_4px_20px_rgba(var(--primary-rgb),0.25)] hover:brightness-110 active:scale-95 transition-all flex items-center gap-2"
                    style={{ fontFamily: 'inherit' }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Start New Session
                </button>
            </div>
        </div>
    )
}
