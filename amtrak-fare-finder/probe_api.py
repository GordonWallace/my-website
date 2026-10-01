"""Test Amtrak's journey-solution-option endpoint from a cloud runner.

Two attempts, same JSON body:
1. a plain HTTP request with no browser or cookies
2. a request made from inside a headless-Chromium page that has loaded
   amtrak.com first (so the site's own cookies and scripts are present)
Prints status, size and a short summary of each response.
"""

from __future__ import annotations

import json
import random
import time
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
    out = {"status": status, "bytes": len(text), "start": text[:200]}
    try:
        data = json.loads(text)
        out["json_top_keys"] = list(data)[:10] if isinstance(data, dict) else type(data).__name__
        legs = (((data.get("data") or {}).get("journeySolutionOption") or {}).get("journeyLegs") or [{}])[0].get("journeyLegOptions") or []
        out["train_options"] = len(legs)
        out["first_option"] = json.dumps(legs[0])[:600] if legs else None
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


def abck_state(context) -> str:
    for cookie in context.cookies():
        if cookie["name"] == "_abck":
            value = cookie["value"]
            if "~0~" in value:
                return "cleared"
            if "~-1~" in value:
                return "not-cleared"
            return "unknown"
    return "absent"


def in_browser(depart: str) -> dict:
    """Warm up a browser that looks less automated, then call the endpoint."""
    log = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        try:
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                locale="en-US",
                timezone_id="America/New_York",
                viewport={"width": 1440, "height": 900},
            )
            context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page = context.new_page()
            page.goto("https://www.amtrak.com/home.html", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(3_000)
            for x, y in ((420, 330), (700, 480), (980, 300), (640, 620)):
                page.mouse.move(x, y, steps=12)
                page.wait_for_timeout(250)
            page.mouse.wheel(0, 500)
            page.wait_for_timeout(600)
            page.goto("https://www.amtrak.com/tickets/departure.html", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(4_000)
            for attempt in range(8):
                state = abck_state(context)
                log.append(state)
                if state == "cleared":
                    break
                page.wait_for_timeout(3_000)
                page.mouse.move(500 + attempt * 40, 400, steps=8)
            attempts = []
            for _ in range(3):
                result = page.evaluate(
                    """async ([url, payload, trace]) => {
                        const ctl = new AbortController();
                        setTimeout(() => ctl.abort(), 45000);
                        try {
                            const r = await fetch(url, {
                                method: 'POST', signal: ctl.signal,
                                headers: {'content-type': 'application/json', 'accept': 'application/json, text/plain, */*', 'x-amtrak-trace-id': trace},
                                body: JSON.stringify(payload),
                            });
                            return {status: r.status, text: await r.text()};
                        } catch (e) { return {status: 0, text: String(e)}; }
                    }""",
                    ["/dotcom/journey-solution-option", body(depart), "%032x%d0" % (random.getrandbits(128), int(time.time() * 1000))],
                )
                attempts.append(summarize(result["status"], result["text"]))
                if result["status"] == 200:
                    break
                page.wait_for_timeout(4_000)
            return {"abck_log": log, "final_abck": abck_state(context), "attempts": attempts}
        except Exception as exc:  # noqa: BLE001
            return {"abck_log": log, "error": f"{type(exc).__name__}: {exc}"[:600]}
        finally:
            browser.close()


def main() -> None:
    depart = (date.today() + timedelta(days=30)).isoformat()
    print(json.dumps({"depart": depart, "in_browser": in_browser(depart)}, indent=2))


if __name__ == "__main__":
    main()
