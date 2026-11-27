import exec from 'k6/execution';
import { call, checkedRead, endpointThresholds, password, prepareUsers, quick, resultFile, stats, userFor } from './common.js';

const soak = __ENV.LOAD_CASE === 'soak';
const seconds = Number(__ENV.LOAD_MIX_SECONDS || 300);
const scenario = (rate, timeUnit, duration, startTime = '0s') => ({
  executor: 'constant-arrival-rate', rate, timeUnit, duration, startTime,
  preAllocatedVUs: 12, maxVUs: 80, gracefulStop: '10s',
});
const scenarios = soak
  ? { hold: scenario(20, '1s', `${__ENV.LOAD_SOAK_SECONDS || 1800}s`) }
  : { peak: scenario(15, '2s', `${seconds}s`), ceiling: scenario(20, '1s', `${seconds}s`, `${seconds + 10}s`) };
const endpoints = ['watchlist', 'history', 'login'];
if (!quick) endpoints.push('pair_add', 'pair_delete', 'alert_add', 'alert_patch', 'alert_delete');

export const options = {
  scenarios,
  setupTimeout: '8m',
  summaryTrendStats: stats,
  thresholds: endpointThresholds(Object.keys(scenarios), endpoints),
};

export const setup = () => prepareUsers();
let pairID;
let alertID;
let alertPatched;

function editPair(user) {
  if (pairID) {
    const response = call('DELETE', `/api/watchlist/${pairID}`,
      { token: user.token, operation: 'pair_delete', status: 204 });
    if (response.status === 204) pairID = undefined;
    return;
  }
  const response = call('POST', '/api/watchlist', {
    token: user.token, data: { base: 'SOL', quote: 'ETH' }, operation: 'pair_add', status: 201,
  });
  if (response.status === 201) pairID = response.json('id');
}

function editAlert(user) {
  if (!alertID) {
    const response = call('POST', '/api/alerts', {
      token: user.token, operation: 'alert_add', status: 201,
      data: { target_type: 'asset', symbol: 'BTC', condition_type: 'threshold', direction: 'above', target_value: '100000' },
    });
    if (response.status === 201) alertID = response.json('id');
  } else if (!alertPatched) {
    const response = call('PATCH', `/api/alerts/${alertID}`, {
      token: user.token, operation: 'alert_patch', data: { target_value: '101000' },
    });
    alertPatched = response.status === 200;
  } else {
    const response = call('DELETE', `/api/alerts/${alertID}`, {
      token: user.token, operation: 'alert_delete', status: 204,
    });
    if (response.status === 204) {
      alertID = undefined;
      alertPatched = false;
    }
  }
}

export default function (users) {
  const user = userFor(users, exec.vu.idInTest);
  const pick = Math.random();
  if (pick < 0.61) checkedRead('watchlist', user, Math.random(), 'steady');
  else if (pick < 0.86) checkedRead('history', user, Math.random(), 'steady');
  else if (pick < 0.98) call('POST', '/api/auth/login', {
    operation: 'login', data: { email: user.email, password },
  });
  else if (pick < 0.99) editPair(user);
  else editAlert(user);
}

export const handleSummary = (data) => resultFile(soak ? 'soak' : 'mix', data);
