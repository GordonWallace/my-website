"""Amtrak Fare Finder - proof of concept scraper.

Given a single departure date, this script looks up the fare options
Amtrak offers for a trip from New York Penn Station (NYP) to Chicago
Union Station (CHI).

See README.md in this directory for the approach and its limitations.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlencode

from bs4 import BeautifulSoup

ORIGIN_STATION_CODE = "NYP"
DESTINATION_STATION_CODE = "CHI"

SEARCH_BASE_URL = "https://www.amtrak.com/tickets/departure-search"

# Amtrak's search results page hydrates its React/Angular app from a JSON
# blob assigned to a global variable before it paints the fare table. The
# exact variable name has changed over the years; we try a small list of
# known/likely names so the "prefer structured data" path keeps working
# even if one of them goes away.
_EMBEDDED_DATA_PATTERNS = (
    re.compile(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\});", re.DOTALL),
    re.compile(r"window\.__PRELOADED_STATE__\s*=\s*(\{.*?\});", re.DOTALL),
)


@dataclass
class FareOption:
    fare_class: str
    price: float


@dataclass
class TrainResult:
    train_name: str
    departure_time: str
    arrival_time: str
    duration: str
    fares: list[FareOption]


def build_search_url(departure_date: str) -> str:
    """Build the URL for a one-way NYP -> CHI search on ``departure_date``.

    ``departure_date`` must be an ISO ``YYYY-MM-DD`` string. This mirrors the
    query string the amtrak.com booking form submits for a one-way,
    one-passenger search, so loading it directly exercises the same booking
    flow a customer's search would.
    """
    parsed_date = datetime.strptime(departure_date, "%Y-%m-%d")
    query = {
        "origin": ORIGIN_STATION_CODE,
        "destination": DESTINATION_STATION_CODE,
        "departDate": parsed_date.strftime("%m/%d/%Y"),
        "adults": "1",
        "children": "0",
        "tripType": "oneWay",
    }
    return f"{SEARCH_BASE_URL}?{urlencode(query)}"


def extract_embedded_fare_payload(page_html: str) -> Optional[dict[str, Any]]:
    """Return the embedded fare-search JSON payload, if the page has one.

    Returns ``None`` if no known payload pattern is found, signaling that
    callers should fall back to scraping the rendered HTML instead.
    """
    for pattern in _EMBEDDED_DATA_PATTERNS:
        match = pattern.search(page_html)
        if not match:
            continue
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
    return None


def _trains_from_payload(payload: dict[str, Any]) -> list[TrainResult]:
    """Normalize a structured fare-search payload into ``TrainResult``s."""
    trains_data = payload.get("trains") or payload.get("journeys") or []
    trains: list[TrainResult] = []
    for train in trains_data:
        fares = [
            FareOption(
                fare_class=str(fare.get("fareClass") or fare.get("type") or "Unknown"),
                price=float(fare.get("price", 0)),
            )
            for fare in train.get("fares", []) or train.get("fareOptions", [])
        ]
        trains.append(
            TrainResult(
                train_name=str(train.get("trainName") or train.get("name") or "Unknown"),
                departure_time=str(train.get("departureTime") or train.get("departure") or ""),
                arrival_time=str(train.get("arrivalTime") or train.get("arrival") or ""),
                duration=str(train.get("duration") or ""),
                fares=fares,
            )
        )
    return trains


def parse_fare_rows_from_html(page_html: str) -> list[TrainResult]:
    """Fallback: scrape fare options out of the rendered results HTML.

    This targets result rows with a ``data-testid="search-result-row"``
    attribute, each containing a train name, departure/arrival times, a
    duration, and one or more fare buckets marked with
    ``data-testid="fare-option"``. These selectors are a best-effort
    starting point based on the publicly visible page structure; if
    amtrak.com changes its markup, only this function needs to change.
    """
    soup = BeautifulSoup(page_html, "html.parser")
    trains: list[TrainResult] = []

    for row in soup.select('[data-testid="search-result-row"]'):
        train_name_el = row.select_one('[data-testid="train-name"]')
        departure_el = row.select_one('[data-testid="departure-time"]')
        arrival_el = row.select_one('[data-testid="arrival-time"]')
        duration_el = row.select_one('[data-testid="duration"]')

        fares: list[FareOption] = []
        for fare_el in row.select('[data-testid="fare-option"]'):
            fare_class_el = fare_el.select_one('[data-testid="fare-class"]')
            price_el = fare_el.select_one('[data-testid="fare-price"]')
            if fare_class_el is None or price_el is None:
                continue
            price_text = re.sub(r"[^0-9.]", "", price_el.get_text())
            if not price_text:
                continue
            fares.append(
                FareOption(fare_class=fare_class_el.get_text(strip=True), price=float(price_text))
            )

        if not fares:
            # A row with no parsable fares isn't useful in a fare finder.
            continue

        trains.append(
            TrainResult(
                train_name=train_name_el.get_text(strip=True) if train_name_el else "Unknown",
                departure_time=departure_el.get_text(strip=True) if departure_el else "",
                arrival_time=arrival_el.get_text(strip=True) if arrival_el else "",
                duration=duration_el.get_text(strip=True) if duration_el else "",
                fares=fares,
            )
        )

    return trains


def fetch_fares(departure_date: str, headless: bool = True) -> dict[str, Any]:
    """Look up NYP -> CHI fares for ``departure_date`` using a real browser.

    Tries the structured-data path first and falls back to scraping the
    rendered page if no structured payload is found.
    """
    # Imported lazily so that unit tests exercising the parsing helpers
    # above don't require Playwright/a browser to be installed.
    from playwright.sync_api import sync_playwright

    url = build_search_url(departure_date)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        try:
            page = browser.new_page()
            page.goto(url, wait_until="networkidle")
            page.wait_for_selector('[data-testid="search-result-row"]', timeout=30_000)
            page_html = page.content()
        finally:
            browser.close()

    payload = extract_embedded_fare_payload(page_html)
    trains = _trains_from_payload(payload) if payload else parse_fare_rows_from_html(page_html)

    return {
        "origin": ORIGIN_STATION_CODE,
        "destination": DESTINATION_STATION_CODE,
        "date": departure_date,
        "trains": [asdict(train) for train in trains],
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--date",
        required=True,
        help="Departure date in YYYY-MM-DD format (e.g. 2026-03-15).",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run the browser with a visible window instead of headless.",
    )
    args = parser.parse_args(argv)

    try:
        datetime.strptime(args.date, "%Y-%m-%d")
    except ValueError:
        parser.error(f"--date must be in YYYY-MM-DD format, got: {args.date}")

    result = fetch_fares(args.date, headless=not args.headed)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
