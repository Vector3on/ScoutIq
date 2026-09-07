import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, makeEvent, Clock, decodeHlc, makeRng, shortHash } from '../core/events.mjs';

test('canonical JSON sorts keys, drops undefined, rejects non-finite', () => {
  assert.equal(canonicalize({ b: 1, a: [3, { z: 1, y: undefined }] }), '{"a":[3,{"z":1}],"b":1}');
  assert.throws(() => canonicalize({ x: Infinity }), /non-finite/);
});

test('events are content-addressed and immutable', () => {
  const c = new Clock('n1', () => 1000);
  const hlc = c.tick();
  const a = makeEvent({ node: 'n1', seq: 1, hlc, kind: 'note.recorded', ts: 1000, body: { text: 'x', k: [1, 2] } });
  const b = makeEvent({ node: 'n1', seq: 1, hlc, kind: 'note.recorded', ts: 1000, body: { k: [1, 2], text: 'x' } });
  assert.equal(a.id, b.id, 'same content → same id regardless of key order');
  assert.throws(() => { a.body.text = 'y'; }, /read only|Cannot assign/);
  assert.throws(() => makeEvent({ node: 'n1', seq: 1, hlc, kind: 'nope', ts: 1, body: {} }), /unknown event kind/);
  assert.throws(() => makeEvent({ node: 'n1', seq: 0, hlc, kind: 'note.recorded', ts: 1, body: {} }), /seq/);
});

test('hybrid logical clock is monotone, sorts lexicographically, and absorbs remote clocks', () => {
  let t = 5000;
  const c = new Clock('alpha', () => t);
  const h1 = c.tick(), h2 = c.tick();
  assert.ok(h1 < h2);
  assert.deepEqual(decodeHlc(h2), { wall: 5000, logical: 1, node: 'alpha' });
  t = 4000; // wall clock went backwards
  const h3 = c.tick();
  assert.ok(h3 > h2, 'never goes backwards');
  const remote = new Clock('beta', () => 9000).tick();
  c.observe(remote);
  const h4 = c.tick();
  assert.ok(h4 > remote, 'local ticks sort after observed remote events');
  assert.throws(() => new Clock('bad node!'), /bad node/);
});

test('seeded RNG is deterministic and forks independently', () => {
  const a = makeRng('seed'), b = makeRng('seed');
  assert.equal(a(), b());
  assert.equal(a.int(10), b.int(10));
  const f1 = a.fork('x')(), f2 = b.fork('x')();
  assert.equal(f1, f2);
  assert.notEqual(makeRng('seed').fork('x')(), makeRng('seed').fork('y')());
  assert.equal(shortHash('abc').length, 32);
});
