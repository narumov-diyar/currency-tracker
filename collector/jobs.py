"""Циклы опроса источников."""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Protocol

from .breaker import CircuitBreaker, State
from .candles import QUOTE_SYMBOL, RESOLUTIONS, Candle, flat_candle
from .db import Asset
from .errors import SourceError
from .httpclient import FetchJSON
from .log import Logger
from .retry import with_retry
from .schedule import Job, seconds_until_next
from .sources import bybit, cbr, erapi

# Сдвиг опроса от границы интервала. Минутную свечу биржа закрывает
# не мгновенно, а курсы er-api обновляются в первые полчаса суток UTC.
CRYPTO_OFFSET = 2.0
FIAT_OFFSET = 3600.0

DEFAULT_CRYPTO_PERIOD = 60
DEFAULT_FIAT_PERIOD = 86400

# Доля периода, которую цикл может потратить на повторы: следующий цикл
# не должен начинаться, пока не закончился предыдущий.
CYCLE_BUDGET_SHARE = 0.75
MAX_FIAT_BUDGET = 120.0

# Одновременных запросов к бирже: каталог опрашивается за секунды,
# а лимит биржи остаётся далеко.
BYBIT_CONCURRENCY = 10


class Store(Protocol):
    async def assets_by_source(self, source: str) -> list[Asset]: ...
    async def assets_by_type(self, asset_type: str) -> list[Asset]: ...
    async def save_candles(self, candles: list[Candle]) -> int: ...


def _usable(assets: list[Asset], logger: Logger, job: str) -> list[Asset]:
    usable = []
    for asset in assets:
        if asset.resolution_seconds % 60 or asset.resolution not in RESOLUTIONS:
            logger.error("asset skipped: unsupported resolution", job=job, symbol=asset.symbol,
                         resolution_seconds=asset.resolution_seconds)
            continue
        usable.append(asset)
    return usable


