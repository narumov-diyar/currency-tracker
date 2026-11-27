import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// URL фиксирован сетью compose.load.yaml: сценарии работают только со стендом.
export const api = 'http://api:8080';
export const quick = __ENV.LOAD_QUICK === '1';
export const password = 'only-for-isolated-load-tests';
export const historyPairs = [['BTC', 'USDT'], ['ETH', 'USDT'], ['SOL', 'USDT'], ['BTC', 'RUB'], ['EUR', 'RUB']];
export const errors = new Rate('load_errors');
export const latency = new Trend('load_latency', true);
export const requests = new Counter('load_requests');
const periods = ['1h', '4h', '1d', '1w'];
export const budgets = {
  register: 300, login: 300, watchlist: 150, history: 400,
  pair_add: 150, pair_delete: 150, alert_add: 150, alert_patch: 150, alert_delete: 150,
};
export const stats = ['count', 'avg', 'med', 'p(95)', 'p(99)', 'max'];

export function headers(token) {
  const out = { 'Content-Type': 'application/json' };
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

export function call(method, path, { data, token, operation, status = 200, phase = 'steady' } = {}) {
  const tags = operation ? { name: operation, endpoint: operation, phase } : { name: 'setup', phase: 'setup' };
  const response = http.request(method, api + path, data === undefined ? null : JSON.stringify(data), {
    headers: headers(token), tags, timeout: '10s',
  });
  if (operation) {
    errors.add(response.status !== status, tags);
    latency.add(response.timings.duration, tags);
    requests.add(1, tags);
  } else if (response.status !== status) {
    throw new Error(`${method} ${path}: expected ${status}, got ${response.status}: ${response.body}`);
  }
  return response;
}

export function register(email) {
  return call('POST', '/api/auth/register', { data: { email, password }, status: 201 }).json('token');
}

export function historyPath(pair, period) {
  return `/api/history?base=${pair[0]}&quote=${pair[1]}&period=${period}&mode=cross`;
}

export function prepareUsers({ pairs = true } = {}) {
  const count = Number(__ENV.LOAD_USERS || 200);
  if (!Number.isInteger(count) || count < 1) throw new Error('LOAD_USERS must be a positive integer');
  const stamp = Date.now();
  const users = [];
  for (let i = 0; i < count; i++) {
    const email = `load-${stamp}-${i}@example.test`;
    const token = register(email);
    users.push({ email, token });
    if (i === 0) {
      const deadline = Date.now() + 120000;
      for (;;) {
        const missing = periods.filter((period) =>
          !call('GET', historyPath(historyPairs[0], period), { token }).json('cross.points')?.length);
        if (missing.length === 0) break;
        if (Date.now() >= deadline) throw new Error(`Seed/rollup: empty history for ${missing.join(', ')}`);
        sleep(0.5);
      }
      console.log(`История проверена: ${periods.join(', ')}`);
    }
    if (pairs) {
      for (const [base, quote] of historyPairs) {
        call('POST', '/api/watchlist', { token, data: { base, quote }, status: 201 });
      }
    }
  }
  return users;
}

export function userFor(users, vu) {
  return users[(vu - 1) % users.length];
}

export function checkedRead(operation, user, fraction, phase) {
  if (operation === 'watchlist') {
    return call('GET', '/api/watchlist', { token: user.token, operation, phase });
  }
  const pair = historyPairs[Math.floor(fraction * historyPairs.length)];
  const validPeriods = pair[0] === 'EUR' ? ['1d', '1w'] : periods;
  const period = validPeriods[Math.floor(Math.random() * validPeriods.length)];
  return call('GET', historyPath(pair, period), { token: user.token, operation, phase });
}

export function endpointThresholds(scenarios, operations) {
  const out = {};
  for (const scenario of scenarios) {
    out[`load_errors{scenario:${scenario},phase:steady}`] = ['rate<0.01'];
    out[`dropped_iterations{scenario:${scenario}}`] = ['count==0'];
    out[`load_requests{scenario:${scenario},phase:steady}`] = ['count>0'];
    for (const endpoint of operations) {
      out[`load_latency{scenario:${scenario},endpoint:${endpoint},phase:steady}`] =
        [`p(95)<=${budgets[endpoint]}`];
      out[`load_requests{scenario:${scenario},endpoint:${endpoint},phase:steady}`] = ['count>0'];
    }
  }
  return out;
}

export function resultFile(name, summary) {
  const metrics = summary.metrics;
  const lines = Object.entries(metrics).filter(([metric]) =>
    metric.startsWith('load_') || metric.startsWith('dropped_iterations')
      || metric.startsWith('tick_') || metric.startsWith('stream_'));
  return {
    [`/results/${name}.json`]: JSON.stringify(summary, null, 2),
    stdout: lines.map(([metric, { values }]) => `${metric} ${JSON.stringify(values)}`).join('\n') + '\n',
  };
}
