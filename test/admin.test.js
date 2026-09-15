import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';
import BaseAdminMongoRepository from '../admin/index.js';

LibraryMomentUtility.initDateTime();

const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

const newCollection = (docs = []) => {
	const calls = { aggregate: [], find: [], replaceOne: [], insertOne: [], deleteOne: [] };
	return {
		calls,
		aggregate(pipeline) {
			calls.aggregate.push(pipeline);
			const counting = pipeline.some(stage => stage.$count);
			return { toArray: async () => (counting ? [ { count: docs.length } ] : docs) };
		},
		async find(query, options) { calls.find.push({ query, options }); return { toArray: async () => docs }; },
		async replaceOne(filter, value, options) { calls.replaceOne.push({ filter, value, options }); return { modifiedCount: 1 }; },
		async insertOne(value) { calls.insertOne.push(value); return { insertedId: 'x' }; },
		async deleteOne(query) { calls.deleteOne.push(query); return { deletedCount: 1 }; }
	};
};

// A session that records the order of the calls made against it.
const newSession = () => {
	const events = [];
	return {
		events,
		async abortTransaction() { events.push('abort'); },
		async commitTransaction() { events.push('commit'); },
		async endSession() { events.push('end'); },
		startTransaction() { events.push('start'); }
	};
};

class TestAdminRepository extends BaseAdminMongoRepository {
	constructor(collection, session) {
		super();
		this._collection = collection;
		this._session = session;
		this.searchFilterCalls = 0;
	}
	async _getClient() { return { startSession: async () => this._session }; }
	async _transactionInit() { return this._session; }
	async _getCollectionAdmin() { return this._collection; }
	_searchFilter(correlationId, params, defaultFilter) {
		this.searchFilterCalls++;
		return { ...defaultFilter, mine: true };
	}
}

let collection;
let session;
let repository;

beforeEach(() => {
	collection = newCollection([ { id: 'a' } ]);
	session = newSession();
	repository = new TestAdminRepository(collection, session);
	inject(repository, '_logger', newLogger());
	inject(repository, '_config', { get: () => null });
});

describe('create', () => {
	it('commits and returns the inserted value', async () => {
		const response = await repository.create('cid', 'u1', { name: 'a' });
		assert.equal(repository._hasSucceeded(response), true);
		assert.deepEqual(session.events, [ 'start', 'commit', 'end' ]);
		assert.equal(collection.calls.insertOne.length, 1);
	});

	// Regression: this call omitted correlationId entirely, so the response that
	// came back could not be tied to the request that produced it.
	it('carries the correlationId when creation is not allowed', async () => {
		Object.defineProperty(repository, '_allowsCreate', { get: () => false });
		const response = await repository.create('cid-123', 'u1', {});
		assert.equal(repository._hasFailed(response), true);
		assert.equal(response.correlationId, 'cid-123');
	});

	// Regression: the abort was handed a seventh argument, and _transactionAbort
	// only takes six.
	it('aborts rather than commits when the insert fails', async () => {
		collection.insertOne = async () => { throw new Error('boom'); };
		const response = await repository.create('cid', 'u1', {});
		assert.equal(repository._hasFailed(response), true);
		assert.deepEqual(session.events, [ 'start', 'abort', 'end' ]);
	});
});

describe('update', () => {
	it('commits and returns the updated value', async () => {
		const response = await repository.update('cid', 'u1', { id: 'a', name: 'b' });
		assert.equal(repository._hasSucceeded(response), true);
		assert.deepEqual(session.events, [ 'start', 'commit', 'end' ]);
	});

	// Regression: correlationId was passed twice, so the session argument landed in
	// the message slot and `correlationId.abortTransaction()` threw - the
	// transaction was left open and only _transactionEnd closed it.
	it('actually aborts the session when the update fails', async () => {
		collection.replaceOne = async () => ({ modifiedCount: 0, upsertedCount: 0 });
		const response = await repository.update('cid', 'u1', { id: 'a' });
		assert.equal(repository._hasFailed(response), true);
		assert.deepEqual(session.events, [ 'start', 'abort', 'end' ]);
	});

	it('carries the correlationId when updating is not allowed', async () => {
		Object.defineProperty(repository, '_allowsUpdate', { get: () => false });
		const response = await repository.update('cid-123', 'u1', { id: 'a' });
		assert.equal(repository._hasFailed(response), true);
		assert.equal(response.correlationId, 'cid-123');
	});
});

describe('delete', () => {
	it('deletes by id', async () => {
		const response = await repository.delete('cid', 'a');
		assert.equal(response.success, true);
		assert.deepEqual(collection.calls.deleteOne[0], { id: 'a' });
	});

	it('carries the correlationId when deleting is not allowed', async () => {
		Object.defineProperty(repository, '_allowsDelete', { get: () => false });
		const response = await repository.delete('cid-123', 'a');
		assert.equal(repository._hasFailed(response), true);
		assert.equal(response.correlationId, 'cid-123');
	});
});

describe('fetch', () => {
	it('returns the first match and reports success', async () => {
		const response = await repository.fetch('cid', 'a');
		assert.deepEqual(response.results, { id: 'a' });
		assert.equal(response.success, true);
	});

	it('reports failure when nothing matched', async () => {
		collection.find = async () => ({ toArray: async () => [] });
		const response = await repository.fetch('cid', 'zz');
		assert.equal(response.results, null);
		assert.equal(response.success, false);
	});
});

describe('search', () => {
	// Regression: _searchFilter was called twice - once into a local that was then
	// discarded, and once inline in the $match stage.
	it('builds the filter exactly once', async () => {
		await repository.search('cid', {});
		assert.equal(repository.searchFilterCalls, 1);
	});

	it('uses that filter as the $match stage', async () => {
		await repository.search('cid', {});
		assert.deepEqual(collection.calls.aggregate[0][0], { $match: { mine: true } });
	});

	it('returns total, count and data', async () => {
		const response = await repository.search('cid', {});
		assert.equal(response.results.total, 1);
		assert.equal(response.results.count, 1);
		assert.deepEqual(response.results.data, [ { id: 'a' } ]);
	});
});
