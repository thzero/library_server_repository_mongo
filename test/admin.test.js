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
	const calls = { aggregate: [], find: [], findOne: [], replaceOne: [], insertOne: [], deleteOne: [] };
	return {
		calls,
		// Honours $skip and $limit so a paged search returns a page; a $count
		// pipeline answers with the full size.
		aggregate(pipeline) {
			calls.aggregate.push(pipeline);
			const counting = pipeline.some(stage => stage.$count);
			const skip = (pipeline.find(stage => stage.$skip) ?? {}).$skip ?? 0;
			const limit = (pipeline.find(stage => stage.$limit) ?? {}).$limit;
			const page = docs.slice(skip, limit === undefined ? undefined : skip + limit);
			return { toArray: async () => (counting ? [ { count: docs.length } ] : page) };
		},
		async find(query, options) { calls.find.push({ query, options }); return { toArray: async () => docs }; },
		async findOne(query, options) { calls.findOne.push({ query, options }); return docs.find(doc => doc.id === query.id) ?? null; },
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
	// It used to fetch every match with find and keep the first.
	it('asks for one document and reports success', async () => {
		const response = await repository.fetch('cid', 'a');
		assert.deepEqual(response.results, { id: 'a' });
		assert.equal(response.success, true);
		assert.equal(collection.calls.findOne.length, 1);
		assert.equal(collection.calls.find.length, 0);
	});

	it('reports failure when nothing matched', async () => {
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

	// Regression: the whole pipeline, projections included, ran a second time
	// with a $count on the end, to count what the first run had just fetched.
	it('unpaged, runs one query with a single projection and no count', async () => {
		await repository.search('cid', {});
		assert.equal(collection.calls.aggregate.length, 1);
		const pipeline = collection.calls.aggregate[0];
		assert.equal(pipeline.some(stage => stage.$count), false);
		assert.equal(pipeline.some(stage => stage.$skip || stage.$limit), false);
		// the search projection, then the one _aggregate2 appends
		assert.deepEqual(pipeline.filter(stage => stage.$project), [ { $project: { _id: 0 } }, { $project: { _id: 0 } } ]);
	});
});

describe('search, paged', () => {
	const docs = [ { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' } ];

	beforeEach(() => {
		collection = newCollection(docs);
		repository = new TestAdminRepository(collection, session);
		inject(repository, '_logger', newLogger());
		inject(repository, '_config', { get: () => null });
		repository._searchQueryAdditional = (query) => { query.push({ $match: { extra: true } }); };
	});

	it('returns the page with the full total', async () => {
		const response = await repository.search('cid', { skip: 1, limit: 2 });
		assert.deepEqual(response.results.data, [ { id: 'b' }, { id: 'c' } ]);
		assert.equal(response.results.count, 2);
		assert.equal(response.results.total, 5);
	});

	it('counts over the match stages only, and pages the data before projecting', async () => {
		await repository.search('cid', { skip: 1, limit: 2, sort: { id: -1 } });
		assert.equal(collection.calls.aggregate.length, 2);
		const [ count, data ] = collection.calls.aggregate;

		assert.deepEqual(count, [ { $match: { mine: true } }, { $match: { extra: true } }, { $project: { _id: 1 } }, { $count: 'count' } ],
			'the filter and the subclass stages, then the count; no search projection');

		const names = data.map(stage => Object.keys(stage)[0]);
		assert.deepEqual(names, [ '$match', '$match', '$sort', '$skip', '$limit', '$project', '$project' ]);
		assert.deepEqual(data[2], { $sort: { id: -1 } });
		assert.deepEqual(data[3], { $skip: 1 });
		assert.deepEqual(data[4], { $limit: 2 });
	});

	it('a limit alone, or a skip alone, is paged', async () => {
		await repository.search('cid', { limit: 2 });
		assert.equal(collection.calls.aggregate.length, 2);
		collection.calls.aggregate.length = 0;
		await repository.search('cid', { skip: 4 });
		assert.equal(collection.calls.aggregate.length, 2);
	});

	it('ignores paging values that are not usable', async () => {
		await repository.search('cid', { skip: '1', limit: 0, sort: {} });
		assert.equal(collection.calls.aggregate.length, 1, 'unpaged');
		const names = collection.calls.aggregate[0].map(stage => Object.keys(stage)[0]);
		assert.deepEqual(names, [ '$match', '$match', '$project', '$project' ]);
	});

	it('a sort without a page does not trigger a count', async () => {
		await repository.search('cid', { sort: { id: 1 } });
		assert.equal(collection.calls.aggregate.length, 1);
		assert.deepEqual(collection.calls.aggregate[0][2], { $sort: { id: 1 } });
	});
});
