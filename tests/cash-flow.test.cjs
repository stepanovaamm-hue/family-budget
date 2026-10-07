const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
function extract(name) {
  const start = html.indexOf('function ' + name + '(');
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
const september = {openingBalance: 0, transactions: [
  {id: 'salary', type: 'income', date: '2026-09-18', plan: 100, paid: true},
  {id: 'paid', type: 'expense', date: '2026-09-20', plan: 20, paid: true},
  {id: 'planned', type: 'expense', date: '2026-09-22', plan: 50, paid: false}
]};
const october = {openingBalance: 0, transactions: [
  {id: 'receipt', type: 'income', date: '2026-10-05', plan: 200, paid: false},
  {id: 'early', type: 'expense', date: '2026-10-12', paidDate: '2026-10-06', plan: 30, paid: true},
  {id: 'next', type: 'income', date: '2026-10-10', plan: 50, paid: false}
]};
const elements = {};
const context = {
  state: {selectedMonth: '2026-10', months: {'2026-09': september, '2026-10': october}, filter: 'all'},
  realToday: new Date(2026, 9, 7), month: () => october,
  sortTx: list => [...list].sort((a, b) => a.date.localeCompare(b.date)),
  parseDate: date => new Date(date + 'T00:00:00'),
  amountOf: tx => Number(tx.actual ?? tx.plan),
  amountForecast: tx => Number(tx.paid ? tx.actual ?? tx.plan : tx.plan),
  iso: (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  effectiveToday: () => context.realToday,
  fullDate: new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'short'}),
  formatMoney: value => value + ' ₽',
  monthKeyFrom: date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
  localDateKey: () => '2026-10-07',
  save() {}, render() {}, showToast() {},
  $: id => elements[id] ?? (elements[id] = {}), plural: () => 'операций',
  renderBudgetCalendar() {}, renderTransactionPeriods() {}, renderNextMonthPreview() {},
  isSalaryIncome: tx => tx.type === 'income'
};
vm.createContext(context);
vm.runInContext(html.match(/const hasRecordedExpense =[^\r\n]+/)[0], context);
vm.runInContext(html.match(/const cashFlowDate =[^\r\n]+/)[0], context);
for (const name of ['adjacentMonthKey', 'budgetStartDay', 'periodActualKey', 'periodActualBalance',
  'getPeriodRanges', 'openingBalanceForMonth', 'actualCashBalance', 'monthClosingBalance',
  'forecastCashFlows', 'calculate', 'togglePaid', 'renderTransactions']) vm.runInContext(extract(name), context);
const run = code => vm.runInContext(code, context);
assert.equal(run('openingBalanceForMonth()'), 80, 'Carry actual cash, ignoring unpaid plans');
assert.equal(run('calculate().balanceNow'), 50, 'Deduct early payment, ignore unreceived income');
assert.equal(run('calculate().end'), 300, 'Future income belongs to forecast only');
run("togglePaid('receipt')");
assert.equal(october.transactions[0].paidDate, '2026-10-07');
assert.equal(run('calculate().balanceNow'), 250, 'Confirmed income increases cash');
run("togglePaid('receipt')");
assert.equal(run('calculate().balanceNow'), 50, 'Undo receipt decreases cash');
october.cashBaseline = {date: '2026-10-05', amount: 90, includedTransactionIds: ['receipt']};
assert.equal(run('calculate().balanceNow'), 60, 'Deduct spending after cash baseline');
run("togglePaid('receipt')");
assert.equal(run('calculate().balanceNow'), 260, 'New receipt after old baseline is not skipped');
assert.equal(run('calculate().end'), 310, 'Forecast also includes new receipt after baseline');
run("togglePaid('receipt')");
delete october.cashBaseline;
september.periodActualBalances = {'2026-09-18': 70};
assert.equal(run('openingBalanceForMonth()'), 70, 'Carry manually recorded actual period close');
delete september.periodActualBalances;
run('renderTransactions()');
assert.equal(elements['#operationsBalanceNow'].textContent, '50 ₽');
assert(elements['#operationsBalanceLabel'].textContent.includes('сегодня'));
run("togglePaid('early'); renderTransactions()");
assert.equal(elements['#operationsBalanceNow'].textContent, '80 ₽', 'Live balance updates after undo');
run("togglePaid('early')");
october.transactions.push({id:'partial',type:'expense',date:'2026-10-10',paidDate:'2026-10-06',plan:40,actual:20,paid:false});
assert.equal(run('calculate().balanceNow'), 30, 'Partial fact is deducted even while balance remains unpaid');
assert.equal(run('calculate().end'), 260, 'Forecast includes both partial fact and remaining obligation');
assert.equal(run('calculate().untilIncome'), 30, 'Remaining payment due on payday is not reserved twice before it');
run("togglePaid('early')");
assert.equal(run('calculate().balanceNow'), 60, 'Undo removes recorded fact, including auto-filled amount');
context.editingTransaction = 'partial';
context.transactionPeriod = null;
context.calculateMoneyExpression = Number;
context.clearErrors = () => {};
context.closeDialog = () => {};
context.FormData = class { constructor(form) {this.fields=form.fields;} get(key) {return this.fields[key] ?? '';} };
context.event = {preventDefault() {}, currentTarget: {fields: {name:'Газпром',date:'2026-10-10',plan:'40',actual:'20',type:'expense'},elements: {paid: {checked:false}}}};
vm.runInContext(extract('submitTransaction'), context);
run('submitTransaction(event)');
assert.equal(october.transactions.find(tx=>tx.id==='partial').paidDate, '2026-10-06', 'Editing preserves payment date');
delete october.transactions.find(tx=>tx.id==='partial').paidDate;
run('submitTransaction(event)');
assert.equal(october.transactions.find(tx=>tx.id==='partial').paidDate, '2026-10-07', 'Early partial payment gets current date');
console.log('Cash-flow regression checks passed');
