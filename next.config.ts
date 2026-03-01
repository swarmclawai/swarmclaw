import type { NextConfig } from "next";
import { execSync } from "child_process";

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

const nextConfig: NextConfig = {
  output: 'standalone',
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
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
  ],
};

export default nextConfig;
