from datetime import datetime, timezone
from decimal import Decimal

import pytest

from collector.candles import parse_decimal, unit_price
from collector.errors import InvalidResponseError, RequestRejectedError, TransientError
from collector.sources import bybit, cbr, erapi

from .helpers import crypto

BTC = crypto(2, "BTC")

KLINE = {
    "retCode": 0, "retMsg": "OK",
    "result": {"category": "spot", "symbol": "BTCUSDT", "list": [
        ["1793136780000", "81149.2", "81303.9", "81139.2", "81209",
         "21.663285", "1760186.48668064"],
        ["1793136720000", "81155.1", "81224.2", "81135.7", "81149.2",
         "25.998076", "2110325.3958895"],
    ]},
}


def test_kline_takes_second_candle():
    candle = bybit.parse_kline(KLINE, BTC, now_ms=1793136835945)

    assert candle.asset_id == 2
    assert candle.resolution == 1
    assert candle.collected_at == datetime(2026, 10, 27, 21, 32, tzinfo=timezone.utc)
    assert candle.open == Decimal("81155.1")
    assert candle.high == Decimal("81224.2")
    assert candle.low == Decimal("81135.7")
    assert candle.close == Decimal("81149.2")
    assert candle.volume == Decimal("25.998076")
    assert candle.turnover == Decimal("2110325.3958895")


def test_kline_params():
    assert bybit.kline_params("BTC") == {
        "category": "spot", "symbol": "BTCUSDT", "interval": "1", "limit": "2"}


def test_kline_rejects_unclosed_candle():
    with pytest.raises(InvalidResponseError):
        bybit.parse_kline(KLINE, BTC, now_ms=1793136720000 + 59_999)


def test_kline_accepts_candle_closed_exactly_now():
    assert bybit.parse_kline(KLINE, BTC, now_ms=1793136720000 + 60_000).asset_id == 2


@pytest.mark.parametrize("code,error", [
    (10006, TransientError),
    (10016, TransientError),
    (10001, RequestRejectedError),
])
def test_kline_error_codes(code, error):
    with pytest.raises(error):
        bybit.parse_kline({"retCode": code, "retMsg": "x", "result": {}}, BTC, now_ms=0)


@pytest.mark.parametrize("payload", [
    [],
    None,
    {"retCode": 0},
    {"retCode": 0, "result": {"list": []}},
    {"retCode": 0, "result": {"list": [KLINE["result"]["list"][0]]}},
    {"retCode": 0, "result": {"list": [["1"], ["2", "1", "1"]]}},
    {"retCode": 0, "result": {"list": [KLINE["result"]["list"][0],
                                       ["0", "x", "1", "1", "1", "1", "1"]]}},
    {"retCode": 0, "result": {"list": [KLINE["result"]["list"][0],
                                       ["0", "-1", "1", "1", "1", "1", "1"]]}},
])
def test_kline_rejects_malformed(payload):
    with pytest.raises(InvalidResponseError):
        bybit.parse_kline(payload, BTC, now_ms=10**13)


@pytest.mark.parametrize("raw,expected", [
    ("81149.2", Decimal("81149.2")),
    (1, Decimal("1")),
    ("0", Decimal("0")),
    ("1e-8", Decimal("1e-8")),
])
def test_parse_decimal(raw, expected):
    assert parse_decimal(raw) == expected


@pytest.mark.parametrize("raw", ["-1", "abc", "", None, "NaN", "Infinity", [1]])
def test_parse_decimal_rejects(raw):
    with pytest.raises(InvalidResponseError):
        parse_decimal(raw)


def test_unit_price_inverts_rate():
    # 84 рубля за доллар — это 1/84 доллара за рубль, а не 84.
    assert unit_price(84) == Decimal("0.01190476")
    assert unit_price("1") == Decimal("1.00000000")
    assert unit_price(0.92) == Decimal("1.08695652")


def test_unit_price_keeps_cross_rate_direction():
    # Кросс-курс считается делением цен: BTC/RUB должен выйти миллионами.
    btc, rub = Decimal("81000"), unit_price(80)
    assert btc / rub == Decimal("6480000")


@pytest.mark.parametrize("rate", [0, -1, "abc", 10**12, 10**-11])
def test_unit_price_rejects_unusable_rates(rate):
    with pytest.raises(InvalidResponseError):
        unit_price(rate)


