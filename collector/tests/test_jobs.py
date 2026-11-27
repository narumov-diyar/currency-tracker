import asyncio
from datetime import datetime, timezone
from decimal import Decimal

from collector.breaker import CircuitBreaker, State
from collector.db import Asset
from collector.errors import RequestRejectedError, TransientError
from collector.jobs import CryptoJob, FiatJob, _usable
from collector.sources import bybit, cbr, erapi

from .helpers import FakeClock, FakeSource, FakeStore, RecordingLogger, crypto, fiat, quiet_logger

# 2026-10-27 21:33:05 UTC
NOW = 1793136785.0
# Начало только что закрывшейся минуты, 21:32.
CLOSED_MS = (int(NOW) // 60 - 1) * 60_000


def kline(start_ms):
    return {"retCode": 0, "result": {"list": [
        [str(start_ms + 60_000), "2", "2", "2", "2", "1", "1"],
        [str(start_ms), "1", "3", "0.5", "2", "10", "20"],
    ]}}


def route(symbol):
    return f"{bybit.KLINE_URL}?{symbol}USDT"


def breaker(name, clock, threshold=3):
    return CircuitBreaker(name, threshold, 300, quiet_logger(), clock=clock)


def crypto_job(store, source, clock, logger=None, brk=None):
    return CryptoJob(store, source, brk or breaker("bybit", clock), asyncio.Event(),
                     logger or quiet_logger(), attempts=4, base_delay=0.001, clock=clock)


def test_crypto_cycle_saves_closed_candles_and_unit_usdt():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(1, "USDT"), crypto(2, "BTC"), crypto(3, "ETH")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS), route("ETH"): kline(CLOSED_MS)})

    delay = asyncio.run(crypto_job(store, source, clock).cycle())

    assert delay == 57  # до 21:34:02
    assert sorted(c.asset_id for c in store.saved) == [1, 2, 3]
    # На бирже нет пары USDTUSDT: запрос не делается, цена — единица.
    assert route("USDT") not in source.calls
    usdt = next(c for c in store.saved if c.asset_id == 1)
    assert usdt.open == usdt.high == usdt.low == usdt.close == Decimal(1)
    assert usdt.volume is None and usdt.turnover is None
    assert usdt.collected_at == datetime(2026, 10, 27, 21, 32, tzinfo=timezone.utc)
    btc = next(c for c in store.saved if c.asset_id == 2)
    assert btc.resolution == 1 and btc.high == Decimal("3") and btc.turnover == Decimal("20")


def test_usdt_minute_follows_exchange_candles():
    # Локальные часы ушли на две минуты вперёд, но свечи биржи — за 21:32,
    # и USDT должен лечь туда же, а не в 21:34.
    clock = FakeClock(NOW + 120)
    store = FakeStore([crypto(1, "USDT"), crypto(2, "BTC"), crypto(3, "ETH"), crypto(4, "SOL")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS), route("ETH"): kline(CLOSED_MS),
                         route("SOL"): kline(CLOSED_MS + 60_000)})

    asyncio.run(crypto_job(store, source, clock).cycle())

    usdt = next(c for c in store.saved if c.asset_id == 1)
    assert usdt.collected_at == datetime(2026, 10, 27, 21, 32, tzinfo=timezone.utc)


def test_usdt_minute_falls_back_to_local_clock():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(1, "USDT"), crypto(2, "BTC")])
    source = FakeSource({route("BTC"): RequestRejectedError("Not supported symbols")})

    asyncio.run(crypto_job(store, source, clock).cycle())

    assert [c.asset_id for c in store.saved] == [1]
    assert store.saved[0].collected_at == datetime(2026, 10, 27, 21, 32, tzinfo=timezone.utc)


def test_single_symbol_rejection_keeps_others():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(2, "BTC"), crypto(3, "TON")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS),
                         route("TON"): RequestRejectedError("Not supported symbols")})

    asyncio.run(crypto_job(store, source, clock).cycle())

    assert [c.asset_id for c in store.saved] == [2]


def test_malformed_response_keeps_others():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(2, "BTC"), crypto(3, "ETH")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS), route("ETH"): {"retCode": 0}})

    asyncio.run(crypto_job(store, source, clock).cycle())

    assert [c.asset_id for c in store.saved] == [2]


def test_unexpected_error_for_one_asset_keeps_others():
    clock = FakeClock(NOW)
    logger = RecordingLogger()
    store = FakeStore([crypto(2, "BTC"), crypto(3, "ETH"), crypto(4, "SOL")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS), route("ETH"): RuntimeError("boom"),
                         route("SOL"): kline(CLOSED_MS)})

    asyncio.run(crypto_job(store, source, clock, logger).cycle())

    assert sorted(c.asset_id for c in store.saved) == [2, 4]
    failures = [f for level, msg, f in logger.records if level == "exception"]
    assert failures == [{"source": "bybit", "symbol": "ETH",
                         "error_type": "RuntimeError", "error": "boom"}]


