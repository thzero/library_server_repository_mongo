import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';
import MongoRepository from '../index.js';

// dayjs.utc() only exists once the plugins are registered; the app does this at
// boot, so anything calling getTimestamp() outside a booted app must do it too.
LibraryMomentUtility.initDateTime();

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

// The base class has carried _config and _logger as prototype getters and as
// plain fields at different versions; defineProperty plants an own property that
// works against either shape.
const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

// dotted-path config lookup, the shape this._config.get(path, default) expects
const newConfig = (tree) => ({
	get(path, fallback = null) {
		let node = tree;
		for (const part of path.split('.')) {
			if (node === null || node === undefined)
				return fallback;
			node = node[part];
		}
		return node === undefined ? fallback : node;
	}
});

// Records what the driver was handed.
const newCollection = (docs = []) => {
	const calls = { aggregate: [], find: [], findOne: [], replaceOne: [], insertOne: [], deleteOne: [], countDocuments: [], sort: [], skip: [], limit: [] };
	return {
		calls,
		aggregate(pipeline) {
			calls.aggregate.push(pipeline);
			// $count produces a single { count } document
			const counting = pipeline.some(stage => stage.$count);
			const results = counting ? [ { count: docs.length } ] : docs;
			return { toArray: async () => results };
		},
		async find(query, options) {
			calls.find.push({ query, options });
			// A cursor that honours skip and limit, so a paged fetch returns a page.
			const state = { skip: 0, limit: undefined };
			const cursor = {
				sort(spec) { calls.sort.push(spec); return cursor; },
				skip(n) { calls.skip.push(n); state.skip = n; return cursor; },
				limit(n) { calls.limit.push(n); state.limit = n; return cursor; },
				toArray: async () => docs.slice(state.skip, state.limit === undefined ? undefined : state.skip + state.limit)
			};
			return cursor;
		},
		async findOne(query, options) { calls.findOne.push({ query, options }); return docs[0] ?? null; },
		async replaceOne(filter, value, options) { calls.replaceOne.push({ filter, value, options }); return { modifiedCount: 1 }; },
		async insertOne(value) { calls.insertOne.push(value); return { insertedId: 'x' }; },
		async deleteOne(query) { calls.deleteOne.push(query); return { deletedCount: 1 }; },
		async countDocuments(query) { calls.countDocuments.push(query); return docs.length; }
	};
};

let repository;

beforeEach(() => {
	// the client and db caches are static, so they leak between tests
	MongoRepository._client = {};
	MongoRepository._db = {};

	repository = new MongoRepository();
	inject(repository, '_logger', newLogger());
	inject(repository, '_config', newConfig({}));
});

describe('_aggregate', () => {
	// Regression: the pipeline stages were pushed onto the caller's array, so a
	// query reused across calls accumulated a $project stage every time. That is
	// why _aggregateExtract2 used to cloneDeep both queries before calling in.
	it('does not mutate the query it is handed', async () => {
		const query = [ { $match: { a: 1 } } ];
		const collection = newCollection();
		await repository._aggregate('cid', collection, query);
		await repository._aggregate('cid', collection, query);
		assert.deepEqual(query, [ { $match: { a: 1 } } ], 'the caller keeps its one stage');
	});

	it('appends a single _id projection', async () => {
		const collection = newCollection();
		await repository._aggregate('cid', collection, [ { $match: { a: 1 } } ]);
		assert.deepEqual(collection.calls.aggregate[0], [ { $match: { a: 1 } }, { $project: { '_id': 0 } } ]);
	});

	it('_aggregate2 also leaves the query alone', async () => {
		const query = [ { $match: { a: 1 } } ];
		const collection = newCollection();
		await repository._aggregate2('cid', collection, query);
		await repository._aggregate2('cid', collection, query);
		assert.deepEqual(query, [ { $match: { a: 1 } } ]);
	});

	it('_aggregateCount also leaves the query alone and counts', async () => {
		const query = [ { $match: { a: 1 } } ];
		const collection = newCollection([ {}, {}, {} ]);
		assert.equal(await repository._aggregateCount('cid', collection, query), 3);
		assert.deepEqual(query, [ { $match: { a: 1 } } ]);
	});

	it('_aggregateCount returns 0 when the pipeline matched nothing', async () => {
		const collection = { aggregate: () => ({ toArray: async () => [] }) };
		assert.equal(await repository._aggregateCount('cid', collection, []), 0);
	});
});

