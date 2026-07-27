import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // vinext applies this limit before App Router handlers. Keep one extra
      // megabyte for multipart headers around the 500 MB video payload.
      bodySizeLimit: "501mb",
    },
  },
};

export default nextConfig;
