#!/usr/bin/env python3
"""Prepare immutable CSV/SHP inputs as date-addressable dispatch JSON."""

from __future__ import annotations

import argparse
import csv
from datetime import date as calendar_date, timedelta
from decimal import Decimal, InvalidOperation
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from tempfile import mkdtemp

import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import Point, mapping, shape
from shapely.ops import transform
from shapely.strtree import STRtree


CSV_NAME = "analysis_dataset.csv"
SHP_NAME = "MP_ADM_KMEANS"
HEADERS = {
    "payment": "결제번호",
    "buyer": "구매자 회원 번호",
    "region_code": "권역코드",
    "region_name": "권역명",
    "date": "배송완료일자",
    "weekday": "요일",
    "address": "주소",
    "detail": "상세주소",
    "x": "x",
    "y": "y",
    "driver": "배송기사 성명",
    "boxes": "수량 (박스수-취소박스수), 일반: distbox.BOX_CNT-CANCEL_BOX_CNT / 묶음: bundle_box_item.CNT-CANCEL_CNT",
}
WEEKDAYS = ("월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일")


def stable_id(prefix: str, parts: tuple[str, ...], length: int = 16) -> str:
    raw = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()
    return prefix + hashlib.sha256(raw).hexdigest()[:length]


def json_number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def parse_boxes(raw: str, row_number: int) -> Decimal:
    text = raw.strip()
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"row {row_number}: invalid box quantity {raw!r}") from exc
    if not text or not value.is_finite() or value < 0:
        raise ValueError(f"row {row_number}: box quantity must be finite and nonnegative")
    return value


def validate_date(date_text: str, weekday: str, row_number: int) -> None:
    try:
        parsed = calendar_date.fromisoformat(date_text)
    except ValueError as exc:
        raise ValueError(f"row {row_number}: invalid ISO date {date_text!r}") from exc
    if parsed.isoformat() != date_text:
        raise ValueError(f"row {row_number}: date must use YYYY-MM-DD")
    expected = WEEKDAYS[parsed.weekday()]
    if weekday != expected:
        raise ValueError(f"row {row_number}: {date_text} must be labeled {expected}, found {weekday!r}")


def round_coordinates(value):
    if isinstance(value, (list, tuple)):
        return [round_coordinates(item) for item in value]
    return round(value, 7)


def write_json_pair(path: Path, payload: dict) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path.write_bytes(encoded)
    with path.with_suffix(path.suffix + ".gz").open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as zipped:
            zipped.write(encoded)


def read_regions(source: Path):
    cpg = (source / f"{SHP_NAME}.cpg").read_bytes()
    if cpg.strip().upper().replace(b"-", b"") != b"UTF8":
        raise ValueError(f"SHP encoding must be UTF-8, found {cpg!r}")
    region_crs = CRS.from_wkt((source / f"{SHP_NAME}.prj").read_text(encoding="utf-8"))
    if region_crs.to_epsg() != 5186:
        raise ValueError(f"unexpected region CRS: {region_crs.to_string()}")

    reader = shapefile.Reader(
        str(source / SHP_NAME), encoding="utf-8", encodingErrors="strict"
    )
    to_wgs84 = Transformer.from_crs(region_crs, 4326, always_xy=True)
    geometries = []
    features = []
    qualities: dict[str, int] = {}
    invalid_count = 0
    base_dates = set()
    zone_ids = []
    for shape_record in reader.iterShapeRecords():
        record = shape_record.record.as_dict()
        geometry = shape(shape_record.shape.__geo_interface__)
        geometries.append(geometry)
        zone_id = str(record["ZONE_ID"])
        zone_ids.append(zone_id)
        quality = str(record["QUALITY"])
        qualities[quality] = qualities.get(quality, 0) + 1
        invalid_count += int(not geometry.is_valid)
        base_dates.add(str(record["BASE_DATE"]))
        projected = transform(to_wgs84.transform, geometry)
        geojson = mapping(projected)
        geojson["coordinates"] = round_coordinates(geojson["coordinates"])
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "zoneId": zone_id,
                    "label": str(record["ADM_NM"]),
                    "quality": quality,
                    "baseDate": str(record["BASE_DATE"]),
                    "admCode": str(record["ADM_CD"]),
                },
                "geometry": geojson,
            }
        )
    if len(base_dates) != 1:
        raise ValueError(f"expected one SHP base date, found {sorted(base_dates)}")
    return (
        {"type": "FeatureCollection", "features": features},
        geometries,
        zone_ids,
        {
            "features": len(features),
            "qualityCounts": dict(sorted(qualities.items())),
            "invalidCount": invalid_count,
            "baseDate": next(iter(base_dates)),
            "crs": region_crs,
        },
    )


