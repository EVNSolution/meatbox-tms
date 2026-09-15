#!/usr/bin/env python3
"""Build a cumulative destination catalog from the dispatch CSV."""

from __future__ import annotations

import argparse
import csv
from datetime import date as calendar_date
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile


HEADERS = {
    "payment": "결제번호",
    "buyer": "구매자 회원 번호",
    "region_code": "권역코드",
    "region_name": "권역명",
    "date": "배송완료일자",
    "address": "주소",
    "detail": "상세주소",
    "x": "x",
    "y": "y",
    "driver": "배송기사 성명",
    "boxes": "수량 (박스수-취소박스수), 일반: distbox.BOX_CNT-CANCEL_BOX_CNT / 묶음: bundle_box_item.CNT-CANCEL_CNT",
}


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


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_signature(manifest: dict) -> str:
    shift = manifest.get("source", {}).get("dateShift")
    value = [
        manifest.get("source", {}).get("csvSha256"),
        [shift.get("sourceDate"), shift.get("operatingDate"), shift.get("offsetDays")] if shift else None,
        sorted(item.get("date") for item in manifest.get("dates", [])),
    ]
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def read_manifest(path: Path, csv_hash: str) -> tuple[dict, dict[str, str]]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("source", {}).get("csvSha256") != csv_hash:
        raise ValueError("manifest source hash does not match CSV")
    dates = manifest.get("dates")
    if not isinstance(dates, list) or not dates:
        raise ValueError("manifest has no dates")
    mapping = {}
    for item in dates:
        operating_date = item.get("date")
        source_date = item.get("sourceDate", operating_date)
        try:
            if calendar_date.fromisoformat(operating_date).isoformat() != operating_date:
                raise ValueError
            if calendar_date.fromisoformat(source_date).isoformat() != source_date:
                raise ValueError
        except (TypeError, ValueError) as exc:
            raise ValueError("manifest contains an invalid date") from exc
        if source_date in mapping or operating_date in mapping.values():
            raise ValueError("manifest dates must be unique")
        mapping[source_date] = operating_date
    return manifest, mapping


