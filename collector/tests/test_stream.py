import asyncio
import json

import aiohttp
import pytest

from collector import stream
from collector.errors import InvalidResponseError
from collector.stream import (
    Coalescer,
    StreamService,
    Tick,
    Watched,
    parse_ticker,
    parse_watched,
    topic,
)

from .helpers import FakeClock, crypto, fiat, quiet_logger

USDT, BTC, ETH, TON = crypto(1, "USDT"), crypto(2, "BTC"), crypto(3, "ETH"), crypto(13, "TON")


def ticker(symbol, price, ts):
    return {"topic": topic(symbol), "ts": ts, "type": "snapshot",
            "data": {"symbol": f"{symbol}USDT", "lastPrice": price, "volume24h": "1"}}


@pytest.mark.parametrize("payload,expected", [
    ("[2, 3]", {2, 3}),
    ("[]", set()),
    ("[2, 2]", {2}),
])
def test_parse_watched(payload, expected):
    assert parse_watched(payload) == expected


@pytest.mark.parametrize("payload", ["", "{}", '["2"]', "[true]", "[1.5]", "null", "[2,"])
def test_parse_watched_rejects(payload):
    with pytest.raises(InvalidResponseError):
        parse_watched(payload)


def test_parse_ticker_takes_only_price_and_time():
    assert parse_ticker(ticker("BTC", "80830.7", 1793194885126)) == \
        ("tickers.BTCUSDT", "80830.7", 1793194885126)


@pytest.mark.parametrize("message", [
    {"success": True, "ret_msg": "subscribe", "op": "subscribe"},
    {"op": "pong"},
    [],
    None,
])
def test_parse_ticker_ignores_service_messages(message):
    assert parse_ticker(message) is None


@pytest.mark.parametrize("message", [
    {"topic": "tickers.BTCUSDT", "ts": 1},
    {"topic": "tickers.BTCUSDT", "data": {"lastPrice": "1"}},
    {"topic": "tickers.BTCUSDT", "ts": 1, "data": {"lastPrice": "abc"}},
    {"topic": "tickers.BTCUSDT", "ts": "x", "data": {"lastPrice": "1"}},
])
def test_parse_ticker_rejects_malformed(message):
    with pytest.raises(InvalidResponseError):
        parse_ticker(message)


def test_tick_payload_matches_server_contract():
    assert json.loads(Tick(2, "BTC", "63000.12", 1792410673000).payload()) == \
        {"asset_id": 2, "symbol": "BTC", "price": "63000.12", "ts": 1792410673000}


def test_coalescer_keeps_only_latest_value():
    coalescer = Coalescer()
    for i, price in enumerate(["1", "2", "3"]):
        coalescer.put(Tick(2, "BTC", price, 1000 + i))
    coalescer.put(Tick(3, "ETH", "10", 1000))

    assert sorted(coalescer.drain(), key=lambda t: t.asset_id) == \
        [Tick(2, "BTC", "3", 1002), Tick(3, "ETH", "10", 1000)]
    assert coalescer.drain() == []


def test_coalescer_drops_out_of_order_values():
    coalescer = Coalescer()
    coalescer.put(Tick(2, "BTC", "new", 2000))
    coalescer.put(Tick(2, "BTC", "old", 1000))
    assert coalescer.drain() == [Tick(2, "BTC", "new", 2000)]

    # Отправленное значение тоже не затирается более старым.
    coalescer.put(Tick(2, "BTC", "older", 1500))
    assert coalescer.drain() == []


def test_watched_expires_without_confirmation():
    clock = FakeClock(0)
    watched = Watched(30, clock)
    assert watched.current() == set()

    watched.update({2, 3})
    clock.now = 30
    assert watched.current() == {2, 3}
    clock.now = 30.1
    assert watched.current() == set()


# --- сервис целиком на заглушках биржи и базы ---


class Message:
    def __init__(self, data):
        self.type = aiohttp.WSMsgType.TEXT
        self.data = json.dumps(data)


class FakeWS:
    def __init__(self):
        self.sent = []
        self.inbox = asyncio.Queue()
        self.closed = False

    async def send_json(self, data):
        self.sent.append(data)

    def push(self, data):
        self.inbox.put_nowait(Message(data))

    def __aiter__(self):
        return self

    async def __anext__(self):
        message = await self.inbox.get()
        if message is None:
            raise StopAsyncIteration
        return message


class FakeSession:
    def __init__(self):
        self.sockets = []

    def ws_connect(self, url):
        session = self

        class Context:
            async def __aenter__(self):
                ws = FakeWS()
                session.sockets.append(ws)
                return ws

            async def __aexit__(self, *exc):
                session.sockets[-1].closed = True

        return Context()


