import type { NextConfig } from "next";
import { execSync } from "child_process";
import { networkInterfaces } from "os";
import { DIRECT_NAV_SEGMENTS } from "./view-route-paths";

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

function getAllowedDevOrigins(): string[] {
  const allowed = new Set<string>([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
  ])

  // Include all active local IPv4 interfaces so LAN devices can load /_next assets in dev.
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const iface of interfaces ?? []) {
      if ((iface.family === 'IPv4' || (iface.family as string | number) === 4) && !iface.internal) {
        allowed.add(iface.address)
      }
    }
  }

  // Optional override for custom origins/hosts, e.g. `NEXT_ALLOWED_DEV_ORIGINS=host1,host2`.
  const extra = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/^https?:\/\//, '').replace(/\/$/, ''))
  for (const host of extra) allowed.add(host)

  return [...allowed]
}

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {
    // Pin workspace root to the project directory so a stale lockfile
    // in a parent folder (e.g. ~/) doesn't confuse native module resolution.
    root: process.cwd(),
  },
  experimental: {
    // Disable Turbopack persistent cache — concurrent HMR writes cause
    // "Another write batch or compaction is already active" errors
    turbopackFileSystemCacheForDev: false,
  },
  env: {
    NEXT_PUBLIC_GIT_SHA: getGitSha(),
    NEXT_PUBLIC_WS_PORT: String((Number(process.env.PORT) || 3456) + 1),
  },
  // Allow external network access
  serverExternalPackages: [
    'ws',
    'highlight.js', 'better-sqlite3',
    'discord.js', '@discordjs/ws', '@discordjs/rest',
    'grammy',
    '@slack/bolt', '@slack/web-api', '@slack/socket-mode',
    '@whiskeysockets/baileys',
    'qrcode',
  ],
  allowedDevOrigins: getAllowedDevOrigins(),
  async rewrites() {
    const views = DIRECT_NAV_SEGMENTS.join('|')
    return [
      {
        source: `/:view(${views})`,
        destination: '/',
      },
      {
        source: `/:view(${views})/:id`,
        destination: '/',
      },
    ]
  },
};

export default nextConfig;
