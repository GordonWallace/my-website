"""Check whether amtrak.com serves real pages to a cloud-hosted browser.

Loads the Amtrak homepage and the NYP -> CHI search URL in headless
Chromium and reports the HTTP status, final URL, page title, whether
bot-protection markers appear, and whether fare result rows rendered.
Screenshots and HTML are saved to ``probe-output/``.
"""

from __future__ import annotations

import json
import os
import re
from datetime import date, timedelta
from urllib.parse import urlparse

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


def probe_form_search(page, search_date: date) -> dict:
    """Search NYP -> CHI the way a person would, through the homepage form."""
    result = {"name": "form-search"}
    api_calls = []

    def on_response(response):
        host = urlparse(response.url).hostname or ""
        if host.endswith("amtrak.com") and response.request.resource_type in ("xhr", "fetch", "document"):
            api_calls.append({"status": response.status, "url": response.url[:160]})

    page.on("response", on_response)
    try:
        page.goto("https://www.amtrak.com/home", wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(8_000)
        result["inputs"] = page.eval_on_selector_all(
            "input",
            "els => els.filter(e => e.offsetParent).map(e => ({id: e.id, name: e.name, aria: e.getAttribute('aria-label'), placeholder: e.placeholder}))",
        )
        steps = []
        for label, code in (("From", "NYP"), ("To", "CHI")):
            field = page.locator(f'input[aria-label="{label}"]').first
            field.click()
            field.fill(code)
            page.wait_for_timeout(2_500)
            option = page.get_by_role("option").first
            if option.count():
                steps.append(f"{label}: picked '{option.inner_text()[:60]}'")
                option.click()
            else:
                steps.append(f"{label}: no autocomplete option")
                field.press("Enter")
        depart = page.locator("input#am-form-field-control-4").first
        depart.click()
        depart.fill(search_date.strftime("%m/%d/%Y"))
        depart.press("Escape")
        steps.append("date filled")
        page.get_by_role("button", name=re.compile("find trains", re.I)).first.click()
        steps.append("clicked FIND TRAINS")
        page.wait_for_timeout(25_000)
        result["steps"] = steps
        html = page.content()
        result.update(
            final_url=page.url,
            title=page.title(),
            block_markers=[m for m in BLOCK_MARKERS if m in html.lower()],
            body_text_start=page.inner_text("body")[:800],
        )
        page.screenshot(path=f"{OUT_DIR}/form-search.png", full_page=True)
        with open(f"{OUT_DIR}/form-search.html", "w", encoding="utf-8") as f:
            f.write(html)
    except Exception as exc:  # noqa: BLE001 - report every failure mode
        result["error"] = f"{type(exc).__name__}: {exc}"[:600]
        try:
            page.screenshot(path=f"{OUT_DIR}/form-search-error.png", full_page=True)
        except Exception:  # noqa: BLE001
            pass
    result["api_calls"] = api_calls[-40:]
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
            results.append(probe_form_search(browser.new_page(), date.today() + timedelta(days=30)))
        finally:
            browser.close()
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
