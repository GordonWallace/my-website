"""Test Amtrak's journey-solution-option endpoint from a cloud runner.

Two attempts, same JSON body:
1. a plain HTTP request with no browser or cookies
2. a request made from inside a headless-Chromium page that has loaded
   amtrak.com first (so the site's own cookies and scripts are present)
Prints status, size and a short summary of each response.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
import urllib.request

from playwright.sync_api import sync_playwright

URL = "https://www.amtrak.com/dotcom/journey-solution-option"


def body(depart: str) -> dict:
    return {
        "journeyRequest": {
            "fare": {"pricingUnit": "DOLLARS"},
            "type": "OW",
            "journeyLegRequests": [
                {
                    "origin": {"code": "NYP", "schedule": {"departureDateTime": f"{depart}T00:00:00"}},
                    "destination": {"code": "CHI"},
                    "passengers": [{"id": "P1", "type": "F", "initialType": "adult"}],
                }
            ],
            "customer": {"tierStatus": "MEMBER"},
            "isPassRider": False,
            "isCorporateTraveller": False,
            "tripTags": True,
            "singleAdultFare": True,
            "cascadesWSDOTFilter": False,
            "xDelay": "60",
        },
        "initialJourneyLegOnly": False,
        "reservableAccomodationOptions": "ALL",
    }


def summarize(status: int, text: str) -> dict:
    out = {"status": status, "bytes": len(text), "start": text[:300]}
    try:
        data = json.loads(text)
        out["json_top_keys"] = list(data)[:10] if isinstance(data, dict) else type(data).__name__
        out["train_name_hits"] = text.count("trainName") + text.count("serviceName")
    except ValueError:
        pass
    return out


def plain(depart: str) -> dict:
    req = urllib.request.Request(
        URL,
        data=json.dumps(body(depart)).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/plain, */*",
            "origin": "https://www.amtrak.com",
            "referer": "https://www.amtrak.com/tickets/departure.html",
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            return summarize(resp.status, resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as err:
        return summarize(err.code, err.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def in_browser(depart: str) -> dict:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto("https://www.amtrak.com/home", wait_until="domcontentloaded", timeout=45_000)
            page.wait_for_timeout(12_000)
            result = page.evaluate(
                """async ([url, payload]) => {
                    const r = await fetch(url, {
                        method: 'POST',
                        headers: {'content-type': 'application/json', 'accept': 'application/json, text/plain, */*'},
                        body: JSON.stringify(payload),
                    });
                    return {status: r.status, text: await r.text()};
                }""",
                [URL, body(depart)],
            )
            return summarize(result["status"], result["text"])
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"[:600]}
        finally:
            browser.close()


def main() -> None:
    depart = (date.today() + timedelta(days=30)).isoformat()
    print(json.dumps({"depart": depart, "plain_request": plain(depart), "in_browser": in_browser(depart)}, indent=2))


if __name__ == "__main__":
    main()