def new_day(date: str, weekday: str, source_date: str | None = None) -> dict:
    day = {
        "date": date,
        "weekday": weekday,
        "rows": 0,
        "boxes": Decimal(0),
        "orders": {},
        "payments": set(),
        "sites": set(),
        "groups": {},
    }
    if source_date is not None:
        day["sourceDate"] = source_date
    return day


def finish_day(day: dict, days_dir: Path, zone_lookup) -> dict:
    orders = []
    mapped = uncovered = multi = 0
    for order in day["orders"].values():
        coordinates = order.pop("_coordinates")
        zone_ids = zone_lookup(order.pop("_source_xy")) if coordinates else []
        order["boxes"] = json_number(order["boxes"])
        order["coordinates"] = coordinates
        order["zoneIds"] = zone_ids
        mapped += int(coordinates is not None)
        uncovered += int(coordinates is not None and not zone_ids)
        multi += int(len(zone_ids) > 1)
        orders.append(order)
    groups = []
    for group in day["groups"].values():
        group["regionNames"] = list(group["regionNames"])
        groups.append(group)
    summary = {
        "sourceRows": day["rows"],
        "boxes": json_number(day["boxes"]),
        "orders": len(orders),
        "payments": len(day["payments"]),
        "sites": len(day["sites"]),
        "groups": len(groups),
        "mappedOrders": mapped,
        "unmappedOrders": len(orders) - mapped,
        "uncoveredOrders": uncovered,
        "multiZoneOrders": multi,
    }
    payload = {
        "schemaVersion": 1,
        "date": day["date"],
        "weekday": day["weekday"],
        "summary": summary,
        "groups": groups,
        "orders": orders,
    }
    if "sourceDate" in day:
        payload["sourceDate"] = day["sourceDate"]
    write_json_pair(days_dir / f"{day['date']}.json", payload)
    result = {"date": day["date"], "weekday": day["weekday"], "summary": summary}
    if "sourceDate" in day:
        result["sourceDate"] = day["sourceDate"]
    return result


