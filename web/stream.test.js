import { describe, expect, it } from 'vitest';
import { crossRate } from './parse.js';
import { mergeStreamTicks, rebuildStreamSeries, RT_WINDOW_MS } from './stream.js';

const now = 2_000_000;
const edge = now - RT_WINDOW_MS;
const btc = (t, v) => ({ symbol: 'BTC', t, v });
const rub = (t, v) => ({ symbol: 'RUB', t, v });

function rebuild(quotes, options = {}) {
  return rebuildStreamSeries({ baseSymbol: 'BTC', quoteSymbol: 'RUB',
    history: [], carried: { RUB: 0.02 }, quotes, now, ...options });
}

describe('потоковый кросс-курс', () => {
  it('использует сохранённую цену RUB по обе стороны пары', () => {
    const t = now - 1000;
    const ticks = mergeStreamTicks({}, [btc(t, 50000)], now);
    expect(rebuild(ticks).points).toEqual([{ t, c: 2500000 }]);
    const inverse = rebuild(ticks, { baseSymbol: 'RUB', quoteSymbol: 'BTC' });
    expect(inverse.points).toEqual([{ t, c: 0.0000004 }]);
    expect(inverse.baseOnly).toBe(false);
  });

  it('не делит на ноль и требует цену каждой стороны', () => {
    expect(crossRate({ BTC: 10, RUB: 0 }, 'BTC', 'RUB')).toBeNull();
    expect(crossRate({ RUB: 1 }, 'BTC', 'RUB')).toBeNull();
    expect(crossRate({ BTC: 10 }, 'BTC', 'RUB')).toBeNull();
  });

  it('отсекает старые точки, сохраняя перенос цены из-за границы окна', () => {
    const ticks = mergeStreamTicks({}, [rub(edge - 1, 0.02), btc(edge - 2, 20), btc(edge, 40)], now);
    const history = [{ t: edge - 100, c: 1 }, { t: now - 3000, c: 3000 }];
    expect(rebuild(ticks, { history, carried: {} }).points).toEqual([
      { t: edge, c: 2000 }, { t: now - 3000, c: 3000 },
    ]);
  });

  it('обновляет обеими сторонами, упорядочивает точки и не дублирует время', () => {
    const t = now - 1000;
    let ticks = mergeStreamTicks({}, [btc(t, 60), rub(t - 2, 0.02)], now);
    ticks = mergeStreamTicks(ticks, [btc(t - 1, 40), btc(t, 80), rub(t + 1, 0.04)], now);
    expect(rebuild(ticks, { history: [{ t, c: 123 }] }).points).toEqual([
      { t: t - 1, c: 2000 }, { t, c: 4000 }, { t: t + 1, c: 2000 },
    ]);
  });

  it('помечает запасной ряд как цену базы и хранит только точки окна', () => {
    const ticks = mergeStreamTicks({}, [btc(edge - 10, 40), btc(edge, 50)], now);
    expect(rebuild(ticks, { carried: {} })).toEqual({
      points: [{ t: edge, c: 50 }], baseOnly: true, liveCount: 1,
    });
    expect(rebuild(ticks, { carried: { RUB: 0 } }).points).toEqual([]);
  });
});
