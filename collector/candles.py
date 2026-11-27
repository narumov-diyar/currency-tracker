"""Свеча и общие правила записи цен."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from .errors import InvalidResponseError

# Масштаб столбцов цены в price_candles: numeric(18, 8).
PRICE_QUANTUM = Decimal("0.00000001")
MAX_PRICE = Decimal("9999999999.99999999")
MAX_VOLUME = Decimal("9999999999999999.99999999")

# Валюта, в которой выражены все цены. Цена её самой — единица по определению.
QUOTE_SYMBOL = "USDT"

# Разрешения, которые допускает price_candles, в минутах.
RESOLUTIONS = (1, 5, 60, 1440)


@dataclass(frozen=True)
class Candle:
    asset_id: int
    resolution: int
    collected_at: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal | None = None
    turnover: Decimal | None = None


def flat_candle(asset_id: int, resolution: int, collected_at: datetime, price: Decimal) -> Candle:
    """Вырожденная свеча: все четыре цены совпадают, объёмов нет."""
    return Candle(asset_id, resolution, collected_at, price, price, price, price)


def parse_decimal(raw) -> Decimal:
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        raise InvalidResponseError(f"not a number: {raw!r}") from None
    if not value.is_finite() or value < 0:
        raise InvalidResponseError(f"not a valid price: {raw!r}")
    return value


def parse_price(raw) -> Decimal:
    price = parse_decimal(raw)
    if not PRICE_QUANTUM <= price <= MAX_PRICE:
        raise InvalidResponseError(f"price {raw!r} is outside storage range")
    return price


def parse_volume(raw) -> Decimal:
    value = parse_decimal(raw)
    if value > MAX_VOLUME:
        raise InvalidResponseError(f"volume or turnover {raw!r} is above storage range")
    return value


def unit_price(units_per_usd) -> Decimal:
    """Переводит курс «сколько единиц валюты за доллар» в цену одной единицы.

    Источники фиатных курсов отдают, например, 84 рубля за доллар, а в базе
    цена означает «сколько USDT стоит одна единица актива», то есть 1/84.
    Без переворота кросс-курс BTC/RUB получился бы равным 753 вместо
    примерно пяти миллионов.
    """
    rate = parse_decimal(units_per_usd)
    if rate == 0:
        raise InvalidResponseError("zero exchange rate")
    try:
        price = (Decimal(1) / rate).quantize(PRICE_QUANTUM, rounding=ROUND_HALF_EVEN)
    except ArithmeticError:
        raise InvalidResponseError(f"rate {units_per_usd!r} is outside storage range") from None
    if price == 0:
        raise InvalidResponseError(f"rate {units_per_usd!r} is below storage precision")
    if price > MAX_PRICE:
        raise InvalidResponseError(f"rate {units_per_usd!r} is above storage range")
    return price