def prepare(
    source: Path,
    output: Path,
    default_date: str,
    csv_crs_name: str,
    replace: bool,
    source_date: str | None = None,
    operating_date: str | None = None,
) -> dict:
    try:
        parsed_default = calendar_date.fromisoformat(default_date)
    except ValueError as exc:
        raise ValueError(f"invalid default ISO date {default_date!r}") from exc
    if parsed_default.isoformat() != default_date:
        raise ValueError("default date must use YYYY-MM-DD")
    if (source_date is None) != (operating_date is None):
        raise ValueError("source date and operating date must be provided together")
    date_offset = None
    if source_date is not None:
        try:
            parsed_source = calendar_date.fromisoformat(source_date)
            parsed_operating = calendar_date.fromisoformat(operating_date)
        except ValueError as exc:
            raise ValueError("source date and operating date must use valid YYYY-MM-DD dates") from exc
        if parsed_source.isoformat() != source_date or parsed_operating.isoformat() != operating_date:
            raise ValueError("source date and operating date must use YYYY-MM-DD")
        date_offset = parsed_operating - parsed_source
        if date_offset.days % 7:
            raise ValueError("source date and operating date must use the same weekday")
    if output.exists() and not replace:
        raise FileExistsError(f"output already exists: {output}; pass --replace to replace it")
    csv_path = source / CSV_NAME
    if not csv_path.is_file():
        raise FileNotFoundError(csv_path)

    regions, region_geometries, zone_ids, region_stats = read_regions(source)
    csv_crs = CRS.from_user_input(csv_crs_name)
    if csv_crs.to_epsg() != 5179:
        raise ValueError(f"unexpected CSV CRS: {csv_crs.to_string()}")
    to_wgs84 = Transformer.from_crs(csv_crs, 4326, always_xy=True)
    to_region = Transformer.from_crs(csv_crs, region_stats["crs"], always_xy=True)
    tree = STRtree(region_geometries)
    coordinate_cache: dict[tuple[str, str], tuple[list[float], list[str]]] = {}

    def coordinates(raw_x: str, raw_y: str, row_number: int):
        x_text, y_text = raw_x.strip(), raw_y.strip()
        if not x_text and not y_text:
            return None, None
        if not x_text or not y_text:
            raise ValueError(f"row {row_number}: x and y must both be present")
        key = (x_text, y_text)
        if key not in coordinate_cache:
            try:
                x, y = float(x_text), float(y_text)
            except ValueError as exc:
                raise ValueError(f"row {row_number}: invalid coordinates {key}") from exc
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError(f"row {row_number}: coordinates must be finite")
            lng, lat = to_wgs84.transform(x, y)
            rx, ry = to_region.transform(x, y)
            if not all(math.isfinite(value) for value in (lng, lat, rx, ry)):
                raise ValueError(f"row {row_number}: coordinate transformation was not finite")
            if not (124 <= lng <= 132 and 32 <= lat <= 40):
                raise ValueError(f"row {row_number}: transformed coordinate is outside Korea")
            point = Point(rx, ry)
            matches = [int(index) for index in tree.query(point) if region_geometries[int(index)].covers(point)]
            coordinate_cache[key] = ([round(lng, 7), round(lat, 7)], sorted(zone_ids[index] for index in matches))
        return coordinate_cache[key][0], key

    def zones(source_xy):
        return coordinate_cache[source_xy][1]

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    backup = output.parent / f".{output.name}.backup-{os.getpid()}"
    try:
        days_dir = staging / "days"
        days_dir.mkdir()
        write_json_pair(staging / "regions.geojson", regions)
        database_path = staging / "source.sqlite"
        database = sqlite3.connect(database_path)
        database.execute("PRAGMA journal_mode=OFF")
        database.execute("PRAGMA synchronous=OFF")
        database.execute("PRAGMA temp_store=MEMORY")
        database.execute(
            """CREATE TABLE source_rows (
                seq INTEGER PRIMARY KEY, date TEXT, source_date TEXT, weekday TEXT, payment TEXT,
                buyer TEXT, region_code TEXT, region_name TEXT, address TEXT,
                detail TEXT, x TEXT, y TEXT, driver TEXT, boxes TEXT
            )"""
        )
        total_rows = 0
        total_boxes = Decimal(0)
        weekdays = {}
        source_dates = set()
        batch = []
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            missing = [name for name in HEADERS.values() if name not in (reader.fieldnames or [])]
            if missing:
                raise ValueError(f"missing CSV columns: {missing}")
            for row_number, row in enumerate(reader, start=2):
                source_row_date = row[HEADERS["date"]].strip()
                weekday = row[HEADERS["weekday"]].strip()
                validate_date(source_row_date, weekday, row_number)
                source_dates.add(source_row_date)
                date = (calendar_date.fromisoformat(source_row_date) + date_offset).isoformat() if source_date is not None else source_row_date
                if date in weekdays and (weekday, source_row_date) != weekdays[date]:
                    raise ValueError(f"row {row_number}: conflicting weekday for {date}")
                weekdays[date] = (weekday, source_row_date)
                boxes = parse_boxes(row[HEADERS["boxes"]], row_number)
                batch.append(
                    (
                        row_number, date, source_row_date, weekday,
                        row[HEADERS["payment"]], row[HEADERS["buyer"]],
                        row[HEADERS["region_code"]], row[HEADERS["region_name"]],
                        row[HEADERS["address"]], row[HEADERS["detail"]],
                        row[HEADERS["x"]], row[HEADERS["y"]],
                        row[HEADERS["driver"]], str(boxes),
                    )
                )
                if len(batch) == 5000:
                    database.executemany("INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
                    batch.clear()
                total_rows += 1
                total_boxes += boxes
        if batch:
            database.executemany("INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
        database.commit()
        database.execute("CREATE INDEX source_rows_date_seq ON source_rows(date, seq)")
        if source_date is not None and source_date not in source_dates:
            raise ValueError(f"source date {source_date} is absent from source")

        date_summaries = []
        for date in sorted(weekdays):
            weekday, original_date = weekdays[date]
            current = new_day(date, weekday, original_date if source_date is not None else None)
            rows = database.execute(
                """SELECT seq, source_date, payment, buyer, region_code, region_name, address,
                          detail, x, y, driver, boxes
                   FROM source_rows WHERE date = ? ORDER BY seq""",
                (date,),
            )
            for row_number, original_date, payment, buyer, region_code, region_name, address, detail, raw_x, raw_y, driver, boxes in rows:
                boxes = Decimal(boxes)
                coords, source_xy = coordinates(raw_x, raw_y, row_number)
                key = (original_date, payment, buyer, address, detail, driver, raw_x, raw_y, region_code)
                group_id = stable_id("grp_", (driver,), 12)
                if group_id not in current["groups"]:
                    current["groups"][group_id] = {
                        "id": group_id,
                        "label": driver or "기사 미등록",
                        "regionNames": [],
                    }
                if region_name and region_name not in current["groups"][group_id]["regionNames"]:
                    current["groups"][group_id]["regionNames"].append(region_name)
                if key not in current["orders"]:
                    current["orders"][key] = {
                        "id": stable_id("ord_", key),
                        "groupId": group_id,
                        "orderNumber": payment,
                        "name": detail or address,
                        "address": address,
                        "detailAddress": detail,
                        "boxes": Decimal(0),
                        "sourceRows": 0,
                        "sequence": len(current["orders"]) + 1,
                        "regionCode": region_code,
                        "regionName": region_name,
                        "_coordinates": coords,
                        "_source_xy": source_xy,
                    }
                order = current["orders"][key]
                order["boxes"] += boxes
                order["sourceRows"] += 1
                current["rows"] += 1
                current["boxes"] += boxes
                current["payments"].add(payment)
                current["sites"].add((buyer, address, detail, raw_x, raw_y))
            date_summaries.append(finish_day(current, days_dir, zones))
        database.close()
        database_path.unlink()
        if default_date not in {item["date"] for item in date_summaries}:
            raise ValueError(f"default date {default_date} is absent from source")

        digest = hashlib.sha256()
        with csv_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        manifest = {
            "schemaVersion": 1,
            "defaultDate": default_date,
            "dates": date_summaries,
            "source": {
                "csvSha256": digest.hexdigest(),
                "csvCrs": csv_crs_name,
                "regionCrs": "EPSG:5186",
                "regionBaseDate": region_stats["baseDate"],
                "coordinateNote": "CSV x/y transformed with always_xy from EPSG:5179; SHP geometry transformed from its .prj CRS.",
                "aggregationNote": "All source rows, including exact duplicates, are summed without deduplication.",
            },
            "totals": {
                "rows": total_rows,
                "boxes": json_number(total_boxes),
                "dates": len(date_summaries),
            },
            "regions": {
                "features": region_stats["features"],
                "qualityCounts": region_stats["qualityCounts"],
                "invalidCount": region_stats["invalidCount"],
            },
        }
        if source_date is not None:
            manifest["source"]["dateShift"] = {
                "sourceDate": source_date,
                "operatingDate": operating_date,
                "offsetDays": date_offset.days,
            }
        write_json_pair(staging / "manifest.json", manifest)

        if output.exists():
            output.rename(backup)
        staging.rename(output)
        if backup.exists():
            shutil.rmtree(backup)
        return manifest
    except Exception:
        if backup.exists() and not output.exists():
            backup.rename(output)
        if staging.exists():
            shutil.rmtree(staging)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--default-date", required=True)
    parser.add_argument("--csv-crs", default="EPSG:5179")
    parser.add_argument("--source-date")
    parser.add_argument("--operating-date")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    try:
        manifest = prepare(
            args.source.resolve(), args.output.resolve(), args.default_date,
            args.csv_crs, args.replace, args.source_date, args.operating_date,
        )
    except Exception as exc:
        print(f"prepare-dispatch-data: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(manifest["totals"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
