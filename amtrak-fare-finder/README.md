# Amtrak Fare Finder (Proof of Concept)

This is the prototype scraper described in the
[Amtrak Fare Finder project write-up](../projects/amtrak-fare-finder.html)
and in [`../post-text/amtrak-fare-finder-poc.txt`](../post-text/amtrak-fare-finder-poc.txt).

The goal is intentionally narrow: given a single departure date, pull the
fare options Amtrak shows for a trip from **New York Penn Station (NYP)**
to **Chicago Union Station (CHI)**.

## Approach

1. **Prefer structured data.** Amtrak's booking search page is a
   client-rendered app, so the fare table is populated from a data payload
   the page fetches after load. `fetch_fares()` loads the search results
   page in a real (headless) browser and first looks for that embedded
   JSON payload (`extract_embedded_fare_payload`). When it's present, the
   scraper reads fares directly from it instead of the HTML.
2. **Fall back to scraping the rendered page.** If no structured payload
   can be found, `parse_fare_rows_from_html()` parses the rendered result
   rows from the DOM and normalizes them into the same shape, so callers
   don't need to know which path was used.
3. **Report what it found.** The script prints one JSON document per run:
   the requested trip, the date, and a list of trains with their fare
   buckets (e.g. Value, Flexible, Business) and prices.

Because amtrak.com renders its search results with JavaScript and changes
its markup over time, the CSS selectors in `parse_fare_rows_from_html()`
are a best-effort starting point based on the publicly visible page
structure. If Amtrak changes their markup, only that function needs to be
updated — everything else (URL building, JSON-payload extraction, output
shape) is unaffected.

## Usage

### Command line

```bash
pip install -r requirements.txt
playwright install chromium
python fare_finder.py --date 2026-03-15
```

This prints a JSON object like:

### Web interface

A small Flask app (`app.py`) wraps `fetch_fares()` with a JSON API and a
static HTML page, so the fare finder can be used from a browser instead of
the command line:

```bash
pip install -r requirements.txt
playwright install chromium
python app.py
```

Then open <http://127.0.0.1:5000/> and pick a departure date. The page
calls `GET /api/fares?date=YYYY-MM-DD`, which runs the same scraper as the
CLI and returns the JSON document described below (or a `400`/`502` error
with an `"error"` message if the date is invalid or the lookup fails).

This runs locally; it is not hosted as part of the static site.

```json
{
  "origin": "NYP",
  "destination": "CHI",
  "date": "2026-03-15",
  "trains": [
    {
      "train_name": "Lake Shore Limited",
      "departure_time": "3:40 PM",
      "arrival_time": "9:45 AM",
      "duration": "18h 05m",
      "fares": [
        {"fare_class": "Value", "price": 89.0},
        {"fare_class": "Flexible", "price": 129.0}
      ]
    }
  ]
}
```

## Scope and limitations

This is a proof of concept, not a production tool. It only supports:

- One route: New York Penn Station to Chicago Union Station.
- One passenger, one departure date, no return trip.
- Reading fares as currently displayed; it does not book, hold, or
  otherwise interact with checkout.

Future work (not part of this prototype) would generalize the station
codes, dates, and passenger counts, add retry/error handling for
transient failures, and add monitoring for markup changes upstream.

## Tests

The HTML-parsing fallback can be exercised offline with the bundled
fixture:

```bash
python -m unittest discover -s tests
```
