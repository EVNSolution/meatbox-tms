#!/usr/bin/env python3

import csv
from datetime import date as calendar_date
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from pyproj import CRS, Transformer
import shapefile


SCRIPT = Path(__file__).with_name("prepare-dispatch-data.py")
SPEC = importlib.util.spec_from_file_location("prepare_dispatch_data", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrepareDispatchDataTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        base = self.source / "MP_ADM_KMEANS"
        writer = shapefile.Writer(str(base), shapeType=shapefile.POLYGON, encoding="utf-8")
        for name in ("BASE_DATE", "ADM_CD", "ADM_NM", "ZONE_ID", "QUALITY"):
            writer.field(name, "C", size=80)
        # Clockwise shell and counter-clockwise hole in EPSG:5186.
        shell = [(199000, 549000), (199000, 551000), (201000, 551000), (201000, 549000), (199000, 549000)]
        hole = [(199800, 549800), (200200, 549800), (200200, 550200), (199800, 550200), (199800, 549800)]
        writer.poly([shell, hole])
        writer.record("20250630", "A1", "테스트동", "zone-1", "GOOD")
        writer.close()
        base.with_suffix(".cpg").write_text("UTF-8", encoding="ascii")
        base.with_suffix(".prj").write_text(CRS.from_epsg(5186).to_wkt(), encoding="utf-8")
        self.to_csv = Transformer.from_crs(5186, 5179, always_xy=True)

    def tearDown(self):
        self.temp.cleanup()

    def write_csv(self, quantities=(1, 2), point=(199500, 550000), dates=None):
        x, y = self.to_csv.transform(*point)
        fields = list(MODULE.HEADERS.values())
        dates = dates or ["2025-09-12"] * len(quantities)
        with (self.source / "analysis_dataset.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            for quantity, date in zip(quantities, dates, strict=True):
                writer.writerow({
                    MODULE.HEADERS["payment"]: "P1",
                    MODULE.HEADERS["buyer"]: "secret-buyer",
                    MODULE.HEADERS["region_code"]: "csv-code",
                    MODULE.HEADERS["region_name"]: "CSV 권역",
                    MODULE.HEADERS["date"]: date,
                    MODULE.HEADERS["weekday"]: MODULE.WEEKDAYS[calendar_date.fromisoformat(date).weekday()],
                    MODULE.HEADERS["address"]: "주소",
                    MODULE.HEADERS["detail"]: "상세",
                    MODULE.HEADERS["x"]: str(x),
                    MODULE.HEADERS["y"]: str(y),
                    MODULE.HEADERS["driver"]: "(A)기사",
                    MODULE.HEADERS["boxes"]: str(quantity),
                })

    def test_preserves_duplicates_holes_and_stable_order(self):
        self.write_csv()
        output = self.root / "out"
        manifest = MODULE.prepare(self.source, output, "2025-09-12", "EPSG:5179", False)
        day = json.loads((output / "days/2025-09-12.json").read_text())
        regions = json.loads((output / "regions.geojson").read_text())
        self.assertEqual(manifest["totals"], {"rows": 2, "boxes": 3, "dates": 1})
        self.assertEqual(day["summary"]["orders"], 1)
        self.assertEqual(day["orders"][0]["sourceRows"], 2)
        self.assertEqual(day["orders"][0]["boxes"], 3)
        self.assertEqual(day["orders"][0]["sequence"], 1)
        self.assertEqual(day["orders"][0]["zoneIds"], ["zone-1"])
        self.assertNotIn("secret-buyer", json.dumps(day, ensure_ascii=False))
        self.assertEqual(len(regions["features"][0]["geometry"]["coordinates"]), 2)
        with gzip.open(output / "manifest.json.gz", "rt", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), json.loads((output / "manifest.json").read_text()))
        with self.assertRaises(FileExistsError):
            MODULE.prepare(self.source, output, "2025-09-12", "EPSG:5179", False)
        MODULE.prepare(self.source, output, "2025-09-12", "EPSG:5179", True)
        self.assertFalse(any(output.parent.glob(".out.backup-*")))

    def test_zero_is_valid_and_nonfinite_fails_without_output(self):
        self.write_csv((0,))
        MODULE.prepare(self.source, self.root / "zero", "2025-09-12", "EPSG:5179", False)
        self.write_csv(("nan",))
        with self.assertRaisesRegex(ValueError, "finite and nonnegative"):
            MODULE.prepare(self.source, self.root / "bad", "2025-09-12", "EPSG:5179", False)
        self.assertFalse((self.root / "bad").exists())

    def test_noncontiguous_dates_keep_each_dates_source_order(self):
        self.write_csv((1, 5, 2), dates=("2025-09-12", "2025-09-13", "2025-09-12"))
        output = self.root / "dates"
        manifest = MODULE.prepare(self.source, output, "2025-09-12", "EPSG:5179", False)
        first = json.loads((output / "days/2025-09-12.json").read_text())
        self.assertEqual([item["date"] for item in manifest["dates"]], ["2025-09-12", "2025-09-13"])
        self.assertEqual(first["summary"]["sourceRows"], 2)
        self.assertEqual(first["orders"][0]["boxes"], 3)
        self.assertEqual(first["orders"][0]["sequence"], 1)

    def test_invalid_date_and_unbounded_coordinates_fail(self):
        self.write_csv((1,))
        path = self.source / "analysis_dataset.csv"
        text = path.read_text(encoding="utf-8-sig").replace("2025-09-12", "2025-09-31")
        path.write_text(text, encoding="utf-8-sig")
        with self.assertRaisesRegex(ValueError, "invalid ISO date"):
            MODULE.prepare(self.source, self.root / "bad-date", "2025-09-12", "EPSG:5179", False)

        self.write_csv((1,))
        text = path.read_text(encoding="utf-8-sig").replace(str(self.to_csv.transform(199500, 550000)[0]), "1e100")
        path.write_text(text, encoding="utf-8-sig")
        with self.assertRaisesRegex(ValueError, "coordinate transformation was not finite"):
            MODULE.prepare(self.source, self.root / "bad-coordinate", "2025-09-12", "EPSG:5179", False)

    def test_shifts_every_date_by_one_week_aligned_offset_without_changing_orders(self):
        self.write_csv((3, 5), dates=("2025-09-17", "2025-09-18"))
        original_output = self.root / "original"
        shifted_output = self.root / "shifted"
        original = MODULE.prepare(self.source, original_output, "2025-09-17", "EPSG:5179", False)
        shifted = MODULE.prepare(
            self.source, shifted_output, "2026-09-16", "EPSG:5179", False,
            "2025-09-17", "2026-09-16",
        )
        original_day = json.loads((original_output / "days/2025-09-17.json").read_text())
        shifted_day = json.loads((shifted_output / "days/2026-09-16.json").read_text())

        self.assertEqual([item["date"] for item in shifted["dates"]], ["2026-09-16", "2026-09-17"])
        self.assertEqual([item["sourceDate"] for item in shifted["dates"]], ["2025-09-17", "2025-09-18"])
        self.assertEqual([item["weekday"] for item in shifted["dates"]], ["수요일", "목요일"])
        self.assertEqual(shifted["source"]["dateShift"], {
            "sourceDate": "2025-09-17", "operatingDate": "2026-09-16", "offsetDays": 364,
        })
        self.assertEqual(shifted_day["date"], "2026-09-16")
        self.assertEqual(shifted_day["sourceDate"], "2025-09-17")
        self.assertEqual(shifted_day["weekday"], original_day["weekday"])
        self.assertEqual(shifted_day["summary"], original_day["summary"])
        self.assertEqual(shifted_day["groups"], original_day["groups"])
        self.assertEqual(shifted_day["orders"], original_day["orders"])
        self.assertEqual(shifted["totals"], original["totals"])
        self.assertNotIn("sourceDate", original_day)
        self.assertNotIn("dateShift", original["source"])

    def test_date_shift_requires_complete_same_weekday_anchor_present_in_source(self):
        self.write_csv((1,), dates=("2025-09-17",))
        cases = [
            (("2025-09-17", None), "provided together"),
            (("2025-09-17", "2026-09-17"), "same weekday"),
            (("2025-09-18", "2026-09-17"), "absent from source"),
        ]
        for index, ((source_date, operating_date), message) in enumerate(cases):
            with self.subTest(source_date=source_date, operating_date=operating_date):
                with self.assertRaisesRegex(ValueError, message):
                    MODULE.prepare(
                        self.source, self.root / f"bad-shift-{index}", "2026-09-16",
                        "EPSG:5179", False, source_date, operating_date,
                    )


if __name__ == "__main__":
    unittest.main()
