import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderBudget } from '../src/quality.js';

function run(budget, fps, seconds) {
  let transitions = 0;
  for (let i = 0; i < fps * seconds; i++) transitions += Number(budget.sample(1 / fps));
  return transitions;
}

test('touch, compact and reduced-motion layouts start with the lighter renderer', () => {
  for (const options of [{ compact: true }, { coarsePointer: true }, { reducedMotion: true }]) {
    const budget = new RenderBudget(options);
    assert.equal(budget.low, true);
    assert.equal(run(budget, 60, 30), 0);
    assert.equal(budget.low, true);
  }
});

test('sustained slow rendering degrades once and cannot oscillate after recovery', () => {
  const budget = new RenderBudget();
  assert.equal(run(budget, 30, 8), 1);
  assert.equal(budget.low, true);
  assert.equal(run(budget, 60, 30), 0);
  assert.equal(run(budget, 30, 8), 0);
  assert.equal(budget.low, true);
});

test('startup, a single slow interval and a restored tab do not force a downgrade', () => {
  const budget = new RenderBudget();
  budget.sample(2);
  run(budget, 30, 3.1);
  run(budget, 60, 4);
  assert.equal(budget.low, false);
  budget.resetWindow();
  budget.sample(20);
  run(budget, 60, 8);
  assert.equal(budget.low, false);
});
