"""Курсы фиатных валют с open.er-api.com — основной источник."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal

from ..candles import unit_price
from ..errors import InvalidResponseError
from ..httpclient import FetchJSON

NAME = "er-api"
URL = "https://open.er-api.com/v6/latest/USD"
logger = logging.getLogger(__name__)


async def fetch_prices(fetch: FetchJSON, symbols: list[str]) -> tuple[datetime, dict[str, Decimal]]:
    return parse_latest(await fetch(URL, None), symbols)


def parse_latest(payload, symbols: list[str]) -> tuple[datetime, dict[str, Decimal]]:
    """Возвращает день курсов и цену одной единицы каждой валюты в долларах.

    Один ответ содержит все валюты сразу. Валюты, которых в ответе нет,
    просто отсутствуют в результате.
    """
    if not isinstance(payload, dict) or payload.get("result") != "success":
        error = payload.get("error-type") if isinstance(payload, dict) else None
        raise InvalidResponseError(f"er-api: unsuccessful response: {error}")

    try:
        rates = payload["rates"]
        updated = int(payload["time_last_update_unix"])
    except (KeyError, TypeError, ValueError):
        raise InvalidResponseError("er-api: unexpected shape") from None
    if not isinstance(rates, dict):
        raise InvalidResponseError("er-api: rates is not an object")

    prices = {}
    invalid_count = 0
    for symbol in symbols:
        if symbol not in rates:
            continue
        try:
            prices[symbol] = unit_price(rates[symbol])
        except InvalidResponseError as exc:
            invalid_count += 1
            logger.warning("er-api: skipped invalid rate for %s: %s", symbol, exc)
    if invalid_count and not prices:
        raise InvalidResponseError("er-api: all available requested rates are invalid")
    return day_start(datetime.fromtimestamp(updated, timezone.utc)), prices


def day_start(moment: datetime) -> datetime:
    """Начало суток в UTC: дневная свеча открывается в полночь."""
    return moment.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
