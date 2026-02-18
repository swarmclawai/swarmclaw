import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow external network access
  serverExternalPackages: [
    'highlight.js', 'better-sqlite3',
    'discord.js', '@discordjs/ws', '@discordjs/rest',
    'grammy',
    '@slack/bolt', '@slack/web-api', '@slack/socket-mode',
    '@whiskeysockets/baileys',
    'qrcode',
  ],
  allowedDevOrigins: ['*'],
};

export default nextConfig;
