"""Проверка записи сборщика в настоящую изолированную базу PostgreSQL."""

import asyncio
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest

from collector.candles import flat_candle
from collector.db import Store


def test_collector_writes_candle_and_notifies_server():
    dsn = os.getenv("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL не задан")
    asyncio.run(_verify_store(dsn))


async def _verify_store(dsn):
    schema = "collector_test_" + uuid4().hex
    admin = await asyncpg.connect(dsn)
    pool = None
    listener = None
    try:
        await admin.execute(f'CREATE SCHEMA "{schema}"')
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2,
                                         server_settings={"search_path": schema})
        migration = Path("internal/storage/migrations/0001_init.sql").read_text(encoding="utf-8")
        await pool.execute(migration)
        asset_id = await pool.fetchval(
            "INSERT INTO assets (symbol, type, source, resolution_seconds, supports_realtime) "
            "VALUES ('BTC', 'crypto', 'bybit', 60, true) RETURNING id")
        listener = await asyncpg.connect(dsn)
        notification = asyncio.get_running_loop().create_future()

        def on_candle(_connection, _pid, _channel, payload):
            if not notification.done():
                notification.set_result(json.loads(payload))

        await listener.add_listener("candles", on_candle)
        candle = flat_candle(asset_id, 1, datetime.now(timezone.utc), Decimal("123.45"))
        store = Store(pool)
        assert await store.save_candles([candle]) == 1
        assert await store.save_candles([candle]) == 0
        assert await pool.fetchval("SELECT count(*) FROM price_candles") == 1
        assert (await asyncio.wait_for(notification, timeout=5))["asset_id"] == asset_id
    finally:
        if listener:
            await listener.close()
        if pool:
            await pool.close()
        await admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        await admin.close()
