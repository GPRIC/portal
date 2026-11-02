import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The sample documents are read from disk by the /sample-docs route; ship them with it.
  outputFileTracingIncludes: { "/sample-docs/[name]": ["./sample-docs/**/*"] },
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }];
  },
};

export default nextConfig;
