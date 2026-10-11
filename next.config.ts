import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/mcp': ['./.vidio/widget.html'],
  },
  // outputFileTracingRoot: path.resolve(__dirname, '../../'),  // Uncomment and add 'import path from "path"' if needed
  /* config options here */
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
  // Pin the Turbopack root to silence the multi-lockfile warning
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