describe('_aggregateExtract2', () => {
	it('fills total, data and count from the two pipelines', async () => {
		const collection = newCollection([ { id: 'a' }, { id: 'b' } ]);
		const response = repository._initResponseExtract('cid');
		await repository._aggregateExtract2('cid', collection, [], [], response);
		assert.equal(response.total, 2);
		assert.equal(response.count, 2);
		assert.deepEqual(response.data, [ { id: 'a' }, { id: 'b' } ]);
	});
});

describe('_create', () => {
	it('stamps created and updated with the same timestamp', async () => {
		const collection = newCollection();
		const response = await repository._create('cid', collection, 'u1', { name: 'a' });
		const value = response.results;
		assert.equal(value.createdTimestamp, value.updatedTimestamp, 'one reading of the clock, not two');
		assert.equal(value.createdUserId, 'u1');
		assert.equal(value.updatedUserId, 'u1');
		assert.equal(collection.calls.insertOne[0], value);
	});

	it('generates an id only when one was not supplied', async () => {
		const collection = newCollection();
		const supplied = await repository._create('cid', collection, 'u1', { id: 'given' });
		assert.equal(supplied.results.id, 'given');
		const generated = await repository._create('cid', collection, 'u1', {});
		assert.ok(generated.results.id, 'an id was generated');
		assert.notEqual(generated.results.id, 'given');
	});
});

describe('_update', () => {
	// Regression: this passed { upsert: true }, so replaceOne on a filter that
	// matched nothing quietly inserted a new document with the caller's id.
	it('does not upsert', async () => {
		const collection = newCollection();
		await repository._update('cid', collection, 'u1', 'id1', { name: 'a' });
		assert.deepEqual(collection.calls.replaceOne[0].options, { upsert: false });
		assert.deepEqual(collection.calls.replaceOne[0].filter, { id: 'id1' });
	});

	it('stamps the updated fields and returns the value', async () => {
		const collection = newCollection();
		const response = await repository._update('cid', collection, 'u1', 'id1', { name: 'a' });
		assert.equal(response.results.updatedUserId, 'u1');
		assert.ok(response.results.updatedTimestamp);
	});

	it('fails when nothing was modified', async () => {
		const collection = newCollection();
		collection.replaceOne = async () => ({ modifiedCount: 0, upsertedCount: 0 });
		const response = await repository._update('cid', collection, 'u1', 'id1', {});
		assert.equal(repository._hasFailed(response), true);
	});
});

describe('_checkUpdate', () => {
	it('succeeds on a modification or an upsert', () => {
		assert.equal(repository._hasSucceeded(repository._checkUpdate('cid', { modifiedCount: 1 })), true);
		assert.equal(repository._hasSucceeded(repository._checkUpdate('cid', { upsertedCount: 1 })), true);
	});

	it('fails on no results and on an untouched document', () => {
		assert.equal(repository._hasFailed(repository._checkUpdate('cid', null)), true);
		assert.equal(repository._hasFailed(repository._checkUpdate('cid', { modifiedCount: 0, upsertedCount: 0 })), true);
	});
});

describe('_find and _findOne', () => {
	it('suppress _id by default', async () => {
		const collection = newCollection();
		await repository._find('cid', collection, { a: 1 });
		await repository._findOne('cid', collection, { a: 1 });
		assert.deepEqual(collection.calls.find[0].options.projection, { '_id': 0 });
		assert.deepEqual(collection.calls.findOne[0].options.projection, { '_id': 0 });
	});

	it('keep _id when the caller asks for it', async () => {
		const collection = newCollection();
		await repository._find('cid', collection, {}, { '_id': 1, name: 1 });
		assert.deepEqual(collection.calls.find[0].options.projection, { '_id': 1, name: 1 });
	});
});

describe('_delete and _deleteOne', () => {
	it('_delete reports whether exactly one document went', async () => {
		const collection = newCollection();
		assert.equal((await repository._delete('cid', collection, { id: 'a' })).results, true);
		collection.deleteOne = async () => ({ deletedCount: 0 });
		assert.equal((await repository._delete('cid', collection, { id: 'a' })).results, false);
	});

	it('_deleteOne reports a boolean', async () => {
		const collection = newCollection();
		assert.equal(await repository._deleteOne('cid', collection, { id: 'a' }), true);
		collection.deleteOne = async () => ({ deletedCount: 0 });
		assert.equal(await repository._deleteOne('cid', collection, { id: 'a' }), false);
	});
});

