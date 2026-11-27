import exec from 'k6/execution';
import ws from 'k6/ws';
import { Counter, Rate, Trend } from 'k6/metrics';
import { prepareUsers, resultFile, stats, userFor } from './common.js';

const seconds = Number(__ENV.LOAD_WS_SECONDS || 60);
const bases = ['BTC', 'ETH', 'SOL', 'BNB', 'ADA', 'XRP', 'DOGE', 'LTC'];
const delay = new Trend('tick_delay', true);
const errors = new Rate('stream_errors');
const pacing = new Rate('tick_too_soon');
const delivered = new Counter('tick_delivered');
const scenarios = Object.fromEntries([70, 300].map((vus, index) => [`viewers_${vus}`, {
  executor: 'per-vu-iterations', vus, iterations: 1, startTime: `${index * (seconds + 15)}s`,
  maxDuration: `${seconds + 10}s`, gracefulStop: '0s',
}]));
export const options = {
  scenarios, setupTimeout: '8m', summaryTrendStats: stats,
  thresholds: Object.fromEntries(Object.keys(scenarios).flatMap((name) => [
    [`tick_delay{scenario:${name}}`, ['p(95)<1000']],
    [`stream_errors{scenario:${name}}`, ['rate<0.01']],
    [`tick_too_soon{scenario:${name}}`, ['rate==0']],
    [`tick_delivered{scenario:${name}}`, [`count>=${scenarios[name].vus * Math.max(1, seconds - 3)}`]],
  ])),
};
export const setup = () => prepareUsers({ pairs: false });

export default function (users) {
  const id = exec.vu.idInTest;
  const base = bases[(id - 1) % bases.length];
  const { token } = userFor(users, id);
  let previousSentAt;
  let hadError = false;
  let sawTick = false;
  const response = ws.connect(`ws://api:8080/api/stream?base=${base}&quote=USDT`, {
    headers: { Authorization: `Bearer ${token}` },
  }, (socket) => {
    socket.on('error', () => { hadError = true; });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type !== 'tick') return;
      const point = message.ticks.find((item) => item.symbol === base);
      if (!point) return;
      delay.add(Date.now() - point.at);
      delivered.add(1);
      sawTick = true;
      // Пакеты генератора приходят с шагом 50 мс. Два тика ближе 850 мс
      // считаем нарушением, оставляя допуск на соседние интервалы и планировщик.
      if (previousSentAt !== undefined) pacing.add(point.at - previousSentAt < 850);
      previousSentAt = point.at;
    });
    socket.setTimeout(() => socket.close(), seconds * 1000);
  });
  errors.add(response?.status !== 101 || hadError || !sawTick);
}
export const handleSummary = (data) => resultFile('websocket', data);
