"""Check whether amtrak.com serves real pages to a cloud-hosted browser.

Loads the Amtrak homepage and the NYP -> CHI search URL in headless
Chromium and reports the HTTP status, final URL, page title, whether
bot-protection markers appear, and whether fare result rows rendered.
Screenshots and HTML are saved to ``probe-output/``.
"""

from __future__ import annotations

import json
import os
from datetime import date, timedelta

from playwright.sync_api import sync_playwright

from fare_finder import build_search_url

BLOCK_MARKERS = ("access denied", "reference #", "akamai", "captcha", "unusual traffic", "request unsuccessful")
OUT_DIR = "probe-output"


def probe(page, name: str, url: str) -> dict:
    result = {"name": name, "url": url}
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(15_000)
        html = page.content()
        lowered = html.lower()
        result.update(
            status=response.status if response else None,
            final_url=page.url,
            title=page.title(),
            html_bytes=len(html),
            block_markers=[m for m in BLOCK_MARKERS if m in lowered],
            result_rows=page.locator('[data-testid="search-result-row"]').count(),
            body_text_start=page.inner_text("body")[:400] if page.locator("body").count() else "",
        )
        page.screenshot(path=f"{OUT_DIR}/{name}.png", full_page=True)
        with open(f"{OUT_DIR}/{name}.html", "w", encoding="utf-8") as f:
            f.write(html)
    except Exception as exc:  # noqa: BLE001 - report every failure mode
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    search_date = (date.today() + timedelta(days=30)).isoformat()
    targets = [
        ("homepage", "https://www.amtrak.com/"),
        ("search", build_search_url(search_date)),
    ]
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            for name, url in targets:
                results.append(probe(page, name, url))
        finally:
            browser.close()
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
