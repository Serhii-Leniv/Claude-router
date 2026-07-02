import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../cache.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('missing'), undefined);
    assert.equal(cache.size, 2);
  });

  it('evicts the oldest entry when over capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.size, 2);
  });

  it('get refreshes recency so recently-read keys survive eviction', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now newest; 'b' is oldest
    cache.set('c', 3);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), undefined);
  });

  it('set on an existing key updates value without growing size', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('a', 10);
    assert.equal(cache.get('a'), 10);
    assert.equal(cache.size, 1);
  });

  it('maxSize 0 disables storage', () => {
    const cache = new LruCache<string, number>(0);
    cache.set('a', 1);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0);
  });

  it('clear empties the cache', () => {
    const cache = new LruCache<string, number>(5);
    cache.set('a', 1);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('a'), undefined);
  });
});
