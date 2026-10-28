// Разбор ответов сервера. Вынесено из main.js отдельным файлом, чтобы
// проверять тестами без браузера и DOM: именно здесь легче всего разойтись
// с контрактом API и нарисовать пустой график, ничего не заметив.

// Свечи и точки приходят массивами без имён полей: при нескольких сотнях
// значений повторяющиеся ключи занимают больше места, чем сами числа.
// Порядок свечи: время в миллисекундах, открытие, максимум, минимум,
// закрытие, объём. Порядок точки кросс-курса: время, курс.
//
// Цены приходят строками, потому что numeric(18,8) не укладывается в double
// без потери значащих цифр. Для рисования они приводятся к числу, но для
// отображения лучше брать исходную строку.

export function parseHistory(res, mode) {
  if (!res) return { series: [], analytics: null };

  const series = [];

  if (mode === 'cross') {
    const cross = res.cross;
    if (cross) {
      series.push({
        symbol: cross.pair,
        resolution: cross.resolution,
        points: (cross.points || []).map(([t, rate]) => ({ t, c: Number(rate) })),
      });
    }
  } else {
    for (const side of [res.base, res.quote]) {
      if (!side) continue;
      series.push({
        symbol: side.symbol,
        resolution: side.resolution,
        points: (side.candles || []).map(([t, o, h, l, c]) => ({
          t,
          o: Number(o),
          h: Number(h),
          l: Number(l),
          c: Number(c),
        })),
      });
    }
  }

  return { series, analytics: res.analytics || null };
}

// Поток шлёт два вида сообщений: снимок накопленного окна при подключении
// и порцию свежих котировок. В одном сообщении приходят обе стороны пары.
export function parseStreamMessage(raw) {
  let msg;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { type: 'unknown' };
  }

  if (msg && msg.type === 'snapshot') {
    return {
      type: 'snapshot',
      symbol: msg.symbol,
      points: (msg.points || []).map(([t, price]) => ({ t, v: Number(price) })),
    };
  }

  if (msg && msg.type === 'tick') {
    return {
      type: 'tick',
      ticks: (msg.ticks || []).map((tick) => ({
        symbol: tick.symbol,
        v: Number(tick.price),
        t: tick.at,
      })),
    };
  }

  return { type: 'unknown' };
}

// Курс пары — отношение цен сторон. Котируемая сторона может не иметь
// потокового режима: у фиатной валюты котировок внутри суток нет, и сервер
// её просто не присылает. Тогда ряд показывает цену базового актива в USDT,
// и подпись должна об этом говорить.
export function crossRate(latest, baseSymbol, quoteSymbol) {
  const base = latest[baseSymbol];
  if (base === undefined) return null;

  const quote = latest[quoteSymbol];
  if (quote === undefined) return base;
  if (!quote) return null;
  return base / quote;
}

const KINDS = {
  above: { condition_type: 'threshold', direction: 'above' },
  below: { condition_type: 'threshold', direction: 'below' },
  growth: { condition_type: 'percent', direction: 'above' },
  drop: { condition_type: 'percent', direction: 'below' },
};

export function buildAlertPayload({ kind, value, windowMinutes, targetType, symbol, pairId }) {
  const shape = KINDS[kind];
  if (!shape) throw new Error('Неизвестный тип правила: ' + kind);

  const payload = {
    target_type: targetType,
    condition_type: shape.condition_type,
    direction: shape.direction,
    // Значение передаётся строкой: на сервере это numeric, а не число
    // с плавающей точкой.
    target_value: String(value),
  };

  if (targetType === 'asset') payload.symbol = symbol;
  else payload.pair_id = pairId;

  if (shape.condition_type === 'percent') payload.window_minutes = Number(windowMinutes);

  return payload;
}

export function describeAlert(rule) {
  const value = trimZeros(rule.target_value);

  if (rule.condition_type === 'percent') {
    const word = rule.direction === 'above' ? 'рост более' : 'падение более';
    return `${word} ${value} % за ${rule.window_minutes || '?'} мин`;
  }
  return `${rule.direction === 'above' ? 'выше' : 'ниже'} ${value}`;
}

// Значения приходят из numeric(18,8), то есть всегда с восемью нулями.
export function trimZeros(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : String(value);
}

// Сервер сообщает причину отказа полем error.
export function errorText(data, fallback = 'Ошибка сервера') {
  if (typeof data === 'string' && data) return data;
  return (data && data.error) || fallback;
}
