const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  let end = html.indexOf('{', start) + 1, depth = 1;
  while (depth) {
    if (html[end] === '{') depth++;
    if (html[end] === '}') depth--;
    end++;
    assert(end <= html.length, name);
  }
  return html.slice(start, end);
}
const context = {
  state: { selectedMonth: '2026-10' },
  realToday: new Date(2026, 9, 20),
  parseDate: value => new Date(value + 'T00:00:00'),
  monthKeyFrom: date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
  fullDate: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }),
  monthFormat: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }),
  formatMoney: value => `${value} ₽`, escapeHtml: value => String(value),
  save() { throw new Error('Summary must not write financial state'); }
};
vm.createContext(context);
for (const name of ['amountOf', 'amountForecast', 'hasRecordedExpense', 'cashFlowDate']) {
  vm.runInContext(html.match(new RegExp(`const ${name} =[^\\r\\n]+`))[0], context);
}
for (const name of ['forecastCashFlows', 'isSavingsTx', 'budgetStartDay', 'monthDate', 'monthlySummary', 'renderMonthlySummary']) {
  vm.runInContext(extract(name), context);
}
const run = code => vm.runInContext(code, context);
context.calculation = {
  now: context.realToday, balanceNow: 28000, end: 43000,
  txs: [
    { type: 'income', date: '2026-10-05', plan: 100000, actual: 95000, paid: true },
    { type: 'income', date: '2026-10-25', plan: 30000, paid: false },
    { type: 'expense', date: '2026-10-06', plan: 20000, actual: 22000, paid: true },
    { id: 'loan', type: 'expense', date: '2026-10-25', paidDate: '2026-10-10', plan: 40000, actual: 20000, paid: false },
    { type: 'expense', category: ' Копилка ', date: '2026-10-12', plan: 5000, paid: true },
    { type: 'expense', category: 'Копилка', date: '2026-10-25', plan: 10000, paid: false },
    { type: 'expense', date: '2026-10-21', plan: 7000, paid: true }
  ]
};
context.calculate = () => context.calculation;
const original = JSON.stringify(context.calculation);
let result = run('monthlySummary()');
assert.equal(result.incomeActual, 95000, 'Only received income is actual');
assert.equal(result.incomeTotal, 125000, 'Full month combines received income and future income');
assert.equal(result.expenseActual, 42000, 'Partial payment is actual, future paid date is excluded today');
assert.equal(result.expenseTotal, 69000, 'Partial fact and remaining obligation counted once');
assert.equal(result.savingsActual, 5000);
assert.equal(result.savingsTotal, 15000, 'Savings excluded from regular expense total');
assert.equal(result.monthSurplus, 41000, 'Monthly income minus costs minus savings');
assert.equal(result.freeNow, 28000, 'Use established actual balance, including reconciliation');
assert.equal(result.freeEnd, 43000, 'Use established forecast, without subtracting savings twice');
assert.equal(JSON.stringify(context.calculation), original, 'Calculating summary is read-only');

context.container = { innerHTML: '', querySelector: () => null };
run('renderMonthlySummary(container, calculation, true)');
assert(context.container.innerHTML.includes('class="month-report" open'));
assert(context.container.innerHTML.includes('Факт на'));
assert(context.container.innerHTML.includes('Расходы без копилки'));
assert(context.container.innerHTML.includes('41000 ₽'));
assert(context.container.innerHTML.includes('43000 ₽'));
context.container.querySelector = () => ({ open: false });
run('renderMonthlySummary(container, calculation, true)');
assert(!context.container.innerHTML.includes('class="month-report" open'), 'Keep user-collapsed state on rerender');
context.container.querySelector = () => ({ open: true });
run('renderMonthlySummary(container, calculation)');
assert(context.container.innerHTML.includes('class="month-report" open'), 'Keep user-expanded state on rerender');

context.state.selectedMonth = '2026-11';
context.calculation = { now: new Date(1900, 0, 1), txs: [], balanceNow: 2000, end: 2000 };
result = run('monthlySummary()');
assert.equal(result.incomeTotal, 0);
assert.equal(result.expenseTotal, 0);
assert.equal(result.savingsTotal, 0);
assert.equal(result.monthSurplus, 0);
assert.equal(result.freeEnd, 2000, 'Empty month retains carry');
run('renderMonthlySummary(container)');
assert(context.container.innerHTML.includes('ноябрь'));
assert(!context.container.innerHTML.includes('Факт на'), 'Other month is not labelled as today');
context.calculation.end = -100;
run('renderMonthlySummary(container)');
assert(context.container.innerHTML.includes('class="negative">-100 ₽'));
console.log('Monthly summary checks passed');
