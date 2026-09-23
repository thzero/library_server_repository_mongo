import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import '@thzero/library_common/utility/string.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';
import PlansMongoRepository from '../plans.js';

// dayjs.utc() only exists once the plugins are registered; the app does this at
// boot, so anything calling getTimestamp() outside a booted app must do it too.
LibraryMomentUtility.initDateTime();

const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

const plans = {
	free: { id: 'free', name: 'Free', roles: [ 'user' ] },
	pro: { id: 'pro', name: 'Pro', roles: [ 'user', 'pro' ] }
};

const newCollection = () => {
	const calls = { findOne: [] };
	return {
		calls,
		async findOne(query, options) {
			calls.findOne.push({ query, options });
			const plan = plans[query.id];
			return plan ? { ...plan } : null;
		}
	};
};

let repository;
let collection;

beforeEach(() => {
	mock.timers.enable({ apis: [ 'Date' ], now: 1_000_000 });
	repository = new PlansMongoRepository();
	inject(repository, '_logger', newLogger());
	inject(repository, '_config', { get: () => null });
	collection = newCollection();
	repository._getCollectionPlans = async () => collection;
});

afterEach(() => {
	mock.timers.reset();
});

describe('find', () => {
	// One plan is read with every user fetch: a second round trip on the auth
	// and profile paths, for a document that rarely changes.
	it('serves a repeated lookup from memory', async () => {
		const first = await repository.find('cid', 'free');
		const second = await repository.find('cid', 'free');
		assert.deepEqual(first.results, plans.free);
		assert.deepEqual(second.results, plans.free);
		assert.equal(collection.calls.findOne.length, 1);
	});

	it('hands out a copy, so a caller cannot change what the next caller gets', async () => {
		const first = await repository.find('cid', 'free');
		first.results.name = 'changed';
		const second = await repository.find('cid', 'free');
		assert.equal(second.results.name, 'Free');
	});

	it('applies an exclusion projection to the cached copy', async () => {
		await repository.find('cid', 'free');
		const response = await repository.find('cid', 'free', { roles: 0 });
		assert.deepEqual(response.results, { id: 'free', name: 'Free' });
		assert.equal(collection.calls.findOne.length, 1, 'still from the cache');
		const again = await repository.find('cid', 'free');
		assert.deepEqual(again.results.roles, [ 'user' ], 'the cached document kept its roles');
	});

	it('sends any other projection to the database as given', async () => {
		await repository.find('cid', 'free');
		await repository.find('cid', 'free', { name: 1 });
		assert.equal(collection.calls.findOne.length, 2);
		assert.deepEqual(collection.calls.findOne[1].options.projection, { name: 1, _id: 0 });
	});

	it('does not cache a miss', async () => {
		assert.equal((await repository.find('cid', 'nope')).results, null);
		assert.equal((await repository.find('cid', 'nope')).results, null);
		assert.equal(collection.calls.findOne.length, 2);
	});

	it('reads again once the ttl has passed', async () => {
		await repository.find('cid', 'free');
		mock.timers.tick(repository._planCacheTtlMs);
		await repository.find('cid', 'free');
		assert.equal(collection.calls.findOne.length, 1, 'inside the ttl');
		mock.timers.tick(1);
		await repository.find('cid', 'free');
		assert.equal(collection.calls.findOne.length, 2);
	});

	it('caches each plan on its own', async () => {
		await repository.find('cid', 'free');
		await repository.find('cid', 'pro');
		await repository.find('cid', 'free');
		await repository.find('cid', 'pro');
		assert.equal(collection.calls.findOne.length, 2);
	});
});

describe('invalidate', () => {
	it('drops one plan, or all of them', async () => {
		await repository.find('cid', 'free');
		await repository.find('cid', 'pro');

		repository.invalidate('free');
		await repository.find('cid', 'free');
		await repository.find('cid', 'pro');
		assert.equal(collection.calls.findOne.length, 3, 'only free was read again');

		repository.invalidate();
		await repository.find('cid', 'free');
		await repository.find('cid', 'pro');
		assert.equal(collection.calls.findOne.length, 5);
	});
});
