"""Запись, атомарность и уведомления на настоящей PostgreSQL."""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest

from collector.candles import Candle
from collector.db import CANDLES_CHANNEL, Store

MIGRATION = Path(__file__).resolve().parents[2] / "internal/storage/migrations/0001_init.sql"


@pytest.fixture
def database_url():
    dsn = os.getenv("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL не задан")
    return dsn


@asynccontextmanager
async def database(dsn):
    nonce = uuid4()
    schema = f"collector_test_{nonce.hex}"
    # LISTEN действует на всю базу: уникальные ID отделяют уведомления
    # этого прогона от других схем и параллельных тестов.
    btc = 1_000_000 + nonce.int % 1_000_000_000
    eth = btc + 1
    async with asyncpg.create_pool(dsn, min_size=1, max_size=2) as admin:
        await admin.execute(f'CREATE SCHEMA "{schema}"')
        settings = {"search_path": schema}
        try:
            async with asyncpg.create_pool(
                dsn, server_settings=settings, min_size=1, max_size=2,
            ) as pool:
                await pool.execute(MIGRATION.read_text(encoding="utf-8"))
                await pool.executemany(
                    "INSERT INTO assets "
                    "(id, symbol, type, source, resolution_seconds, supports_realtime) "
                    "VALUES ($1, $2, 'crypto', 'bybit', 60, true)", [(btc, "BTC"), (eth, "ETH")])
                listener = await asyncpg.connect(dsn, server_settings=settings)
                try:
                    notifications = asyncio.Queue()

                    def on_candle(_connection, _pid, _channel, payload):
                        asset_id = json.loads(payload)["asset_id"]
                        if asset_id in (btc, eth):
                            notifications.put_nowait(asset_id)

                    await listener.add_listener(CANDLES_CHANNEL, on_candle)
                    yield Store(pool), listener, notifications, btc, eth
                finally:
                    await listener.close()
        finally:
            await admin.execute(f'DROP SCHEMA "{schema}" CASCADE')


def batch(btc, eth):
    start = datetime(2026, 10, 27, 21, 32, tzinfo=timezone.utc)
    first = Candle(btc, 1, start, Decimal("101"), Decimal("110"),
                   Decimal("90"), Decimal("105"), Decimal("2.5"), Decimal("230"))
    second = replace(first, collected_at=start + timedelta(minutes=1), close=Decimal("104"))
    third = replace(first, asset_id=eth, resolution=5, close=Decimal("99"))
    return [first, second, third]


async def assert_no_notifications(queue):
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(queue.get(), timeout=1)


def test_candle_batch_is_visible_when_notification_arrives(database_url):
    async def verify():
        async with database(database_url) as (store, observer, notifications, btc, eth):
            candles = batch(btc, eth)
            assert await store.save_candles(candles) == 3
            seen = set()
            expected_counts = {btc: 2, eth: 1}
            for _ in expected_counts:
                asset_id = await asyncio.wait_for(notifications.get(), timeout=5)
                assert asset_id not in seen
                seen.add(asset_id)
                assert await observer.fetchval(
                    "SELECT count(*) FROM price_candles WHERE asset_id=$1",
                    asset_id,
                ) == expected_counts[asset_id]

            rows = await observer.fetch(
                "SELECT asset_id, resolution, collected_at, open_price, high_price, low_price, "
                "close_price, volume, turnover FROM price_candles ORDER BY asset_id, collected_at")
            assert [tuple(row) for row in rows] == [
                (c.asset_id, c.resolution, c.collected_at, c.open, c.high,
                 c.low, c.close, c.volume, c.turnover)
                for c in candles]
            await assert_no_notifications(notifications)

            assert await store.save_candles(candles) == 0
            assert await observer.fetchval("SELECT count(*) FROM price_candles") == 3
            await assert_no_notifications(notifications)

    asyncio.run(verify())


def test_candle_batch_rolls_back_if_one_asset_does_not_exist(database_url):
    async def verify():
        async with database(database_url) as (store, observer, notifications, btc, eth):
            candles = batch(btc, eth)
            candles.append(replace(candles[-1], asset_id=eth + 1))
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await store.save_candles(candles)
            assert await observer.fetchval("SELECT count(*) FROM price_candles") == 0
            await assert_no_notifications(notifications)

    asyncio.run(verify())
