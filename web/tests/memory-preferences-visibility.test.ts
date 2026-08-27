import test from 'node:test'
import assert from 'node:assert/strict'

import {
  L3_WORKBENCH_SLOTS,
  canConsolidateMemoryDoc,
  isL3WorkbenchSlot,
} from '../lib/memory-workbench-slots'

test('L3 workbench exposes explicit preferences as a durable fourth slot', () => {
  assert.deepEqual(L3_WORKBENCH_SLOTS, ['recent', 'profile', 'scope', 'preferences'])
  assert.equal(isL3WorkbenchSlot('preferences'), true)
  assert.equal(isL3WorkbenchSlot('unknown'), false)
})

test('explicit preferences are editable but never auto-consolidated', () => {
  assert.equal(canConsolidateMemoryDoc('L3', 'preferences'), false)
  assert.equal(canConsolidateMemoryDoc('L3', 'recent'), true)
  assert.equal(canConsolidateMemoryDoc('L2', 'chat'), true)
})
