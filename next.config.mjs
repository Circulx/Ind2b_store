/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native / server-only packages are loaded from node_modules at run time instead of being bundled.
  serverExternalPackages: ["sharp", "mongoose", "nodemailer", "bcryptjs"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
