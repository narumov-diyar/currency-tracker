import exec from 'k6/execution';
import { checkedRead, endpointThresholds, prepareUsers, quick, resultFile, stats, userFor } from './common.js';

const maximum = Number(__ENV.LOAD_MAX_RATE || 360);
if (!Number.isInteger(maximum) || maximum < 20) throw new Error('LOAD_MAX_RATE must be an integer >= 20');
const rates = [...new Set([20, 40, 80, 150, 220, 300, maximum].filter((rate) => rate <= maximum))];
const ramp = quick ? 2 : 5;
const hold = quick ? 6 : 20;
export const options = {
  setupTimeout: '8m',
  summaryTrendStats: stats,
  scenarios: Object.fromEntries(rates.map((target, index) => [`rps_${target}`, {
    executor: 'ramping-arrival-rate', startRate: rates[index - 1] ?? target, timeUnit: '1s',
    startTime: `${index * (ramp + hold + 5)}s`, gracefulStop: '5s',
    preAllocatedVUs: Math.min(40, target), maxVUs: 400,
    stages: [{ target, duration: `${ramp}s` }, { target, duration: `${hold}s` }],
  }])),
  thresholds: endpointThresholds(rates.map((rate) => `rps_${rate}`), ['history', 'watchlist']),
};
export const setup = () => prepareUsers();
export default function (users) {
  const phase = Date.now() - exec.scenario.startTime < ramp * 1000 ? 'ramp' : 'steady';
  checkedRead(Math.random() < 0.7 ? 'watchlist' : 'history', userFor(users, exec.vu.idInTest), Math.random(), phase);
}
export const handleSummary = (data) => resultFile('capacity', data);