def test_cycle_log_reports_counts():
    clock = FakeClock(NOW)
    logger = RecordingLogger()
    store = FakeStore([crypto(1, "USDT"), crypto(2, "BTC"), crypto(3, "TON")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS),
                         route("TON"): RequestRejectedError("Not supported symbols")})

    asyncio.run(crypto_job(store, source, clock, logger).cycle())

    finished = next(f for _, msg, f in logger.records if msg == "crypto cycle finished")
    assert (finished["polled"], finished["fetched"], finished["failed"], finished["saved"]) == \
        (2, 1, 1, 2)


def test_usable_skips_unsupported_resolution():
    good = crypto(2, "BTC")
    odd = Asset(5, "ODD", "crypto", "bybit", 90, True)        # не кратно минуте
    weekly = Asset(6, "WEEK", "crypto", "bybit", 604800, True)  # нет в price_candles
    logger = RecordingLogger()

    assert _usable([good, odd, weekly], logger, "crypto") == [good]
    skipped = [f["symbol"] for level, _, f in logger.records if level == "error"]
    assert skipped == ["ODD", "WEEK"]


FIAT = [fiat(31, "USD"), fiat(33, "RUB"), fiat(32, "EUR")]
ERAPI_OK = {"result": "success", "time_last_update_unix": 1793059351,
            "rates": {"USD": 1, "RUB": 84, "EUR": 0.92}}


def fiat_job(store, source, clock, logger=None, primary=None, backup=None):
    return FiatJob(store, source, primary or breaker("er-api", clock),
                   backup or breaker("cbr", clock), asyncio.Event(), logger or quiet_logger(),
                   attempts=4, retry_interval=600, base_delay=0.001, clock=clock)


def test_fiat_cycle_stores_inverted_rates():
    clock = FakeClock(NOW)
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: ERAPI_OK})

    delay = asyncio.run(fiat_job(store, source, clock).cycle())

    prices = {c.asset_id: c.close for c in store.saved}
    assert prices == {31: Decimal("1.00000000"), 33: Decimal("0.01190476"),
                      32: Decimal("1.08695652")}
    rub = next(c for c in store.saved if c.asset_id == 33)
    assert rub.open == rub.high == rub.low == rub.close
    assert rub.volume is None and rub.turnover is None
    assert rub.resolution == 1440
    assert rub.collected_at == datetime(2026, 10, 27, tzinfo=timezone.utc)
    assert source.calls == [erapi.URL]  # один запрос на все валюты
    # Следующий цикл — в 01:00 UTC следующих суток.
    assert NOW + delay == datetime(2026, 10, 28, 1, tzinfo=timezone.utc).timestamp()


def test_fiat_failure_retries_sooner_than_a_day():
    clock = FakeClock(NOW)
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: TransientError("503")})

    assert asyncio.run(fiat_job(store, source, clock).cycle()) == 600
    assert store.saved == []


def test_fiat_missing_currency_is_logged_and_others_saved():
    clock = FakeClock(NOW)
    logger = RecordingLogger()
    store = FakeStore(fiat_assets=FIAT + [fiat(34, "XXX")])
    source = FakeSource({erapi.URL: ERAPI_OK})

    asyncio.run(fiat_job(store, source, clock, logger).cycle())

    assert len(store.saved) == 3
    missing = [f["symbols"] for _, msg, f in logger.records
               if msg == "currencies missing in response"]
    assert missing == [["XXX"]]


def test_crypto_breaker_opens_and_probes():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(2, "BTC"), crypto(3, "ETH")])
    down = TransientError("503")
    source = FakeSource({route("BTC"): down, route("ETH"): down})
    brk = breaker("bybit", clock, threshold=2)

    async def go():
        job = crypto_job(store, source, clock, brk=brk)

        await job.cycle()
        await job.cycle()
        assert brk.state is State.OPEN
        assert len(source.calls) == 2 * 2 * 4  # два цикла, два актива, четыре попытки

        source.calls.clear()
        await job.cycle()
        assert source.calls == []  # Open: к источнику не обращаемся

        clock.now += 300
        source.routes[route("BTC")] = kline(CLOSED_MS + 300_000)
        source.routes[route("ETH")] = kline(CLOSED_MS + 300_000)
        await job.cycle()
        assert brk.state is State.CLOSED
        assert source.calls[0] == route("BTC")  # пробный запрос
        assert len(store.saved) == 2

    asyncio.run(go())


def test_crypto_failed_probe_reopens_without_touching_others():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(2, "BTC"), crypto(3, "ETH")])
    down = TransientError("503")
    source = FakeSource({route("BTC"): down, route("ETH"): down})
    brk = breaker("bybit", clock, threshold=1)

    async def go():
        job = crypto_job(store, source, clock, brk=brk)
        await job.cycle()
        clock.now += 300
        source.calls.clear()
        await job.cycle()

    asyncio.run(go())
    assert source.calls == [route("BTC")]
    assert brk.state is State.OPEN


