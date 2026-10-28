import { describe, it, expect } from 'vitest';
import {
  parseHistory,
  parseStreamMessage,
  crossRate,
  buildAlertPayload,
  describeAlert,
  errorText,
} from './parse.js';

// Ответы взяты с работающего сервера, а не придуманы: разойтись с контрактом
// здесь проще всего, и график тогда молча остаётся пустым.
const compareResponse = {
  period: '1h',
  mode: 'compare',
  base: {
    symbol: 'BTC',
    resolution: 1,
    candles: [
      [1792584000000, '76306.13', '76400.00', '76200.00', '76350.42', '12.5'],
      [1792584060000, '76350.42', '76500.00', '76300.00', '76480.10', '9.1'],
    ],
  },
  quote: { symbol: 'USDT', resolution: 1, candles: [[1792584000000, '1', '1', '1', '1', null]] },
  analytics: { base_change: 0.23, quote_change: 0, change_diff: 0.23, correlation: null },
};

const crossResponse = {
  period: '1w',
  mode: 'cross',
  cross: { pair: 'BTC/USDT', resolution: 60, points: [[1792584000000, '76306.13637145']] },
  analytics: { base_change: 1.1 },
};

describe('parseHistory', () => {
  it('читает свечи обеих сторон в режиме сравнения', () => {
    const { series, analytics } = parseHistory(compareResponse, 'compare');

    expect(series.map((s) => s.symbol)).toEqual(['BTC', 'USDT']);
    expect(series[0].resolution).toBe(1);
    expect(series[0].points).toHaveLength(2);
    expect(series[0].points[0]).toEqual({
      t: 1792584000000,
      o: 76306.13,
      h: 76400,
      l: 76200,
      c: 76350.42,
    });
    expect(analytics.change_diff).toBe(0.23);
  });

  it('читает один рассчитанный ряд в режиме кросс-курса', () => {
    const { series } = parseHistory(crossResponse, 'cross');

    expect(series).toHaveLength(1);
    expect(series[0].symbol).toBe('BTC/USDT');
    expect(series[0].points[0].c).toBeCloseTo(76306.13637145, 6);
  });

  // Ряды лежат во вложенных полях, а не верхним уровнем ответа. Попытка взять
  // их из res.points или res.candles даёт пустой массив и пустой график.
  it('не ищет данные верхним уровнем ответа', () => {
    expect(crossResponse.points).toBeUndefined();
    expect(crossResponse.candles).toBeUndefined();
    expect(compareResponse.series).toBeUndefined();
  });

  it('возвращает пустой набор, когда данных за период нет', () => {
    const { series } = parseHistory({ period: '1h', mode: 'cross', analytics: {} }, 'cross');
    expect(series).toEqual([]);
  });
});

describe('parseStreamMessage', () => {
  it('разбирает снимок окна', () => {
    const msg = parseStreamMessage('{"type":"snapshot","symbol":"BTC","points":[[1000,"76300.5"]]}');

    expect(msg.type).toBe('snapshot');
    expect(msg.symbol).toBe('BTC');
    expect(msg.points).toEqual([{ t: 1000, v: 76300.5 }]);
  });

  it('разбирает порцию котировок по обеим сторонам', () => {
    const msg = parseStreamMessage({
      type: 'tick',
      ticks: [
        { symbol: 'BTC', price: '76400.00', at: 2000 },
        { symbol: 'USDT', price: '1.00000000', at: 2000 },
      ],
    });

    expect(msg.type).toBe('tick');
    expect(msg.ticks).toHaveLength(2);
    expect(msg.ticks[0]).toEqual({ symbol: 'BTC', v: 76400, t: 2000 });
  });

  it('не падает на неизвестном сообщении', () => {
    expect(parseStreamMessage('не json').type).toBe('unknown');
    expect(parseStreamMessage({ hello: 1 }).type).toBe('unknown');
  });
});

describe('crossRate', () => {
  it('делит цены сторон', () => {
    expect(crossRate({ BTC: 76400, RUB: 0.0119 }, 'BTC', 'RUB')).toBeCloseTo(6420168, 0);
  });

  // У фиатной стороны потокового режима нет, сервер её не присылает.
  it('отдаёт цену базового актива, если котируемый не передаётся', () => {
    expect(crossRate({ BTC: 76400 }, 'BTC', 'RUB')).toBe(76400);
  });

  it('молчит, пока не пришла первая котировка базового актива', () => {
    expect(crossRate({}, 'BTC', 'USDT')).toBeNull();
  });
});

describe('buildAlertPayload', () => {
  it('раскладывает порог на тип условия и направление', () => {
    expect(buildAlertPayload({ kind: 'above', value: 95000, targetType: 'asset', symbol: 'BTC' }))
      .toEqual({
        target_type: 'asset',
        symbol: 'BTC',
        condition_type: 'threshold',
        direction: 'above',
        target_value: '95000',
      });
  });

  it('добавляет окно наблюдения процентному правилу', () => {
    const payload = buildAlertPayload({
      kind: 'drop', value: 3, windowMinutes: '60', targetType: 'pair', pairId: 7,
    });

    expect(payload).toEqual({
      target_type: 'pair',
      pair_id: 7,
      condition_type: 'percent',
      direction: 'below',
      target_value: '3',
      window_minutes: 60,
    });
  });
});

describe('describeAlert', () => {
  it('убирает хвост нулей из numeric', () => {
    expect(describeAlert({ condition_type: 'threshold', direction: 'above', target_value: '95000.00000000' }))
      .toBe('выше 95000');
    expect(describeAlert({ condition_type: 'percent', direction: 'below', target_value: '3.00000000', window_minutes: 10 }))
      .toBe('падение более 3 % за 10 мин');
  });
});

describe('errorText', () => {
  // Сервер кладёт причину в поле error, а не message.
  it('берёт причину из поля error', () => {
    expect(errorText({ error: 'pair already exists' })).toBe('pair already exists');
    expect(errorText({ message: 'не оттуда' })).toBe('Ошибка сервера');
    expect(errorText(null, 'нет связи')).toBe('нет связи');
  });
});
