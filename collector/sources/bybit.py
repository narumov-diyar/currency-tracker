"""Минутные свечи криптовалют с биржи Bybit."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from ..candles import Candle, parse_price, parse_volume
from ..db import Asset
from ..errors import InvalidResponseError, RequestRejectedError, TransientError
from ..httpclient import FetchJSON

NAME = "bybit"
KLINE_URL = "https://api.bybit.com/v5/market/kline"

# Коды ошибок биржи, приходящие с HTTP 200: превышение лимита запросов
# и внутренние сбои — временные, остальное означает ошибку в запросе.
_TRANSIENT_CODES = {10000, 10006, 10016}

INTERVAL_MS = 60_000


def kline_params(symbol: str) -> dict[str, str]:
    return {"category": "spot", "symbol": f"{symbol}USDT", "interval": "1", "limit": "2"}


async def fetch_candle(fetch: FetchJSON, asset: Asset, clock: Callable[[], float]) -> Candle:
    payload = await fetch(KLINE_URL, kline_params(asset.symbol))
    # Время берётся после ответа: повтор мог прийти уже в следующей минуте,
    # и закрытость свечи нужно сверять с моментом, когда биржа её отдала.
    return parse_kline(payload, asset, int(clock() * 1000))


def parse_kline(payload, asset: Asset, now_ms: int) -> Candle:
    """Достаёт из ответа последнюю закрытую свечу.

    Свечи идут от новой к старой, и первая на момент запроса ещё может
    формироваться, поэтому берётся вторая.
    """
    if not isinstance(payload, dict):
        raise InvalidResponseError("kline: response is not an object")

    code = payload.get("retCode")
    if code != 0:
        message = f"kline {asset.symbol}: retCode {code}: {payload.get('retMsg')}"
        if code in _TRANSIENT_CODES:
            raise TransientError(message)
        raise RequestRejectedError(message)

    try:
        rows = payload["result"]["list"]
        row = rows[1]
        start_ms = int(row[0])
        open_, high, low, close = (parse_price(v) for v in row[1:5])
        volume, turnover = (parse_volume(v) for v in row[5:7])
    except (KeyError, IndexError, TypeError, ValueError):
        raise InvalidResponseError(f"kline {asset.symbol}: unexpected shape") from None

    if start_ms + INTERVAL_MS > now_ms:
        raise InvalidResponseError(f"kline {asset.symbol}: candle {start_ms} is not closed yet")

    return Candle(
        asset_id=asset.id,
        resolution=asset.resolution,
        collected_at=datetime.fromtimestamp(start_ms / 1000, timezone.utc),
        open=open_, high=high, low=low, close=close,
        volume=volume, turnover=turnover,
    )
