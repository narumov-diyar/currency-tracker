import exec from 'k6/execution';
import { call, endpointThresholds, password, quick, register, resultFile, stats } from './common.js';

const rates = quick ? [1, 2, 8] : [1, 2, 4, 8, 16, 24];
const seconds = quick ? 6 : 15;
const scenarios = {};
let index = 0;
for (const operation of ['login', 'register']) {
  for (const rate of rates) {
    scenarios[`${operation}_${rate}`] = {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${seconds}s`,
      startTime: `${index++ * (seconds + 5)}s`, gracefulStop: '5s',
      preAllocatedVUs: 12, maxVUs: 150, env: { OPERATION: operation },
    };
  }
}
export const options = {
  scenarios, summaryTrendStats: stats,
  thresholds: Object.assign({}, ...Object.keys(scenarios).map((name) => endpointThresholds([name], [name.split('_')[0]]))),
};
export function setup() {
  const stamp = Date.now();
  const email = `auth-${stamp}@example.test`;
  register(email);
  return { email, stamp };
}
export default function ({ email, stamp }) {
  const operation = __ENV.OPERATION;
  if (operation === 'register') email = `auth-${stamp}-${exec.scenario.name}-${exec.scenario.iterationInTest}@example.test`;
  call('POST', `/api/auth/${operation}`, {
    operation, status: operation === 'register' ? 201 : 200, data: { email, password },
  });
}
export const handleSummary = (data) => resultFile('auth', data);