class FakeConnection:
    def __init__(self):
        self.listeners = {}
        self.closed = False

    async def add_listener(self, channel, callback):
        self.listeners[channel] = callback

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True

    def notify(self, channel, payload):
        self.listeners[channel](self, 1, channel, payload)


class FakeTickStore:
    def __init__(self, assets):
        self.assets = assets
        self.batches = []

    async def assets_by_source(self, source):
        return [a for a in self.assets if a.source == source]

    async def notify_ticks(self, payloads):
        self.batches.append([json.loads(p) for p in payloads])


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


@pytest.fixture
def fast(monkeypatch):
    monkeypatch.setattr(stream, "FLUSH_INTERVAL", 0.05)
    monkeypatch.setattr(stream, "PING_INTERVAL", 3600)
    monkeypatch.setattr(stream, "LISTEN_CHECK_INTERVAL", 0.01)


def test_stream_follows_viewers(fast):
    async def go():
        store = FakeTickStore([USDT, BTC, ETH, fiat(33, "RUB")])
        session, conn, stop = FakeSession(), FakeConnection(), asyncio.Event()
        service = StreamService(store, session, lambda: _ready(conn), quiet_logger(),
                                now_ms=lambda: 5000)
        task = asyncio.create_task(service.run(stop))
        await settle()

        # Без зрителей к бирже не подключаемся.
        assert session.sockets == []

        conn.notify("watched", "[2, 3, 1, 33]")
        await settle()
        ws = session.sockets[0]
        # USDT и фиат на биржу не подписываются, каждый топик — отдельным запросом.
        assert ws.sent == [{"op": "subscribe", "args": ["tickers.BTCUSDT"]},
                           {"op": "subscribe", "args": ["tickers.ETHUSDT"]}]

        for i in range(5):
            ws.push(ticker("BTC", str(100 + i), 1000 + i))
        await asyncio.sleep(0.12)
        sent = [t for batch in store.batches for t in batch]
        btc = [t for t in sent if t["symbol"] == "BTC"]
        assert btc == [{"asset_id": 2, "symbol": "BTC", "price": "104", "ts": 1004}]
        assert {"asset_id": 1, "symbol": "USDT", "price": "1", "ts": 5000} in sent

        conn.notify("watched", "[3]")
        await settle()
        assert ws.sent[2:] == [{"op": "unsubscribe", "args": ["tickers.BTCUSDT"]}]

        # Последний зритель ушёл — соединение закрывается.
        conn.notify("watched", "[]")
        await settle()
        assert ws.closed

        stop.set()
        await asyncio.wait_for(task, 1)

    asyncio.run(go())


def test_stream_reconnects_while_viewers_remain(fast, monkeypatch):
    monkeypatch.setattr(stream, "RECONNECT_DELAYS", (0.01,))

    async def go():
        store = FakeTickStore([BTC])
        session, conn, stop = FakeSession(), FakeConnection(), asyncio.Event()
        service = StreamService(store, session, lambda: _ready(conn), quiet_logger())
        task = asyncio.create_task(service.run(stop))
        await settle()
        conn.notify("watched", "[2]")
        await settle()

        session.sockets[0].inbox.put_nowait(None)  # биржа закрыла соединение
        await asyncio.sleep(0.05)

        assert len(session.sockets) == 2
        assert session.sockets[1].sent == [{"op": "subscribe", "args": ["tickers.BTCUSDT"]}]
        stop.set()
        await asyncio.wait_for(task, 1)

    asyncio.run(go())


def test_stream_ignores_rejected_subscription_and_bad_events(fast):
    async def go():
        store = FakeTickStore([BTC, TON])
        session, conn, stop = FakeSession(), FakeConnection(), asyncio.Event()
        service = StreamService(store, session, lambda: _ready(conn), quiet_logger())
        task = asyncio.create_task(service.run(stop))
        await settle()
        conn.notify("watched", "not json")  # не роняет слушателя
        conn.notify("watched", "[2, 13]")
        await settle()
        ws = session.sockets[0]
        ws.push({"success": False, "ret_msg": "Invalid symbol :[tickers.TONUSDT]",
                 "op": "subscribe"})
        ws.push({"topic": "tickers.BTCUSDT", "ts": 1})  # кривая котировка
        ws.push(ticker("BTC", "100", 1000))
        await asyncio.sleep(0.12)

        sent = [t for batch in store.batches for t in batch]
        assert sent == [{"asset_id": 2, "symbol": "BTC", "price": "100", "ts": 1000}]
        stop.set()
        await asyncio.wait_for(task, 1)

    asyncio.run(go())


async def _ready(conn):
    return conn


@pytest.mark.parametrize("price", ["0", "99999999999", "0.000000001"])
def test_parse_ticker_rejects_price_outside_storage_range(price):
    with pytest.raises(InvalidResponseError):
        parse_ticker(ticker("BTC", price, 1793194885126))
