import { crossRate } from './parse.js';

export const RT_WINDOW_MS = 15 * 60e3;
const GAP_MS = 30e3;

export function mergeStreamTicks(quotes, incoming, now) {
  const bySymbol = new Map(Object.entries(quotes).map(([symbol, points]) =>
    [symbol, new Map(points.map((point) => [point.t, point]))]));
  for (const { symbol, t, v } of incoming) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Map());
    bySymbol.get(symbol).set(t, { t, v });
  }

  const edge = now - RT_WINDOW_MS;
  return Object.fromEntries([...bySymbol].map(([symbol, points]) => {
    const sorted = [...points.values()].sort((a, b) => a.t - b.t);
    const first = sorted.findIndex((point) => point.t >= edge);
    // Сохраняем котировку прямо перед окном для переноса цены.
    return [symbol, first === -1 ? sorted.slice(-1) : sorted.slice(Math.max(0, first - 1))];
  }));
}

export function rebuildStreamSeries({ baseSymbol, quoteSymbol, history, quotes, carried, now }) {
  const edge = now - RT_WINDOW_MS;
  const stored = [...new Map(history.filter((p) => p.t >= edge && p.t <= now)
    .map((p) => [p.t, p])).values()].sort((a, b) => a.t - b.t);
  const events = new Map();
  for (const symbol of [baseSymbol, quoteSymbol]) {
    for (const point of quotes[symbol] ?? []) {
      if (point.t > now) continue;
      if (!events.has(point.t)) events.set(point.t, {});
      events.get(point.t)[symbol] = point.v;
    }
  }
  const latest = {};
  const live = [];
  const rawBase = [];
  for (const [t, values] of [...events].sort(([a], [b]) => a - b)) {
    Object.assign(latest, values);
    if (t < edge) continue;
    const c = crossRate(latest, baseSymbol, quoteSymbol, carried);
    if (c !== null) live.push({ t, c });
    if (values[baseSymbol] !== undefined) rawBase.push({ t, c: values[baseSymbol] });
  }

  const quote = latest[quoteSymbol] ?? carried[quoteSymbol];
  const baseOnly = stored.length === 0 && rawBase.length > 0 && quote == null;
  if (baseOnly) return { points: rawBase, baseOnly, liveCount: rawBase.length };

  // Закрываем разрывы между тиками сохранёнными свечами, не смешивая их
  // с точками потока там, где секундные котировки уже есть.
  let index = 0;
  const filler = stored.filter(({ t }) => {
    while (index < live.length && live[index].t < t) index += 1;
    const before = live[index - 1]?.t ?? -Infinity;
    const after = live[index]?.t ?? Infinity;
    return Math.min(t - before, after - t) > GAP_MS;
  });
  return { points: filler.concat(live).sort((a, b) => a.t - b.t), baseOnly, liveCount: live.length };
}
