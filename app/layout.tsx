import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