def prepare(csv_path: Path, manifest_path: Path, output_path: Path) -> dict:
    if not csv_path.is_file():
        raise FileNotFoundError(csv_path)
    if not manifest_path.is_file():
        raise FileNotFoundError(manifest_path)
    csv_hash = sha256(csv_path)
    manifest, date_mapping = read_manifest(manifest_path, csv_hash)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    database_file = tempfile.NamedTemporaryFile(
        prefix=".destination-data-", suffix=".sqlite", dir=output_path.parent, delete=False
    )
    database_file.close()
    database_path = Path(database_file.name)
    output_file = tempfile.NamedTemporaryFile(
        prefix=f".{output_path.name}-", suffix=".tmp", dir=output_path.parent, delete=False
    )
    output_file.close()
    staged_output = Path(output_file.name)
    database = None
    try:
        database = sqlite3.connect(database_path)
        database.execute("PRAGMA journal_mode=OFF")
        database.execute("PRAGMA synchronous=OFF")
        database.execute("PRAGMA temp_store=FILE")
        database.execute(
            """CREATE TABLE source_rows (
                seq INTEGER PRIMARY KEY, site_key TEXT, destination_id TEXT, date TEXT,
                name TEXT, address TEXT, detail TEXT, region TEXT, order_key TEXT, boxes TEXT
            )"""
        )
        rows = 0
        batch = []
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            missing = [name for name in HEADERS.values() if name not in (reader.fieldnames or [])]
            if missing:
                raise ValueError(f"missing CSV columns: {missing}")
            for row_number, row in enumerate(reader, start=2):
                source_date = row[HEADERS["date"]].strip()
                operating_date = date_mapping.get(source_date)
                if operating_date is None:
                    raise ValueError(f"row {row_number}: date {source_date!r} is absent from manifest")
                parts = {
                    key: row[HEADERS[key]]
                    for key in ("payment", "buyer", "region_code", "region_name", "address", "detail", "x", "y", "driver")
                }
                boxes = parse_boxes(row[HEADERS["boxes"]], row_number)
                site_parts = (parts["buyer"], parts["address"], parts["detail"], parts["x"], parts["y"])
                order_parts = (
                    source_date, parts["payment"], parts["buyer"], parts["address"],
                    parts["detail"], parts["driver"], parts["x"], parts["y"], parts["region_code"],
                )
                batch.append((
                    row_number,
                    json.dumps(site_parts, ensure_ascii=False, separators=(",", ":")),
                    stable_id("dst_", site_parts),
                    operating_date,
                    parts["detail"] or parts["address"],
                    parts["address"],
                    parts["detail"],
                    parts["region_name"],
                    json.dumps(order_parts, ensure_ascii=False, separators=(",", ":")),
                    str(boxes),
                ))
                if len(batch) == 5000:
                    database.executemany("INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
                    batch.clear()
                rows += 1
        if batch:
            database.executemany("INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
        database.commit()
        database.execute("CREATE INDEX source_rows_catalog ON source_rows(site_key, date, order_key, seq)")

        source = {"csvSha256": csv_hash, "manifestSignature": manifest_signature(manifest)}
        if "dateShift" in manifest.get("source", {}):
            source["dateShift"] = manifest["source"]["dateShift"]
        prefix = json.dumps({"schemaVersion": 1, "source": source}, ensure_ascii=False, separators=(",", ":"))[:-1]
        destination_count = 0
        with staged_output.open("w", encoding="utf-8") as output:
            output.write(prefix + ',"destinations":[')
            current_site = current_date = current_order = None
            destination = None
            day = None
            order_boxes = Decimal(0)

            def finish_order():
                nonlocal order_boxes
                if day is not None and current_order is not None:
                    day["orderCount"] += 1
                    day["boxCount"] += order_boxes
                order_boxes = Decimal(0)

            def finish_day():
                if destination is not None and day is not None:
                    destination["dates"].append({
                        "date": day["date"],
                        "regionNames": sorted(day["regionNames"]),
                        "orderCount": day["orderCount"],
                        "boxCount": json_number(day["boxCount"]),
                    })

            def finish_destination():
                nonlocal destination_count
                if destination is None:
                    return
                if destination_count:
                    output.write(",")
                output.write(json.dumps(destination, ensure_ascii=False, separators=(",", ":")))
                destination_count += 1

            query = """SELECT site_key, destination_id, date, name, address, detail, region, order_key, boxes
                       FROM source_rows ORDER BY site_key, date, order_key, seq"""
            for site_key, destination_id, date, name, address, detail, region, order_key, boxes in database.execute(query):
                if site_key != current_site:
                    finish_order()
                    finish_day()
                    finish_destination()
                    current_site, current_date, current_order = site_key, date, order_key
                    destination = {
                        "id": destination_id,
                        "name": name,
                        "address": address,
                        "detailAddress": detail,
                        "dates": [],
                    }
                    day = {"date": date, "regionNames": set(), "orderCount": 0, "boxCount": Decimal(0)}
                elif date != current_date:
                    finish_order()
                    finish_day()
                    current_date, current_order = date, order_key
                    day = {"date": date, "regionNames": set(), "orderCount": 0, "boxCount": Decimal(0)}
                elif order_key != current_order:
                    finish_order()
                    current_order = order_key
                if region:
                    day["regionNames"].add(region)
                order_boxes += Decimal(boxes)
            finish_order()
            finish_day()
            finish_destination()
            output.write("]}")
        os.replace(staged_output, output_path)
        return {"rows": rows, "destinations": destination_count, "bytes": output_path.stat().st_size}
    finally:
        if database is not None:
            database.close()
        database_path.unlink(missing_ok=True)
        staged_output.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="analysis_dataset.csv")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args.source.resolve(), args.manifest.resolve(), args.output.resolve())
    except Exception as exc:
        print(f"prepare-destination-data: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
