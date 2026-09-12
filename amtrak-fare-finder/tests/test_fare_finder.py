import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fare_finder import (  # noqa: E402
    build_search_url,
    extract_embedded_fare_payload,
    parse_fare_rows_from_html,
)

FIXTURES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


class BuildSearchUrlTests(unittest.TestCase):
    def test_includes_expected_query_params(self):
        url = build_search_url("2026-03-15")
        self.assertIn("origin=NYP", url)
        self.assertIn("destination=CHI", url)
        self.assertIn("departDate=03%2F15%2F2026", url)
        self.assertIn("tripType=oneWay", url)

    def test_rejects_malformed_date(self):
        with self.assertRaises(ValueError):
            build_search_url("not-a-date")


class ExtractEmbeddedFarePayloadTests(unittest.TestCase):
    def test_finds_initial_state_payload(self):
        html = """
        <html><body><script>
        window.__INITIAL_STATE__ = {"trains": [{"name": "Test Train"}]};
        </script></body></html>
        """
        payload = extract_embedded_fare_payload(html)
        self.assertEqual(payload, {"trains": [{"name": "Test Train"}]})

    def test_returns_none_when_absent(self):
        html = "<html><body><p>No embedded data here.</p></body></html>"
        self.assertIsNone(extract_embedded_fare_payload(html))

    def test_returns_none_on_malformed_json(self):
        html = "<script>window.__INITIAL_STATE__ = {not valid json};</script>"
        self.assertIsNone(extract_embedded_fare_payload(html))


class ParseFareRowsFromHtmlTests(unittest.TestCase):
    def setUp(self):
        fixture_path = os.path.join(FIXTURES_DIR, "sample_results.html")
        with open(fixture_path, "r", encoding="utf-8") as fixture_file:
            self.html = fixture_file.read()

    def test_parses_trains_with_fares(self):
        trains = parse_fare_rows_from_html(self.html)
        self.assertEqual(len(trains), 2)

        lake_shore = trains[0]
        self.assertEqual(lake_shore.train_name, "Lake Shore Limited")
        self.assertEqual(lake_shore.departure_time, "3:40 PM")
        self.assertEqual(lake_shore.arrival_time, "9:45 AM")
        self.assertEqual(lake_shore.duration, "18h 05m")
        self.assertEqual(len(lake_shore.fares), 2)
        self.assertEqual(lake_shore.fares[0].fare_class, "Value")
        self.assertEqual(lake_shore.fares[0].price, 89.0)
        self.assertEqual(lake_shore.fares[1].fare_class, "Flexible")
        self.assertEqual(lake_shore.fares[1].price, 129.0)

    def test_skips_rows_without_fares(self):
        trains = parse_fare_rows_from_html(self.html)
        train_names = [train.train_name for train in trains]
        self.assertNotIn("Sold Out Train", train_names)

    def test_returns_empty_list_for_no_results(self):
        self.assertEqual(parse_fare_rows_from_html("<html></html>"), [])


if __name__ == "__main__":
    unittest.main()
