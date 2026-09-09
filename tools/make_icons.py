"""拡張機能のアイコンPNGを生成する。外部ライブラリは使わない。

チケット（クーポン券）を模した図案。オレンジの角丸四角に、
左右にノッチの入った白い券が乗っている。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

BG_TOP = (245, 140, 60)
BG_BOTTOM = (226, 74, 26)
TICKET = (255, 255, 255)


def _rounded(x: float, y: float, size: float, radius: float) -> float:
    """角丸四角の内側なら1.0、外なら0.0。境目は中間値（アンチエイリアス）。"""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    distance = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    return max(0.0, min(1.0, radius - distance + 0.5))


def _circle(x: float, y: float, cx: float, cy: float, r: float) -> float:
    distance = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    return max(0.0, min(1.0, r - distance + 0.5))


def _blend(base, over, alpha):
    return tuple(round(b + (o - b) * alpha) for b, o in zip(base, over))


def render(size: int) -> bytes:
    rows = []
    radius = size * 0.22
    inset = size * 0.20
    ticket_radius = size * 0.07
    notch_r = size * 0.11

    for py in range(size):
        row = bytearray()
        y = py + 0.5
        ratio = py / max(size - 1, 1)
        background = tuple(
            round(t + (b - t) * ratio) for t, b in zip(BG_TOP, BG_BOTTOM)
        )
        for px in range(size):
            x = px + 0.5
            outer = _rounded(x, y, size, radius)
            if outer <= 0:
                row += bytes((0, 0, 0, 0))
                continue

            color = background

            # 白いチケット部分
            tx, ty = x - inset, y - inset * 1.15
            tsize_w = size - inset * 2
            tsize_h = size - inset * 2.3
            inside = 0.0
            if 0 <= tx <= tsize_w and 0 <= ty <= tsize_h:
                cx = min(max(tx, ticket_radius), tsize_w - ticket_radius)
                cy = min(max(ty, ticket_radius), tsize_h - ticket_radius)
                distance = ((tx - cx) ** 2 + (ty - cy) ** 2) ** 0.5
                inside = max(0.0, min(1.0, ticket_radius - distance + 0.5))

            if inside > 0:
                # 左右のノッチをくり抜く
                mid = inset * 1.15 + tsize_h / 2
                notch = max(
                    _circle(x, y, inset, mid, notch_r),
                    _circle(x, y, size - inset, mid, notch_r),
                )
                inside *= 1.0 - notch

            if inside > 0:
                color = _blend(color, TICKET, inside)

            alpha = round(255 * outer)
            row += bytes((color[0], color[1], color[2], alpha))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)
    return _png(size, size, raw)


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _png(width: int, height: int, raw: bytes) -> bytes:
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "extension" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = out / f"icon{size}.png"
        path.write_bytes(render(size))
        print(f"{path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