def _quote_minute(fetched: list[Candle], started: float) -> datetime:
    """Минута, в которую ложится свеча USDT.

    Берётся у свечей биржи: локальные часы могут расходиться с биржевыми,
    а цикл — запаздывать, и тогда USDT оказался бы в другой минуте, чем
    остальные активы, а в сравнении пар появились бы разрывы. Если свечи
    разошлись по минутам, побеждает самая частая. Локальные часы остаются
    на случай, когда биржа не отдала ничего.
    """
    if fetched:
        return Counter(c.collected_at for c in fetched).most_common(1)[0][0]
    return datetime.fromtimestamp((started // 60 - 1) * 60, timezone.utc)


class CryptoJob(Job):
    """Раз в минуту забирает закрытую минутную свечу по каждому активу биржи."""

    name = "crypto"
    failure_delay = DEFAULT_CRYPTO_PERIOD

    def __init__(self, store: Store, fetch: FetchJSON, breaker: CircuitBreaker,
                 stop: asyncio.Event, logger: Logger, *, attempts: int,
                 base_delay: float = 1.0, clock: Callable[[], float] = time.time):
        self._store = store
        self._fetch = fetch
        self._breaker = breaker
        self._stop = stop
        self._logger = logger
        self._attempts = attempts
        self._base_delay = base_delay
        self._clock = clock

    async def cycle(self) -> float:
        assets = _usable(await self._store.assets_by_source(bybit.NAME), self._logger, self.name)
        period = min((a.resolution_seconds for a in assets), default=DEFAULT_CRYPTO_PERIOD)
        started = self._clock()

        traded = [a for a in assets if a.symbol != QUOTE_SYMBOL]
        deadline = asyncio.get_running_loop().time() + period * CYCLE_BUDGET_SHARE
        fetched = await self._fetch_all(traded, deadline)

        # Цена котировочной валюты в самой себе — единица, на бирже такой
        # пары нет. Свеча пишется, чтобы пары с USDT имели обе стороны.
        quote_minute = _quote_minute(fetched, started)
        quote = [flat_candle(a.id, a.resolution, quote_minute, Decimal(1))
                 for a in assets if a.symbol == QUOTE_SYMBOL]

        saved = await self._store.save_candles(fetched + quote)
        self._logger.info("crypto cycle finished", source=bybit.NAME, polled=len(traded),
                          fetched=len(fetched), failed=len(traded) - len(fetched), saved=saved,
                          breaker=self._breaker.state.value,
                          duration_seconds=round(self._clock() - started, 3))
        return seconds_until_next(self._clock(), period, CRYPTO_OFFSET)

    async def _fetch_all(self, assets: list[Asset], deadline: float) -> list[Candle]:
        if not assets:
            return []

        state = self._breaker.state
        if state is State.OPEN:
            self._logger.warning("source suspended by circuit breaker", source=bybit.NAME)
            return []

        fetched: list[Candle] = []
        if state is State.HALF_OPEN:
            # Пробный запрос один и без повторов: источник, только что
            # отвечавший ошибками, не нужно нагружать всем каталогом сразу.
            probe, assets = assets[0], assets[1:]
            candle = await self._fetch_one(probe, deadline, attempts=1)
            if candle is None:
                self._breaker.record_failure()
                return []
            fetched.append(candle)

        semaphore = asyncio.Semaphore(BYBIT_CONCURRENCY)

        async def limited(asset: Asset) -> Candle | None:
            async with semaphore:
                return await self._fetch_one(asset, deadline, attempts=self._attempts)

        results = await asyncio.gather(*(limited(a) for a in assets))
        fetched.extend(c for c in results if c is not None)

        # Цикл неуспешен, только если источник не отдал ничего: отказ по одному
        # символу — это ошибка справочника, а не недоступность биржи.
        if fetched:
            self._breaker.record_success()
        else:
            self._breaker.record_failure()
        return fetched

    async def _fetch_one(self, asset: Asset, deadline: float, attempts: int) -> Candle | None:
        try:
            return await with_retry(
                lambda: bybit.fetch_candle(self._fetch, asset, self._clock),
                attempts=attempts, deadline=deadline, stop=self._stop, logger=self._logger,
                what=f"{bybit.NAME}:{asset.symbol}", base_delay=self._base_delay,
            )
        except SourceError as exc:
            self._logger.error("request failed", source=bybit.NAME, symbol=asset.symbol,
                               error_type=type(exc).__name__, error=str(exc))
            return None
        except Exception as exc:
            # Непредвиденная ошибка по одному активу не должна срывать сбор:
            # исключение из gather отменило бы весь цикл, и свечи остальных
            # активов за эту минуту потерялись бы.
            self._logger.exception("unexpected error", source=bybit.NAME, symbol=asset.symbol,
                                   error_type=type(exc).__name__, error=str(exc))
            return None


class FiatJob(Job):
    """Раз в сутки забирает курсы фиатных валют, при отказе — курс рубля от ЦБ."""

    name = "fiat"

    def __init__(self, store: Store, fetch: FetchJSON, primary: CircuitBreaker,
                 backup: CircuitBreaker, stop: asyncio.Event, logger: Logger, *,
                 attempts: int, retry_interval: float, base_delay: float = 1.0,
                 clock: Callable[[], float] = time.time):
        self._store = store
        self._fetch = fetch
        self._primary = primary
        self._backup = backup
        self._stop = stop
        self._logger = logger
        self._attempts = attempts
        self._retry_interval = retry_interval
        self._base_delay = base_delay
        self._clock = clock
        self.failure_delay = retry_interval

    async def cycle(self) -> float:
        assets = _usable(await self._store.assets_by_type("fiat"), self._logger, self.name)
        period = min((a.resolution_seconds for a in assets), default=DEFAULT_FIAT_PERIOD)
        until_next = seconds_until_next(self._clock(), period, FIAT_OFFSET)

        if await self._collect(assets, period):
            return until_next
        # Сутки до следующей попытки — слишком долго: неуспешный цикл
        # повторяется чаще, и по этим повторам предохранитель основного
        # источника успевает открыться и включить резервный.
        return min(self._retry_interval, until_next)

    async def _collect(self, assets: list[Asset], period: float) -> bool:
        if not assets:
            return True

        deadline = asyncio.get_running_loop().time() + min(period * CYCLE_BUDGET_SHARE,
                                                           MAX_FIAT_BUDGET)
        state = self._primary.state
        if state is State.OPEN:
            self._logger.warning("source suspended by circuit breaker", source=erapi.NAME)
        else:
            attempts = 1 if state is State.HALF_OPEN else self._attempts
            try:
                day, prices = await with_retry(
                    lambda: erapi.fetch_prices(self._fetch, [a.symbol for a in assets]),
                    attempts=attempts, deadline=deadline, stop=self._stop,
                    logger=self._logger, what=erapi.NAME, base_delay=self._base_delay,
                )
            except SourceError as exc:
                self._primary.record_failure()
                self._logger.error("request failed", source=erapi.NAME,
                                   error_type=type(exc).__name__, error=str(exc))
            else:
                self._primary.record_success()
                await self._save_prices(assets, day, prices)
                return True

        if self._primary.state is State.OPEN:
            await self._fallback(assets, deadline)
        return False

    async def _save_prices(self, assets: list[Asset], day: datetime,
                           prices: dict[str, Decimal]) -> None:
        candles = [flat_candle(a.id, a.resolution, day, prices[a.symbol])
                   for a in assets if a.symbol in prices]
        missing = sorted(a.symbol for a in assets if a.symbol not in prices)
        if missing:
            self._logger.warning("currencies missing in response", source=erapi.NAME,
                                 symbols=missing)
        saved = await self._store.save_candles(candles)
        self._logger.info("fiat cycle finished", source=erapi.NAME, day=day.date().isoformat(),
                          fetched=len(candles), saved=saved)

    async def _fallback(self, assets: list[Asset], deadline: float) -> None:
        rub = next((a for a in assets if a.symbol == cbr.SYMBOL), None)
        if rub is None:
            return

        state = self._backup.state
        if state is State.OPEN:
            self._logger.warning("source suspended by circuit breaker", source=cbr.NAME)
            return

        self._logger.warning("switching to backup source", primary=erapi.NAME, backup=cbr.NAME)
        try:
            rate = await with_retry(
                lambda: cbr.fetch_rub(self._fetch, self._clock),
                attempts=1 if state is State.HALF_OPEN else self._attempts,
                deadline=deadline, stop=self._stop, logger=self._logger, what=cbr.NAME,
                base_delay=self._base_delay,
            )
        except SourceError as exc:
            self._backup.record_failure()
            self._logger.error("request failed", source=cbr.NAME,
                               error_type=type(exc).__name__, error=str(exc))
            return

        self._backup.record_success()
        if rate is None:
            self._logger.info("cbr rate is not effective yet", source=cbr.NAME)
            return
        day, price = rate
        saved = await self._store.save_candles([flat_candle(rub.id, rub.resolution, day, price)])
        self._logger.info("fiat cycle finished", source=cbr.NAME, day=day.date().isoformat(),
                          fetched=1, saved=saved)
