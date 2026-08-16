from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from fastapi.responses import JSONResponse

import main


class QueueMessageFallbackTests(unittest.TestCase):
    def test_delivery_failure_lands_in_outbox_instead_of_raising(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            outbox = Path(temporary) / "outbox.jsonl"
            with (
                mock.patch.object(main, "OUTBOX_FILE", outbox),
                mock.patch.object(main, "is_port_listening", return_value=True),
                mock.patch.object(main, "read_api_server_key", return_value="test-key"),
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=urllib.error.URLError("connection refused"),
                ),
            ):
                result = main.queue_message(
                    main.MessageRequest(agent_id="default", message="hello outbox")
                )
            records = [
                json.loads(line)
                for line in outbox.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

        self.assertNotIsInstance(result, JSONResponse)
        self.assertIsInstance(result, dict)
        self.assertTrue(result["ok"])
        self.assertFalse(result["delivered"])
        self.assertTrue(result["queued"])
        self.assertEqual(result["channel"], "outbox")
        self.assertEqual(result["fallback_reason"], "api_request_failed")

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["agent_id"], "default")
        self.assertEqual(records[0]["message"], "hello outbox")
        self.assertEqual(records[0]["fallback_reason"], "api_request_failed")


if __name__ == "__main__":
    unittest.main()
