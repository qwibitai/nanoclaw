import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is native — keep it server-only
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
