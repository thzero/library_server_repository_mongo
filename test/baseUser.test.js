import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';
import BaseUserMongoRepository from '../baseUser.js';

// dayjs.utc() only exists once the plugins are registered; the app does this at
// boot, so anything calling getTimestamp() outside a booted app must do it too.
LibraryMomentUtility.initDateTime();

const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

// A users collection holding one user. findOneAndUpdate applies $set to a copy
// and returns it, or null when the id does not match, as the driver does with
// returnDocument: 'after'.
const newCollection = (user) => {
	const calls = { findOne: [], findOneAndUpdate: [], replaceOne: [] };
	return {
		calls,
		async findOne(query, options) {
			calls.findOne.push({ query, options });
			return Object.values(query)[0] === Object.values(user)[0] ? { ...user } : null;
		},
		async findOneAndUpdate(filter, update, options) {
			calls.findOneAndUpdate.push({ filter, update, options });
			if (filter.id !== user.id)
				return null;
			return { ...user, ...update.$set };
		},
		async replaceOne(filter, value, options) { calls.replaceOne.push({ filter, value, options }); return { modifiedCount: 1 }; }
	};
};

const user = { id: 'u1', planId: 'free', settings: { theme: 'dark' } };

let repository;
let collection;
let planFinds;

beforeEach(() => {
	repository = new BaseUserMongoRepository();
	inject(repository, '_logger', newLogger());
	inject(repository, '_config', { get: () => null });
	collection = newCollection({ ...user });
	repository._getCollectionUsers = async () => collection;
	// None of these paths may check out a session any more.
	repository._getClient = async () => { throw new Error('no session should be started'); };
	planFinds = [];
	repository._repositoryPlans = {
		async find(correlationId, planId, project) {
			planFinds.push({ planId, project });
			return { success: true, results: { id: planId, name: 'Free' } };
		}
	};
});

describe('fetch', () => {
	it('attaches the plan the plans repository resolves', async () => {
		const response = await repository.fetch('cid', 'u1');
		assert.equal(response.success, true);
		assert.deepEqual(response.results.plan, { id: 'free', name: 'Free' });
		assert.deepEqual(planFinds, [ { planId: 'free', project: undefined } ]);
	});

	it('skips the plan when asked to', async () => {
		const response = await repository.fetch('cid', 'u1', true);
		assert.equal(response.results.plan, undefined);
		assert.equal(planFinds.length, 0);
	});

	it('reports a missing user as a failure and asks for no plan', async () => {
		const response = await repository.fetch('cid', 'nobody');
		assert.equal(response.success, false);
		assert.equal(planFinds.length, 0);
	});

	it('the other lookups leave roles off the plan', async () => {
		await repository.fetchByExternalId('cid', 'u1');
		assert.deepEqual(planFinds[0].project, { roles: 0 });
	});
});

describe('updateSettings', () => {
	// Regression: findOne, then replaceOne of the whole document to change two
	// fields, inside a transaction that never received the session.
	it('is one round trip that sets the settings and the timestamp', async () => {
		const before = LibraryMomentUtility.getTimestamp();
		const response = await repository.updateSettings('cid', 'u1', { theme: 'light' });

		assert.equal(collection.calls.findOne.length, 0);
		assert.equal(collection.calls.replaceOne.length, 0);
		assert.equal(collection.calls.findOneAndUpdate.length, 1);

		const call = collection.calls.findOneAndUpdate[0];
		assert.deepEqual(call.filter, { id: 'u1' });
		assert.deepEqual(call.update.$set.settings, { theme: 'light' });
		assert.ok(call.update.$set.updatedTimestamp >= before);
		assert.equal(Object.keys(call.update.$set).length, 2, 'nothing else is touched');
		assert.deepEqual(call.options, { returnDocument: 'after', projection: { _id: 0 } });

		assert.equal(repository._hasSucceeded(response), true);
		assert.deepEqual(response.results.settings, { theme: 'light' });
		assert.equal(response.results.planId, 'free', 'the rest of the document comes back as written');
	});

	it('returns null results for a user that does not exist, as before', async () => {
		const response = await repository.updateSettings('cid', 'nobody', { theme: 'light' });
		assert.equal(repository._hasSucceeded(response), true);
		assert.equal(response.results, null);
	});

	it('turns a driver failure into an error response', async () => {
		collection.findOneAndUpdate = async () => { throw new Error('boom'); };
		const response = await repository.updateSettings('cid', 'u1', {});
		assert.equal(repository._hasFailed(response), true);
	});
});

describe('updatePlan', () => {
	// Regression: this read the user, set planId on the copy and returned it
	// without writing, so a plan change was never persisted.
	it('writes the plan id and the timestamp in one round trip', async () => {
		const response = await repository.updatePlan('cid', 'u1', 'pro');
		assert.equal(collection.calls.findOneAndUpdate.length, 1);
		assert.equal(collection.calls.findOneAndUpdate[0].update.$set.planId, 'pro');
		assert.ok(collection.calls.findOneAndUpdate[0].update.$set.updatedTimestamp);
		assert.equal(repository._hasSucceeded(response), true);
		assert.equal(response.results.planId, 'pro');
	});

	it('errors for a user that does not exist', async () => {
		const response = await repository.updatePlan('cid', 'nobody', 'pro');
		assert.equal(repository._hasFailed(response), true);
	});
});

describe('refreshSettings', () => {
	// Regression: a session checkout and an empty transaction around one findOne.
	it('is a single read', async () => {
		const response = await repository.refreshSettings('cid', 'u1');
		assert.equal(collection.calls.findOne.length, 1);
		assert.deepEqual(collection.calls.findOne[0].query, { id: 'u1' });
		assert.equal(response.results.id, 'u1');
	});

	it('turns a driver failure into an error response', async () => {
		collection.findOne = async () => { throw new Error('boom'); };
		const response = await repository.refreshSettings('cid', 'u1');
		assert.equal(repository._hasFailed(response), true);
	});
});