def test_crypto_single_symbol_failure_does_not_trip_breaker():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(2, "BTC"), crypto(3, "TON")])
    source = FakeSource({route("BTC"): kline(CLOSED_MS),
                         route("TON"): RequestRejectedError("Not supported symbols")})
    brk = breaker("bybit", clock, threshold=1)

    asyncio.run(crypto_job(store, source, clock, brk=brk).cycle())

    assert brk.state is State.CLOSED
    assert source.calls.count(route("TON")) == 1  # 4xx не повторяется


def test_fiat_breaker_opens_after_failed_cycles():
    clock = FakeClock(NOW)
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: TransientError("503"), cbr.URL: TransientError("503")})
    primary = breaker("er-api", clock, threshold=3)

    async def go():
        job = fiat_job(store, source, clock, primary=primary)
        delays = [await job.cycle() for _ in range(3)]
        assert delays == [600, 600, 600]
        assert primary.state is State.OPEN
        calls = source.calls.count(erapi.URL)
        await job.cycle()
        assert source.calls.count(erapi.URL) == calls  # Open: к источнику не обращаемся

    asyncio.run(go())


def test_fiat_invalid_response_is_not_retried():
    clock = FakeClock(NOW)
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: {"result": "error", "error-type": "x"}})

    asyncio.run(fiat_job(store, source, clock).cycle())

    assert source.calls == [erapi.URL]


def test_fiat_failure_does_not_affect_crypto_breaker():
    clock = FakeClock(NOW)
    store = FakeStore([crypto(2, "BTC")], FIAT)
    source = FakeSource({erapi.URL: TransientError("503"), cbr.URL: TransientError("503"),
                         route("BTC"): kline(CLOSED_MS)})
    primary, crypto_breaker = breaker("er-api", clock, 1), breaker("bybit", clock, 1)

    async def go():
        await fiat_job(store, source, clock, primary=primary).cycle()
        await crypto_job(store, source, clock, brk=crypto_breaker).cycle()

    asyncio.run(go())
    assert primary.state is State.OPEN
    assert crypto_breaker.state is State.CLOSED
    assert any(c.asset_id == 2 for c in store.saved)


CBR_OK = {"Date": "2026-10-28T11:30:00+03:00", "Valute": {"USD": {"Nominal": 1, "Value": 80}}}


def test_fiat_switches_to_cbr_when_primary_breaker_opens():
    clock = FakeClock(datetime(2026, 10, 28, 12, tzinfo=timezone.utc).timestamp())
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: TransientError("503"), cbr.URL: CBR_OK})
    primary = breaker("er-api", clock, threshold=3)

    async def go():
        job = fiat_job(store, source, clock, primary=primary)

        for _ in range(2):
            await job.cycle()
        assert cbr.URL not in source.calls  # пока Closed — резерв не трогаем
        assert store.saved == []

        await job.cycle()
        assert primary.state is State.OPEN
        assert source.calls[-1] == cbr.URL
        assert len(store.saved) == 1
        rub = store.saved[0]
        assert rub.asset_id == 33
        assert rub.resolution == 1440
        assert rub.close == Decimal("0.01250000")  # 1/80, не 80
        assert rub.collected_at == datetime(2026, 10, 28, tzinfo=timezone.utc)

        # Пока основной источник в Open, к нему не обращаемся, а резерв опрашивается.
        calls = len(source.calls)
        await job.cycle()
        assert source.calls[calls:] == [cbr.URL]

    asyncio.run(go())


def test_fiat_without_rub_skips_backup():
    clock = FakeClock(NOW)
    store = FakeStore(fiat_assets=[fiat(31, "USD")])
    source = FakeSource({erapi.URL: TransientError("503")})

    asyncio.run(fiat_job(store, source, clock, primary=breaker("er-api", clock, 1)).cycle())

    assert cbr.URL not in source.calls


def test_backup_failure_opens_its_own_breaker():
    clock = FakeClock(NOW)
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: TransientError("503"), cbr.URL: TransientError("503")})
    primary, backup = breaker("er-api", clock, 1), breaker("cbr", clock, 1)

    async def go():
        job = fiat_job(store, source, clock, primary=primary, backup=backup)
        await job.cycle()
        assert backup.state is State.OPEN
        calls = len(source.calls)
        await job.cycle()
        assert source.calls[calls:] == []  # оба источника приостановлены

    asyncio.run(go())
    assert store.saved == []


def test_fiat_does_not_save_tomorrows_cbr_rate():
    clock = FakeClock(datetime(2026, 10, 27, 23, 55, tzinfo=timezone.utc).timestamp())
    store = FakeStore(fiat_assets=FIAT)
    source = FakeSource({erapi.URL: TransientError("503"), cbr.URL: CBR_OK})
    primary = breaker("er-api", clock, threshold=1)

    asyncio.run(fiat_job(store, source, clock, primary=primary).cycle())

    assert cbr.URL in source.calls
    assert store.saved == []
