"""Web interface for the Amtrak Fare Finder proof of concept.

Exposes a small Flask application with:

- ``GET /`` - a static HTML page with a form for choosing a departure date
  and a results table populated via JavaScript.
- ``GET /api/fares?date=YYYY-MM-DD`` - a JSON API that runs ``fetch_fares``
  from :mod:`fare_finder` and returns the same document the CLI prints.

Run it locally with:

.. code-block:: bash

    pip install -r requirements.txt
    playwright install chromium
    python app.py

Then open http://127.0.0.1:5000/ in a browser.
"""

from __future__ import annotations

from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory

from fare_finder import fetch_fares

app = Flask(__name__, static_folder="static", static_url_path="")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/fares")
def api_fares():
    date = request.args.get("date", "")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "date must be in YYYY-MM-DD format"}), 400

    try:
        result = fetch_fares(date)
    except Exception as error:  # noqa: BLE001 - surface scraper failures as a 502
        return jsonify({"error": f"Failed to fetch fares: {error}"}), 502

    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=True)