ERAPI = {
    "result": "success",
    "time_last_update_unix": 1793059351,
    "rates": {"USD": 1, "RUB": 84, "EUR": 0.92, "JPY": 150.5},
}


def test_erapi_inverts_and_filters():
    day, prices = erapi.parse_latest(ERAPI, ["USD", "RUB", "EUR", "BYN"])

    assert day == datetime(2026, 10, 27, tzinfo=timezone.utc)
    assert prices == {
        "USD": Decimal("1.00000000"),
        "RUB": Decimal("0.01190476"),
        "EUR": Decimal("1.08695652"),
    }


@pytest.mark.parametrize("payload", [
    {"result": "error", "error-type": "unsupported-code"},
    {"result": "success", "rates": {"RUB": 84}},
    {"result": "success", "time_last_update_unix": 1, "rates": []},
    [],
])
def test_erapi_rejects_bad_responses(payload):
    with pytest.raises(InvalidResponseError):
        erapi.parse_latest(payload, ["RUB"])


def test_erapi_day_start():
    moment = datetime(2026, 10, 27, 23, 59, 59, tzinfo=timezone.utc)
    assert erapi.day_start(moment) == datetime(2026, 10, 27, tzinfo=timezone.utc)


CBR = {
    "Date": "2026-10-28T11:30:00+03:00",
    "Valute": {"USD": {"CharCode": "USD", "Nominal": 1, "Value": 84.0}},
}


def test_cbr_rub_price():
    day, price = cbr.parse_daily(CBR, now=datetime(2026, 10, 28, tzinfo=timezone.utc))

    assert day == datetime(2026, 10, 28, tzinfo=timezone.utc)
    assert price == Decimal("0.01190476")


def test_cbr_respects_nominal():
    payload = {"Date": CBR["Date"], "Valute": {"USD": {"Nominal": 10, "Value": 840}}}
    _, price = cbr.parse_daily(payload, now=datetime(2026, 10, 28, tzinfo=timezone.utc))
    assert price == Decimal("0.01190476")


@pytest.mark.parametrize("payload", [
    {"Valute": {}},
    {"Date": CBR["Date"], "Valute": {"EUR": {"Nominal": 1, "Value": 90}}},
    {"Date": "not a date", "Valute": CBR["Valute"]},
    {"Date": CBR["Date"], "Valute": {"USD": {"Nominal": 0, "Value": 84}}},
    [],
])
def test_cbr_malformed(payload):
    with pytest.raises(InvalidResponseError):
        cbr.parse_daily(payload)


@pytest.mark.parametrize(("field", "value"), [
    (1, "0"), (2, "99999999999"), (3, "0"), (4, "0"),
    (4, "99999999999"), (4, "0.000000001"),
    (5, "10000000000000000"), (6, "10000000000000000"),
])
def test_kline_rejects_values_outside_storage_range(field, value):
    rows = KLINE["result"]["list"]
    closed = rows[1].copy()
    closed[field] = value
    payload = {**KLINE, "result": {**KLINE["result"], "list": [rows[0], closed]}}
    with pytest.raises(InvalidResponseError):
        bybit.parse_kline(payload, BTC, now_ms=1793136835945)


@pytest.mark.parametrize("bad_rate", [0, "abc", "1e-40"])
def test_erapi_skips_only_invalid_currency(bad_rate, caplog):
    payload = {**ERAPI, "rates": {**ERAPI["rates"], "RUB": bad_rate}}
    _, prices = erapi.parse_latest(payload, ["USD", "RUB", "EUR"])
    assert prices == {"USD": Decimal("1.00000000"), "EUR": Decimal("1.08695652")}
    assert "RUB" in caplog.text


def test_erapi_rejects_response_when_all_requested_rates_are_invalid():
    payload = {**ERAPI, "rates": {"RUB": 0}}
    with pytest.raises(InvalidResponseError):
        erapi.parse_latest(payload, ["RUB"])


def test_cbr_skips_future_day_until_utc_midnight():
    assert cbr.parse_daily(CBR, now=datetime(2026, 10, 27, 23, 59, tzinfo=timezone.utc)) is None
    day, _ = cbr.parse_daily(CBR, now=datetime(2026, 10, 28, tzinfo=timezone.utc))
    assert day == datetime(2026, 10, 28, tzinfo=timezone.utc)
