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
  },
  // Allow external network access
  serverExternalPackages: [
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
