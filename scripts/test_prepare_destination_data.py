#!/usr/bin/env python3

import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("prepare-destination-data.py")
SPEC = importlib.util.spec_from_file_location("prepare_destination_data", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrepareDestinationDataTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.csv_path = self.root / "analysis_dataset.csv"
        self.manifest_path = self.root / "manifest.json"
        self.output_path = self.root / "destinations.json"

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self, rows):
        with self.csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(MODULE.HEADERS.values()))
            writer.writeheader()
            for values in rows:
                row = {
                    "payment": "P1", "buyer": "private-1", "region_code": "R1",
                    "region_name": "서울", "date": "2025-09-17", "address": "주소",
                    "detail": "상세", "x": "1", "y": "2", "driver": "기사", "boxes": "1",
                }
                row.update(values)
                writer.writerow({MODULE.HEADERS[key]: value for key, value in row.items()})
        digest = hashlib.sha256(self.csv_path.read_bytes()).hexdigest()
        self.manifest_path.write_text(json.dumps({
            "schemaVersion": 1,
            "defaultDate": "2026-09-16",
            "dates": [
                {"date": "2026-09-16", "sourceDate": "2025-09-17"},
                {"date": "2026-09-17", "sourceDate": "2025-09-18"},
            ],
            "source": {
                "csvSha256": digest,
                "dateShift": {"sourceDate": "2025-09-17", "operatingDate": "2026-09-16", "offsetDays": 364},
            },
        }), encoding="utf-8")

    def test_preserves_duplicate_box_sum_and_exact_destination_and_order_keys(self):
        self.write_source([
            {},
            {"boxes": "2"},
            {"payment": "P2", "boxes": "3", "region_name": "경기"},
            {"buyer": "private-2", "boxes": "4"},
            {"date": "2025-09-18", "payment": "P3", "boxes": "5"},
        ])
        result = MODULE.prepare(self.csv_path, self.manifest_path, self.output_path)
        catalog = json.loads(self.output_path.read_text(encoding="utf-8"))

        self.assertEqual(result["rows"], 5)
        self.assertEqual(result["destinations"], 2)
        self.assertEqual(len(catalog["destinations"]), 2)
        first = next(item for item in catalog["destinations"] if len(item["dates"]) == 2)
        self.assertEqual(first["dates"], [
            {"date": "2026-09-16", "regionNames": ["경기", "서울"], "orderCount": 2, "boxCount": 6},
            {"date": "2026-09-17", "regionNames": ["서울"], "orderCount": 1, "boxCount": 5},
        ])
        self.assertNotIn("private-1", self.output_path.read_text(encoding="utf-8"))
        self.assertNotIn("private-2", self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(catalog["source"]["dateShift"]["offsetDays"], 364)

    def test_hash_mismatch_and_bad_boxes_leave_existing_catalog_unchanged(self):
        self.write_source([{}])
        self.output_path.write_text('{"old":true}', encoding="utf-8")
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["source"]["csvSha256"] = "wrong"
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source hash"):
            MODULE.prepare(self.csv_path, self.manifest_path, self.output_path)
        self.assertEqual(self.output_path.read_text(encoding="utf-8"), '{"old":true}')

        self.write_source([{"boxes": "nan"}])
        with self.assertRaisesRegex(ValueError, "finite and nonnegative"):
            MODULE.prepare(self.csv_path, self.manifest_path, self.output_path)
        self.assertEqual(self.output_path.read_text(encoding="utf-8"), '{"old":true}')
        self.assertFalse(any(self.root.glob(".destination-data-*")))
        self.assertFalse(any(self.root.glob(".destinations.json-*")))

    def test_date_absent_from_manifest_fails_without_replacing_catalog(self):
        self.write_source([{"date": "2025-09-19"}])
        self.output_path.write_text('{"old":true}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "absent from manifest"):
            MODULE.prepare(self.csv_path, self.manifest_path, self.output_path)
        self.assertEqual(self.output_path.read_text(encoding="utf-8"), '{"old":true}')


if __name__ == "__main__":
    unittest.main()
