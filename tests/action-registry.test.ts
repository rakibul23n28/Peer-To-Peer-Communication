import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry } from '../src/auth/actionRegistry';

test('every registered action has a label and a distinct icon', () => {
  const entries = Object.entries(ActionRegistry);
  assert.ok(entries.length > 0);
  for (const [action, definition] of entries) {
    assert.equal(definition.id, action, `${action} must match its registry id`);
    assert.ok(definition.icon, `${action} must have an icon`);
    assert.ok(definition.label.trim(), `${action} must have a label`);
  }
  assert.equal(
    new Set(entries.map(([, definition]) => definition.icon)).size,
    entries.length,
    'each semantic action must use a unique icon',
  );
});
