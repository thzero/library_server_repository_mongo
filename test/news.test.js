import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import NewsMongoRepository from '../news.js';

const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

// A collection whose cursor records what was asked of it.
const newCollection = (docs) => {
	const calls = { find: [], sort: [], limit: [], count: 0 };
	const cursor = {
		sort(value) { calls.sort.push(value); return cursor; },
		skip() { return cursor; },
		limit(value) { calls.limit.push(value); return cursor; },
		async toArray() { return docs; }
	};
	return {
		calls,
		find(query, options) { calls.find.push({ query, options }); return cursor; },
		async countDocuments() { calls.count++; return docs.length; }
	};
};

let repository;
let collection;

const newRepository = (docs = [ { id: 1 } ]) => {
	repository = new NewsMongoRepository();
	inject(repository, '_logger', newLogger());
	inject(repository, '_config', { get: () => null });
	collection = newCollection(docs);
	repository._getCollectionNews = async () => collection;
};

beforeEach(() => newRepository());

describe('latest', () => {
	// Regression: every matching document was read into memory, unsorted and
	// unlimited.
	it('sorts sticky first then newest, and limits the read', async () => {
		const response = await repository.latest('cid', 100, { authenticated: true, limit: 50 });
		assert.equal(repository._hasSucceeded(response), true);
		assert.deepEqual(collection.calls.sort, [ { sticky: -1, timestamp: -1 } ]);
		assert.deepEqual(collection.calls.limit, [ 50 ]);
		assert.equal(collection.calls.count, 0, 'no count query');
		assert.deepEqual(response.results.data, [ { id: 1 } ]);
		assert.equal(response.results.count, 1);
	});

	it('leaves out news that requires auth in the query for an anonymous caller', async () => {
		await repository.latest('cid', 100, { authenticated: false, limit: 50 });
		assert.deepEqual(collection.calls.find[0].query.$and[2], { requiresAuth: { $ne: true } });
	});

	it('does not filter on requiresAuth for a signed in caller', async () => {
		await repository.latest('cid', 100, { authenticated: true, limit: 50 });
		assert.equal(collection.calls.find[0].query.$and.length, 2);
	});

	it('reads everything with no limit, as before, when none is given', async () => {
		await repository.latest('cid', 100);
		assert.deepEqual(collection.calls.limit, []);
	});

	it('turns a database error into a failed response', async () => {
		repository._getCollectionNews = async () => { throw new Error('down'); };
		const response = await repository.latest('cid', 100, { limit: 50 });
		assert.equal(repository._hasFailed(response), true);
	});
});
