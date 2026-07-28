from __future__ import annotations

import unittest

from media_service.web_extract import (
    FetchedBody,
    _extract_html,
    _validate_public_url,
)


class WebExtractTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_network_targets_are_rejected(self) -> None:
        for value in (
            "http://127.0.0.1/private",
            "http://192.168.1.20/private",
            "http://localhost/private",
        ):
            with self.assertRaises(ValueError):
                await _validate_public_url(value)

    def test_trafilatura_extracts_article_text_and_metadata(self) -> None:
        body = """
        <!doctype html>
        <html lang="zh-CN">
          <head><title>正文提取测试</title></head>
          <body>
            <nav>无关导航</nav>
            <article>
              <h1>正文提取测试</h1>
              <p>这是用于验证正文抽取链路的第一段文字，包含足够多的信息，使正文不会被识别为一个空页面。</p>
              <p>这是第二段正文。它说明普通 HTML 会先经过 Trafilatura，而不是把搜索结果摘要直接交给模型。</p>
              <p>这是第三段正文。提取后的文本将由应用侧选择与搜索关键词最相关的段落。</p>
            </article>
          </body>
        </html>
        """.encode()
        result = _extract_html(
            FetchedBody(
                requested_url="https://example.com/article",
                final_url="https://example.com/article",
                content_type="text/html; charset=utf-8",
                body=body,
                encoding="utf-8",
            )
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.method, "trafilatura")
        self.assertIn("搜索结果摘要", result.text or "")

    def test_javascript_shell_requests_browser_fallback(self) -> None:
        result = _extract_html(
            FetchedBody(
                requested_url="https://example.com/app",
                final_url="https://example.com/app",
                content_type="text/html",
                body=b"<html><body><div id='root'></div><p>Enable JavaScript</p></body></html>",
                encoding="utf-8",
            )
        )
        self.assertEqual(result.status, "requires_browser")
        self.assertEqual(result.errorCode, "REQUIRES_BROWSER")


if __name__ == "__main__":
    unittest.main()
