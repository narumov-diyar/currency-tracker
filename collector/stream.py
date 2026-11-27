"""Поток текущих котировок для режима реального времени.

Сервер сообщает, какие активы сейчас смотрят, уведомлением в канале
watched. Сборщик держит WebSocket-подписку Bybit только на эти активы,
склеивает поток до одного значения в секунду на актив и передаёт его
серверу уведомлениями в канале ticks. В базу эти котировки не пишутся:
в price_candles по-прежнему попадает одна свеча в минуту.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Protocol

import aiohttp

from .candles import QUOTE_SYMBOL, parse_price
from .db import Asset
from .errors import InvalidResponseError
from .log import Logger
from .schedule import wait_stop
from .sources import bybit

WS_URL = "wss://stream.bybit.com/v5/public/spot"

# Канал, в котором сервер перечисляет просматриваемые активы массивом
# asset_id: при каждом изменении и периодически, чтобы перезапущенный
# сборщик быстро получил текущий список.
WATCHED_CHANNEL = "watched"

# Без подтверждения от сервера дольше этого срока список считается пустым:
# сервер остановлен, и держать подписку на бирже незачем.
WATCHED_TTL = 30.0

# Биржа публикует изменения каждые 50 мс, серверу же достаточно одного
# значения в секунду на актив.
FLUSH_INTERVAL = 1.0

# Биржа ждёт пинга не реже чем раз в 20 секунд, иначе закрывает соединение.
PING_INTERVAL = 20.0

RECONNECT_DELAYS = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0)
LISTEN_CHECK_INTERVAL = 5.0
LISTEN_RETRY_DELAY = 5.0


@dataclass(frozen=True)
class Tick:
    asset_id: int
    symbol: str
    price: str
    # Миллисекунды: сервер переводит значение через time.UnixMilli.
    ts: int

    def payload(self) -> str:
        return json.dumps({"asset_id": self.asset_id, "symbol": self.symbol,
                           "price": self.price, "ts": self.ts})


class TickStore(Protocol):
    async def assets_by_source(self, source: str) -> list[Asset]: ...
    async def notify_ticks(self, payloads: list[str]) -> None: ...


def topic(symbol: str) -> str:
    return f"tickers.{symbol}USDT"


def parse_watched(payload: str) -> set[int]:
    try:
        data = json.loads(payload)
    except ValueError:
        raise InvalidResponseError(f"watched: malformed JSON: {payload!r}") from None
    if not isinstance(data, list) or not all(
            isinstance(i, int) and not isinstance(i, bool) for i in data):
        raise InvalidResponseError(f"watched: expected array of asset ids: {payload!r}")
    return set(data)


def parse_ticker(message: Any) -> tuple[str, str, int] | None:
    """Достаёт из сообщения биржи топик, цену и время.

    Нужны только lastPrice и ts, остальные поля не читаются. Ответы на
    подписку и пинг котировками не являются, для них возвращается None.
    """
    if not isinstance(message, dict) or not str(message.get("topic", "")).startswith("tickers."):
        return None
    try:
        price = message["data"]["lastPrice"]
        ts = int(message["ts"])
    except (KeyError, TypeError, ValueError):
        raise InvalidResponseError(f"ticker {message.get('topic')}: unexpected shape") from None
    parse_price(price)
    return message["topic"], str(price), ts


class Coalescer:
    """Склейка: по каждому активу хранится только последнее значение.

    Сообщения биржи могут прийти не по порядку, поэтому значение старше
    уже принятого или отправленного отбрасывается.
    """

    def __init__(self):
        self._pending: dict[int, Tick] = {}
        self._latest: dict[int, int] = {}

    def put(self, tick: Tick) -> None:
        if tick.ts < self._latest.get(tick.asset_id, -1):
            return
        self._latest[tick.asset_id] = tick.ts
        self._pending[tick.asset_id] = tick

    def drain(self) -> list[Tick]:
        ticks = list(self._pending.values())
        self._pending.clear()
        return ticks


class Watched:
    """Последний полученный от сервера список просматриваемых активов."""

    def __init__(self, ttl: float, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._ids: set[int] = set()
        self._updated_at: float | None = None

    def update(self, ids: set[int]) -> None:
        self._ids = set(ids)
        self._updated_at = self._clock()

    def current(self) -> set[int]:
        if self._updated_at is None or self._clock() - self._updated_at > self._ttl:
            return set()
        return set(self._ids)


class StreamService:
    """Держит подписку на бирже только на активы, которые кто-то смотрит.

    Подписка открывается, когда у актива появляется зритель, и закрывается
    вместе с соединением, когда уходит последний: иначе входящий поток
    от биржи по всему каталогу достигает 18 ГБ в сутки.
    """

    def __init__(self, store: TickStore, session: aiohttp.ClientSession,
                 connect: Callable[[], Awaitable[Any]], logger: Logger, *,
                 clock: Callable[[], float] = time.monotonic,
                 now_ms: Callable[[], int] = lambda: int(time.time() * 1000)):
        self._store = store
        self._session = session
        self._connect = connect
        self._logger = logger
        self._now_ms = now_ms
        self._watched = Watched(WATCHED_TTL, clock)
        self._coalescer = Coalescer()
        self._changed = asyncio.Event()
        self._assets: dict[int, Asset] = {}
        self._subscribed: set[str] = set()

    async def run(self, stop: asyncio.Event) -> None:
        if not await self._load_assets(stop):
            return
        await asyncio.gather(self._listen(stop), self._socket(stop), self._flush(stop))

    async def _load_assets(self, stop: asyncio.Event) -> bool:
        while not stop.is_set():
            try:
                assets = await self._store.assets_by_source(bybit.NAME)
            except Exception as exc:
                self._logger.error("stream: assets not loaded", error=str(exc))
                await wait_stop(stop, LISTEN_RETRY_DELAY)
                continue
            self._assets = {a.id: a for a in assets if a.supports_realtime}
            return True
        return False

    def _desired(self) -> dict[str, Asset]:
        """Топики биржи для просматриваемых активов.

        Неизвестные и не поддерживающие поток активы пропускаются. У USDT
        пары на бирже нет, его котировки сборщик отправляет сам.
        """
        desired = {}
        for asset_id in self._watched.current():
            asset = self._assets.get(asset_id)
            if asset is not None and asset.symbol != QUOTE_SYMBOL:
                desired[topic(asset.symbol)] = asset
        return desired

    def _quote_watched(self) -> Asset | None:
        for asset_id in self._watched.current():
            asset = self._assets.get(asset_id)
            if asset is not None and asset.symbol == QUOTE_SYMBOL:
                return asset
        return None

    # --- список зрителей от сервера ---

    async def _listen(self, stop: asyncio.Event) -> None:
        # LISTEN действует в пределах соединения, поэтому оно отдельное
        # и удерживается всё время, а не берётся из пула на время запроса.
        while not stop.is_set():
            conn = None
            try:
                conn = await self._connect()
                await conn.add_listener(WATCHED_CHANNEL, self._on_watched)
                self._logger.info("stream: listening for viewers", channel=WATCHED_CHANNEL)
                while not stop.is_set() and not conn.is_closed():
                    await wait_stop(stop, LISTEN_CHECK_INTERVAL)
            except Exception as exc:
                self._logger.error("stream: viewers listener failed", error=str(exc))
            finally:
                if conn is not None and not conn.is_closed():
                    await conn.close()
            if not stop.is_set():
                await wait_stop(stop, LISTEN_RETRY_DELAY)

    def _on_watched(self, _conn, _pid, _channel, payload: str) -> None:
        try:
            ids = parse_watched(payload)
        except InvalidResponseError as exc:
            self._logger.error("stream: malformed watched event", error=str(exc))
            return
        self._watched.update(ids)
        self._changed.set()

    # --- соединение с биржей ---

    async def _socket(self, stop: asyncio.Event) -> None:
        attempt = 0
        while not stop.is_set():
            if not self._desired():
                # Срок списка истекает без всякого события, поэтому ожидание
                # ограничено: пустой список заметится и без уведомления.
                await self._wait_any(stop, None, PING_INTERVAL)
                continue
            try:
                async with self._session.ws_connect(WS_URL) as ws:
                    self._logger.info("stream: connected", url=WS_URL)
                    attempt = 0
                    await self._serve(ws, stop)
            except Exception as exc:
                self._logger.warning("stream: connection failed",
                                     error_type=type(exc).__name__, error=str(exc))
            self._subscribed = set()
            if stop.is_set() or not self._desired():
                continue
            # Обрыв при живых зрителях: переподключение с растущей паузой.
            delay = RECONNECT_DELAYS[min(attempt, len(RECONNECT_DELAYS) - 1)]
            attempt += 1
            self._logger.warning("stream: reconnecting", delay_seconds=delay)
            await wait_stop(stop, delay)

    async def _serve(self, ws, stop: asyncio.Event) -> None:
        self._subscribed = set()
        reader = asyncio.create_task(self._read(ws))
        loop = asyncio.get_running_loop()
        last_ping = loop.time()
        try:
            while not stop.is_set() and not reader.done():
                # Событие сбрасывается до вычисления списка: изменение,
                # пришедшее во время синхронизации, не потеряется.
                self._changed.clear()
                desired = self._desired()
                if not desired:
                    self._logger.info("stream: closed, no viewers")
                    return
                await self._sync(ws, set(desired))
                await self._wait_any(stop, reader,
                                     max(0.0, PING_INTERVAL - (loop.time() - last_ping)))
                if not reader.done() and loop.time() - last_ping >= PING_INTERVAL:
                    await ws.send_json({"op": "ping"})
                    last_ping = loop.time()
            if reader.done() and not reader.cancelled() and reader.exception():
                raise reader.exception()
        finally:
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader

    async def _sync(self, ws, topics: set[str]) -> None:
        added, removed = sorted(topics - self._subscribed), sorted(self._subscribed - topics)
        # По одному топику на запрос: биржа отклоняет запрос целиком, если
        # в нём есть хоть один неизвестный символ, и тогда не пришли бы
        # котировки и остальных активов.
        for name in added:
            await ws.send_json({"op": "subscribe", "args": [name]})
        for name in removed:
            await ws.send_json({"op": "unsubscribe", "args": [name]})
        self._subscribed = set(topics)
        if added or removed:
            self._logger.info("stream: subscriptions changed", added=added, removed=removed,
                              total=len(topics))

    async def _read(self, ws) -> None:
        by_topic = {topic(a.symbol): a for a in self._assets.values()}
        async for msg in ws:
            if msg.type is not aiohttp.WSMsgType.TEXT:
                continue
            try:
                message = json.loads(msg.data)
            except ValueError:
                self._logger.warning("stream: malformed message")
                continue
            if isinstance(message, dict) and message.get("op") == "subscribe" \
                    and not message.get("success"):
                self._logger.warning("stream: subscription rejected",
                                     reason=message.get("ret_msg"))
                continue
            try:
                parsed = parse_ticker(message)
            except InvalidResponseError as exc:
                self._logger.warning("stream: malformed ticker", error=str(exc))
                continue
            if parsed is None:
                continue
            name, price, ts = parsed
            asset = by_topic.get(name)
            if asset is not None:
                self._coalescer.put(Tick(asset.id, asset.symbol, price, ts))

    async def _wait_any(self, stop: asyncio.Event, reader: asyncio.Task | None,
                        timeout: float) -> None:
        waiters = [asyncio.create_task(self._changed.wait()), asyncio.create_task(stop.wait())]
        try:
            await asyncio.wait(waiters + ([reader] if reader else []), timeout=timeout,
                               return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in waiters:
                waiter.cancel()

    # --- передача серверу ---

    async def _flush(self, stop: asyncio.Event) -> None:
        while not await wait_stop(stop, FLUSH_INTERVAL):
            ticks = self._coalescer.drain()
            quote = self._quote_watched()
            if quote is not None:
                ticks.append(Tick(quote.id, quote.symbol, "1", self._now_ms()))
            if not ticks:
                continue
            try:
                await self._store.notify_ticks([t.payload() for t in ticks])
            except Exception as exc:
                # Котировки потока живут только в памяти сервера, повторять
                # отправку устаревшего значения смысла нет.
                self._logger.error("stream: ticks not delivered", count=len(ticks),
                                   error=str(exc))
