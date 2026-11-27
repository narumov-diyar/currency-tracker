"""Классификация ошибок HTTP без сети и реальной aiohttp-сессии."""

import asyncio

import aiohttp
import pytest

from collector.errors import InvalidResponseError, RequestRejectedError, TransientError
from collector.httpclient import json_fetcher

URL = "https://example.test/rates"
PARAMS = {"symbol": "BTCUSDT"}


class FakeResponse:
    def __init__(self, status, body, content_type="application/json"):
        self.status = status
        self.body = body
        self.headers = {"Content-Type": content_type}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def text(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, *, params):
        self.calls.append((url, params))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


@pytest.mark.parametrize("content_type", ["application/json", "application/javascript"])
def test_fetch_parses_body_and_passes_parameters(content_type):
    session = FakeSession(FakeResponse(200, '{"price":"1.25"}', content_type))
    assert asyncio.run(json_fetcher(session)(URL, PARAMS)) == {"price": "1.25"}
    assert session.calls == [(URL, PARAMS)]


@pytest.mark.parametrize("status,error", [
    (429, TransientError), (500, TransientError), (502, TransientError), (503, TransientError),
    (400, RequestRejectedError), (401, RequestRejectedError),
    (403, RequestRejectedError), (404, RequestRejectedError),
])
def test_fetch_classifies_status(status, error):
    session = FakeSession(FakeResponse(status, "<html>error</html>"))
    with pytest.raises(error, match=f"HTTP {status}") as raised:
        asyncio.run(json_fetcher(session)(URL, PARAMS))
    assert type(raised.value) is error
    assert session.calls == [(URL, PARAMS)]


@pytest.mark.parametrize("response", [
    asyncio.TimeoutError(),
    aiohttp.ClientConnectionError("offline"),
    FakeResponse(200, aiohttp.ClientPayloadError("truncated")),
])
def test_fetch_classifies_transport_errors(response):
    session = FakeSession(response)
    with pytest.raises(TransientError) as raised:
        asyncio.run(json_fetcher(session)(URL, PARAMS))
    assert type(raised.value) is TransientError
    assert session.calls == [(URL, PARAMS)]


def test_fetch_rejects_broken_json():
    session = FakeSession(FakeResponse(200, '{"incomplete":'))
    with pytest.raises(InvalidResponseError, match="malformed JSON"):
        asyncio.run(json_fetcher(session)(URL))
    assert session.calls == [(URL, None)]