describe('_getMongoReconnectOptions', () => {
	// Twelve config lookups, each inside a try/catch, at the top of every
	// operation that went through _withMongoReconnect.
	it('resolves the options once per client name', () => {
		let lookups = 0;
		const original = repository._configGetCoerced.bind(repository);
		repository._configGetCoerced = (...args) => { lookups++; return original(...args); };

		const first = repository._getMongoReconnectOptions('mongo');
		assert.equal(lookups, 12);
		assert.equal(repository._getMongoReconnectOptions('mongo'), first);
		assert.equal(repository._getMongoReconnectOptions(' mongo '), first, 'the name is normalized before the lookup');
		assert.equal(lookups, 12);

		repository._getMongoReconnectOptions('atlas');
		assert.equal(lookups, 24, 'another client is resolved on its own');
	});

	it('honours a per-client override', () => {
		inject(repository, '_config', newConfig({ db: { reconnectRetries: 5, atlas: { reconnectRetries: 1 } } }));
		assert.equal(repository._getMongoReconnectOptions('mongo').retries, 5);
		assert.equal(repository._getMongoReconnectOptions('atlas').retries, 1);
	});
});

describe('_fetchExtract', () => {
	const docs = [ { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' } ];

	// Regression: this ran countDocuments next to an unlimited find, so the total
	// it reported was always the length of the array it had just fetched. One
	// wasted round trip per call, and a full scan when the filter was {}.
	it('unpaged, makes one query and takes the total from the data', async () => {
		const collection = newCollection(docs);
		const response = await repository._fetchExtract('cid', collection, { x: 1 }, {});
		assert.equal(collection.calls.countDocuments.length, 0);
		assert.equal(collection.calls.find.length, 1);
		assert.equal(response.total, 5);
		assert.equal(response.count, 5);
		assert.equal(response.data.length, 5);
	});

	it('a sort alone does not make it paged', async () => {
		const collection = newCollection(docs);
		await repository._fetchExtract('cid', collection, {}, {}, { sort: { timestamp: -1 } });
		assert.deepEqual(collection.calls.sort, [ { timestamp: -1 } ]);
		assert.equal(collection.calls.countDocuments.length, 0);
	});

	// A page cannot know how many there are without the count.
	it('with a limit, counts and returns the page with the full total', async () => {
		const collection = newCollection(docs);
		const response = await repository._fetchExtract('cid', collection, { x: 1 }, {}, { limit: 2 });
		assert.deepEqual(collection.calls.countDocuments, [ { x: 1 } ]);
		assert.deepEqual(collection.calls.limit, [ 2 ]);
		assert.equal(response.total, 5);
		assert.equal(response.count, 2);
		assert.deepEqual(response.data, [ { id: 'a' }, { id: 'b' } ]);
	});

	it('with a skip, counts too, since the data no longer starts at the beginning', async () => {
		const collection = newCollection(docs);
		const response = await repository._fetchExtract('cid', collection, {}, {}, { skip: 3 });
		assert.equal(collection.calls.countDocuments.length, 1);
		assert.deepEqual(collection.calls.skip, [ 3 ]);
		assert.equal(response.total, 5);
		assert.deepEqual(response.data, [ { id: 'd' }, { id: 'e' } ]);
	});

	it('applies sort, skip and limit together and passes the projection through', async () => {
		const collection = newCollection(docs);
		const response = await repository._fetchExtract('cid', collection, {}, {}, { sort: { id: 1 }, skip: 1, limit: 2, projection: { id: 1 } });
		assert.deepEqual(collection.calls.sort, [ { id: 1 } ]);
		assert.deepEqual(collection.calls.find[0].options.projection, { id: 1, _id: 0 });
		assert.deepEqual(response.data, [ { id: 'b' }, { id: 'c' } ]);
		assert.equal(response.total, 5);
	});

	it('treats a zero or non-integer skip or limit as unpaged', async () => {
		const collection = newCollection(docs);
		await repository._fetchExtract('cid', collection, {}, {}, { skip: 0, limit: 0 });
		await repository._fetchExtract('cid', collection, {}, {}, { limit: '10' });
		assert.equal(collection.calls.countDocuments.length, 0);
		assert.equal(collection.calls.limit.length, 0);
	});
});

describe('_fetch', () => {
	it('returns the first row or null', async () => {
		assert.deepEqual(await repository._fetch('cid', { toArray: async () => [ { id: 'a' }, { id: 'b' } ] }), { id: 'a' });
		assert.equal(await repository._fetch('cid', { toArray: async () => [] }), null);
	});
});

describe('_initializeDb', () => {
	// A repository whose client is a stub, so nothing dials out.
	const newRepository = (config) => {
		const repo = new MongoRepository();
		inject(repo, '_logger', newLogger());
		inject(repo, '_config', newConfig(config));
		repo._initializeClient = async (correlationId, clientName) => ({
			name: clientName,
			db: (databaseName) => ({ clientName, databaseName })
		});
		return repo;
	};

	// Regression: databaseName was defaulted, validated and used as the cache key,
	// but client.db() was always handed this._config.get('db.name') instead - so
	// the argument had no effect whatsoever.
	it('uses the database name it was handed', async () => {
		const repo = newRepository({ db: { name: 'fromConfig' } });
		const db = await repo._initializeDb('cid', 'clientA', 'explicit');
		assert.equal(db.databaseName, 'explicit');
	});

	it('falls back to db.<client>.name, then db.name', async () => {
		const perClient = newRepository({ db: { clientA: { name: 'perClient' }, name: 'global' } });
		assert.equal((await perClient._initializeDb('cid', 'clientA', null)).databaseName, 'perClient');

		const global = newRepository({ db: { name: 'global' } });
		assert.equal((await global._initializeDb('cid', 'clientA', null)).databaseName, 'global');
	});

	it('throws when no database name can be resolved', async () => {
		const repo = newRepository({ db: {} });
		await assert.rejects(() => repo._initializeDb('cid', 'clientA', null), /databaseName is empty/);
	});

	// Regression: the cache was written under one key and read under another, so
	// it never hit and every call built a fresh handle.
	it('caches the handle', async () => {
		const repo = newRepository({ db: { name: 'global' } });
		let built = 0;
		repo._initializeClient = async () => ({ db: (databaseName) => { built++; return { databaseName }; } });
		await repo._initializeDb('cid', 'clientA', null);
		await repo._initializeDb('cid', 'clientA', null);
		assert.equal(built, 1, 'the second call came from the cache');
	});

	// ...and keys on the client too, so the same database under two clients is
	// two different handles.
	it('does not confuse the same database name under two clients', async () => {
		const repo = newRepository({ db: { name: 'shared' } });
		const a = await repo._initializeDb('cid', 'clientA', null);
		const b = await repo._initializeDb('cid', 'clientB', null);
		assert.equal(a.clientName, 'clientA');
		assert.equal(b.clientName, 'clientB');
	});
});

describe('_getMongoClientOptions', () => {
	const newRepository = (config) => {
		const repo = new MongoRepository();
		inject(repo, '_logger', newLogger());
		inject(repo, '_config', newConfig(config));
		repo._initClientName = () => 'clientA';
		return repo;
	};

	// Regression: the client connected with no options at all, so every pool and
	// timeout setting was whatever happened to be in the connection string.
	it('applies the built in defaults when nothing is configured', () => {
		const options = newRepository({ db: {} })._getMongoClientOptions('cid', 'clientA');
		assert.equal(options.maxIdleTimeMS, 60000, 'idle connections are recycled before a NAT drops them');
		assert.equal(options.minPoolSize, 5);
		assert.equal(options.serverSelectionTimeoutMS, 10000);
		assert.equal(options.connectTimeoutMS, 10000);
		assert.equal(options.retryWrites, true);
		assert.equal(options.retryReads, true);
	});

	// A socketTimeoutMS low enough to be useful also kills change streams.
	it('leaves the opt-in options unset', () => {
		const options = newRepository({ db: {} })._getMongoClientOptions('cid', 'clientA');
		for (const name of [ 'socketTimeoutMS', 'w', 'readPreference', 'appName', 'compressors', 'tls' ])
			assert.equal(name in options, false, `${name} is left to the connection string`);
	});

	it('takes db.<option> for every client and db.<client>.<option> for one', () => {
		const repo = newRepository({ db: { maxIdleTimeMS: 30000, clientB: { maxIdleTimeMS: 5000, w: 'majority' } } });
		assert.equal(repo._getMongoClientOptions('cid', 'clientA').maxIdleTimeMS, 30000);
		assert.equal(repo._getMongoClientOptions('cid', 'clientB').maxIdleTimeMS, 5000, 'per client wins');
		assert.equal(repo._getMongoClientOptions('cid', 'clientB').w, 'majority');
		assert.equal('w' in repo._getMongoClientOptions('cid', 'clientA'), false, 'and does not leak to the others');
	});

	// Regression: Number(null) is 0, so an absent key read as a deliberate zero and
	// silently beat the default.
	it('does not read an absent key as zero', () => {
		const options = newRepository({ db: { maxIdleTimeMS: null, minPoolSize: '' } })._getMongoClientOptions('cid', 'clientA');
		assert.equal(options.maxIdleTimeMS, 60000);
		assert.equal(options.minPoolSize, 5);
	});

	it('honours a configured zero', () => {
		assert.equal(newRepository({ db: { minPoolSize: 0 } })._getMongoClientOptions('cid', 'clientA').minPoolSize, 0);
	});

	// Environment variables arrive as strings.
	it('coerces strings from the environment', () => {
		const options = newRepository({ db: { maxIdleTimeMS: '30000', retryWrites: 'false', compressors: 'zstd, snappy', w: '1' } })._getMongoClientOptions('cid', 'clientA');
		assert.equal(options.maxIdleTimeMS, 30000);
		assert.equal(options.retryWrites, false);
		assert.deepEqual(options.compressors, [ 'zstd', 'snappy' ]);
		assert.equal(options.w, 1);
	});

	it('discards a value it cannot coerce', () => {
		const options = newRepository({ db: { maxIdleTimeMS: 'soon', minPoolSize: -1 } })._getMongoClientOptions('cid', 'clientA');
		assert.equal(options.maxIdleTimeMS, 60000);
		assert.equal(options.minPoolSize, 5);
	});
});

describe('_getCollectionFromConfig', () => {
	const newRepository = () => {
		const repo = new MongoRepository();
		inject(repo, '_logger', newLogger());
		inject(repo, '_config', newConfig({ db: { name: 'global' } }));
		repo._initializeDb = async () => ({ collection: (name, options) => ({ name, options }) });
		return repo;
	};

	const config = { clientName: 'clientA', databaseName: 'db', collectionName: 'things' };

	// A change stream only surfaces majority committed writes, so a pub/sub style
	// collection needs its own write concern.
	it('passes per collection options through to the driver', async () => {
		const collection = await newRepository()._getCollectionFromConfig('cid', config, { writeConcern: { w: 'majority' } });
		assert.deepEqual(collection.options, { writeConcern: { w: 'majority' } });
	});

	it('asks for the collection unqualified when there are no options', async () => {
		const collection = await newRepository()._getCollectionFromConfig('cid', config);
		assert.equal(collection.options, undefined);
		assert.equal(collection.name, 'things');
	});
});

describe('_searchFilterText', () => {
	it('returns null for an empty query', () => {
		assert.equal(repository._searchFilterText('cid', '', 'name'), null);
		assert.equal(repository._searchFilterText('cid', null, 'name'), null);
	});

	it('builds a text search against the given path', () => {
		inject(repository, '_config', newConfig({}));
		repository._collectionsConfig = { getClientName: () => 'clientA' };
		assert.deepEqual(repository._searchFilterText('cid', 'abc', 'title'),
			{ $search: { text: { path: 'title', query: 'abc' } } });
	});

	it('defaults the path to searchName', () => {
		repository._collectionsConfig = { getClientName: () => 'clientA' };
		assert.equal(repository._searchFilterText('cid', 'abc', null).$search.text.path, 'searchName');
	});

	it('returns null when the configured search type is not text', () => {
		inject(repository, '_config', newConfig({ db: { clientA: { search: { text: 'atlas' } } } }));
		repository._collectionsConfig = { getClientName: () => 'clientA' };
		assert.equal(repository._searchFilterText('cid', 'abc', 'title'), null);
	});
});
