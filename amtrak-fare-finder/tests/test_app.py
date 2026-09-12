import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402


SAMPLE_RESULT = {
    "origin": "NYP",
    "destination": "CHI",
    "date": "2026-03-15",
    "trains": [
        {
            "train_name": "Lake Shore Limited",
            "departure_time": "3:40 PM",
            "arrival_time": "9:45 AM",
            "duration": "18h 05m",
            "fares": [{"fare_class": "Value", "price": 89.0}],
        }
    ],
}


class ApiFaresTests(unittest.TestCase):
    def setUp(self):
        app.testing = True
        self.client = app.test_client()

    def test_rejects_missing_date(self):
        response = self.client.get("/api/fares")
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

    def test_rejects_malformed_date(self):
        response = self.client.get("/api/fares?date=not-a-date")
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

    @patch("app.fetch_fares", return_value=SAMPLE_RESULT)
    def test_returns_fares_for_valid_date(self, mock_fetch_fares):
        response = self.client.get("/api/fares?date=2026-03-15")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), SAMPLE_RESULT)
        mock_fetch_fares.assert_called_once_with("2026-03-15")

    @patch("app.fetch_fares", side_effect=RuntimeError("boom"))
    def test_returns_502_when_scraper_fails(self, mock_fetch_fares):
        response = self.client.get("/api/fares?date=2026-03-15")
        self.assertEqual(response.status_code, 502)
        self.assertIn("error", response.get_json())


class IndexPageTests(unittest.TestCase):
    def setUp(self):
        app.testing = True
        self.client = app.test_client()

    def test_serves_html_form(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"<form", response.data)


if __name__ == "__main__":
    unittest.main()
