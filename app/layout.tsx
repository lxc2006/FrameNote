import type { Metadata } from "next";
import "./globals.css";

const THEME_BOOTSTRAP_SCRIPT = String.raw`
(() => {
  try {
    const stored = localStorage.getItem("framenote.user-preferences.v1");
    if (!stored) return;
    const theme = JSON.parse(stored)?.theme;
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch {}
})();
`;

export const metadata: Metadata = {
  title: "帧记 FrameNote｜B站视频 AI 总结",
  description:
    "上传本地视频或粘贴 B站链接，生成结构化 AI 总结，并围绕视频内容继续追问。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
