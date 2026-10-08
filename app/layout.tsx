import type { Metadata, Viewport } from "next";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "有序 · 人生工作台",
  description: "梳理生活线索，留下经历与思考，回顾变化。一个帮助自省、自我发现和成长的人生看板。",
  manifest: `${basePath}/manifest.webmanifest`,
  appleWebApp: { capable: true, title: "有序", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f5f0",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
