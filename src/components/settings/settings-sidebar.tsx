'use client'

import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import {
    DownloadIcon,
    UploadIcon,
    SaveIcon,
    CheckCircle2Icon,
    AlertCircleIcon
} from 'lucide-react'

export function SettingsSidebar() {
    const appSettings = useAppStore((s) => s.appSettings)
    const updateSettings = useAppStore((s) => s.updateSettings)
    const credentials = useAppStore((s) => s.credentials)
    const secrets = useAppStore((s) => s.secrets)
    const loadSettings = useAppStore((s) => s.loadSettings)
    const loadProviders = useAppStore((s) => s.loadProviders)
    const loadCredentials = useAppStore((s) => s.loadCredentials)
    const loadSecrets = useAppStore((s) => s.loadSecrets)

    const [status, setStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (status) {
            const timer = setTimeout(() => setStatus(null), 3000)
            return () => clearTimeout(timer)
        }
    }, [status])

    const handleBackup = () => {
        try {
            const backupData = {
                version: '1.0',
                timestamp: Date.now(),
                appSettings,
                credentials,
                secrets
            }

            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `agent-ember-settings-${new Date().toISOString().split('T')[0]}.json`
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
            URL.revokeObjectURL(url)

            setStatus({ type: 'success', message: 'Backup complete' })
        } catch (err) {
            console.error('Backup failed:', err)
            setStatus({ type: 'error', message: 'Backup failed' })
        }
    }

    const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        try {
            const text = await file.text()
            const data = JSON.parse(text)

            if (!data.appSettings) {
                throw new Error('Invalid backup file')
            }

            await updateSettings(data.appSettings)

            loadSettings()
            loadProviders()
            loadCredentials()
            loadSecrets()

            setStatus({ type: 'success', message: 'Settings restored' })
        } catch (err: any) {
            console.error('Restore failed:', err)
            setStatus({ type: 'error', message: err.message || 'Restore failed' })
        }

        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    const handleSave = async () => {
        try {
            await updateSettings(appSettings)
            setStatus({ type: 'success', message: 'Settings saved' })
        } catch (err) {
            setStatus({ type: 'error', message: 'Save failed' })
        }
    }

    return (
        <div className="flex flex-col h-full px-4 py-6">
            <div className="flex-1">
                <h3 className="font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-4 px-2">
                    Data Management
                </h3>

                {status && (
                    <div className={`mb-4 p-3 rounded-[10px] flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-200
            ${status.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-destructive/10 text-destructive border border-destructive/20'}`}>
                        {status.type === 'success' ? <CheckCircle2Icon className="w-4 h-4" /> : <AlertCircleIcon className="w-4 h-4" />}
                        <span className="text-[12px] font-500">{status.message}</span>
                    </div>
                )}

                <div className="flex flex-col gap-2">
                    <button
                        onClick={handleBackup}
                        className="flex items-center gap-3 w-full p-3 rounded-[12px] bg-background border border-border text-foreground hover:bg-muted transition-all duration-200 text-[13px] font-500"
                        style={{ fontFamily: 'inherit' }}
                    >
                        <DownloadIcon className="w-4 h-4 text-muted-foreground" />
                        Backup Settings
                    </button>

                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-3 w-full p-3 rounded-[12px] bg-background border border-border text-foreground hover:bg-muted transition-all duration-200 text-[13px] font-500"
                        style={{ fontFamily: 'inherit' }}
                    >
                        <UploadIcon className="w-4 h-4 text-muted-foreground" />
                        Restore Settings
                    </button>

                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleRestore}
                        accept=".json"
                        className="hidden"
                    />
                </div>
            </div>

            <div className="pt-6 border-t border-border mt-auto">
                <button
                    onClick={handleSave}
                    className="flex items-center justify-center gap-2 w-full py-3.5 rounded-[12px] bg-primary text-primary-foreground text-[14px] font-600 cursor-pointer hover:opacity-90 active:scale-[0.98] transition-all duration-200 shadow-sm"
                    style={{ fontFamily: 'inherit' }}
                >
                    <SaveIcon className="w-4 h-4" />
                    Save Settings
                </button>
            </div>
        </div>
    )
}
