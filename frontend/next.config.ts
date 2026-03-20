import type { NextConfig } from "next";

// 后端端口：默认 8000；若后端用 LEROBOT_WEBUI_PORT=8001 启动，请设 NEXT_PUBLIC_BACKEND_PORT=8001 或 .env.local 中配置
const BACKEND_PORT = process.env.NEXT_PUBLIC_BACKEND_PORT || "8000";
const backendOrigin = `http://127.0.0.1:${BACKEND_PORT}`;

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendOrigin}/api/:path*`,
      },
      {
        source: "/ws/:path*",
        destination: `${backendOrigin}/ws/:path*`,
      },
    ];
  },
};

export default nextConfig;
