import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import PubSubMongoRepository from '../pubSub.js';

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

// The base class has carried _config and _logger as prototype getters and as
// plain fields at different versions; defineProperty plants an own property that
// works against either shape.
const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

// Stands in for a driver ChangeStream: an emitter that tracks whether it is open
// and what watch() was asked for.
class FakeChangeStream extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.closed = false;
		this.resumeToken = null;
	}

	async close() {
		this.closed = true;
		this.emit('close');
	}
}

const newCollection = () => {
	const streams = [];
	const inserted = [];
	return {
		streams,
		inserted,
		watch(pipeline, options) {
			const stream = new FakeChangeStream(options);
			stream.pipeline = pipeline;
			streams.push(stream);
			return stream;
		},
		async insertOne(value) { inserted.push(value); return { insertedId: 'x' }; }
	};
};

// dotted-path config lookup, the shape this._config.get(path, default) expects
const newConfig = (tree = {}) => ({
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

const newRepository = (collection, received = []) => {
	const repo = new PubSubMongoRepository();
	inject(repo, '_logger', newLogger());
	inject(repo, '_config', newConfig({ db: { name: 'test' } }));
	// listen() and send() run through _withMongoReconnect, which resolves the client
	// the pub/sub collection belongs to.
	repo._collectionsConfig = { getClientName: () => 'clientA' };
	repo._getConfigPubSub = () => ({ clientName: 'clientA', databaseName: 'test', collectionName: 'pubsub' });
	repo._getCollectionPubSub = async () => collection;
	repo._listen = async (correlationId, message) => { received.push(message); };
	// Reconnects are driven by hand in these tests.
	repo._restartDelayMs = 1;
	repo._watchdogIntervalMs = 5;
	return repo;
};

// Reconnects run off timers, so poll for the outcome rather than guessing a
// delay that a loaded test runner will miss.
const waitFor = async (predicate, message, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate())
			return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(message);
};

// For the negative cases: let every pending timer have its turn, then assert
// that nothing happened.
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('listen', () => {
	it('delivers the full document to _listen', async () => {
		const collection = newCollection();
		const received = [];
		const repo = newRepository(collection, received);
		await repo.listen('cid');

		collection.streams[0].emit('change', { _id: { t: 1 }, fullDocument: { type: 'a' } });
		assert.deepEqual(received, [ { type: 'a' } ]);
		await repo.shutdown('cid');
	});

	// Regression: a closed stream stayed closed and pub/sub silently stopped.
	it('reopens the stream after it closes', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');
		assert.equal(collection.streams.length, 1);

		collection.streams[0].emit('close');
		await waitFor(() => collection.streams.length === 2, 'no replacement stream was opened');
		await repo.shutdown('cid');
	});

	// Regression: a reconnect restarted from now, dropping anything published
	// while the stream was down.
	it('resumes from the last token it saw', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');
		assert.equal(collection.streams[0].options.startAfter, undefined, 'the first stream starts fresh');

		collection.streams[0].emit('change', { _id: { t: 7 }, fullDocument: { type: 'a' } });
		collection.streams[0].emit('close');
		await waitFor(() => collection.streams.length === 2, 'no replacement stream was opened');
		assert.deepEqual(collection.streams[1].options.startAfter, { t: 7 });
		await repo.shutdown('cid');
	});

	it('tracks the token the server sends while idle', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');

		collection.streams[0].emit('resumeTokenChanged', { t: 9 });
		collection.streams[0].emit('close');
		await waitFor(() => collection.streams.length === 2, 'no replacement stream was opened');
		assert.deepEqual(collection.streams[1].options.startAfter, { t: 9 });
		await repo.shutdown('cid');
	});

	// A token that has aged out of the oplog can never resume, so the stream has to
	// fall back to starting fresh rather than failing forever.
	it('drops a resume token the oplog no longer holds', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');

		collection.streams[0].emit('change', { _id: { t: 7 }, fullDocument: { type: 'a' } });
		const err = new Error('Resume of change stream was not possible');
		err.code = 286;
		collection.streams[0].emit('error', err);
		await waitFor(() => collection.streams.length === 2, 'no replacement stream was opened');
		assert.equal(collection.streams[1].options.startAfter, undefined);
		await repo.shutdown('cid');
	});

	// 'error' is normally followed by 'close'; both firing must not open two streams.
	it('opens one replacement when error and close both fire', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');

		collection.streams[0].emit('error', new Error('boom'));
		collection.streams[0].emit('close');
		await waitFor(() => collection.streams.length === 2, 'no replacement stream was opened');
		await settle();
		assert.equal(collection.streams.length, 2, 'and only one');
		await repo.shutdown('cid');
	});

	// Regression: closing a stream emits 'close', which used to schedule a
	// reconnect against the stream that had just replaced it.
	it('does not reconnect because of its own teardown', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');
		await repo.listen('cid');
		await settle();
		assert.equal(collection.streams.length, 2, 'the deliberate reopen did not cascade');
		await repo.shutdown('cid');
	});

	it('reopens a stream that died without emitting anything', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');

		collection.streams[0].closed = true;
		await waitFor(() => collection.streams.length === 2, 'the watchdog did not notice');
		await repo.shutdown('cid');
	});

	it('stops reconnecting once shut down', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');
		await repo.shutdown('cid');

		const count = collection.streams.length;
		await settle();
		assert.equal(collection.streams.length, count, 'nothing came back after shutdown');
	});
});

describe('send', () => {
	it('inserts the message', async () => {
		const collection = newCollection();
		const response = await newRepository(collection).send('cid', 'a-type', { a: 1 });
		assert.equal(response.success, true);
		assert.equal(collection.inserted.length, 1);
		assert.equal(collection.inserted[0].type, 'a-type');
		assert.deepEqual(collection.inserted[0].params, { a: 1 });
		// A Date, not a number - the TTL index will not fire on anything else.
		assert.equal(collection.inserted[0].timestamp instanceof Date, true);
	});

	// Regression: insertOne was not awaited, so a failure escaped as an unhandled
	// rejection and send() reported success anyway.
	it('reports a failed insert instead of succeeding', async () => {
		const collection = newCollection();
		collection.insertOne = async () => { throw new Error('write failed'); };
		const response = await newRepository(collection).send('cid', 'a-type', {});
		assert.notEqual(response.success, true);
	});

	it('uses the collection it is handed', async () => {
		const collection = newCollection();
		const other = newCollection();
		await newRepository(collection).send('cid', 'a-type', {}, other);
		assert.equal(other.inserted.length, 1);
		assert.equal(collection.inserted.length, 0);
	});

	// Regression: the insert used to be caught inside the operation and turned into
	// an error response, which hid every connectivity error from _withMongoReconnect
	// and meant send() gave up on the first network blip.
	it('retries a connectivity failure', async () => {
		const collection = newCollection();
		let attempts = 0;
		collection.insertOne = async () => {
			attempts++;
			if (attempts < 3) {
				const err = new Error('connection <monitor> timed out');
				err.name = 'MongoNetworkTimeoutError';
				throw err;
			}
			return { insertedId: 'x' };
		};
		const repo = newRepository(collection);
		repo._resetMongoConnection = async () => true;
		repo._pause = async () => {};

		const response = await repo.send('cid', 'a-type', {});
		assert.equal(response.success, true);
		assert.equal(attempts, 3);
	});

	// Regression: a session was opened and a transaction started for an insert that
	// never joined it, and the session was never ended - one leaked per publish.
	it('opens no session', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		let sessions = 0;
		repo._getClient = async () => ({ startSession: () => { sessions++; return {}; } });
		await repo.send('cid', 'a-type', {});
		assert.equal(sessions, 0);
	});
});

// The write concern is a correctness requirement of the change stream, not a
// per-application detail: it used to live in a comment on an abstract method and
// every implementation had to remember to pass it.
describe('_getCollectionPubSub', () => {
	// Resolves the collection itself, from the collections service, rather than
	// throwing NotImplementedError and making each application wire it up.
	// The stream used to be opened with no pipeline and fullDocument: 'updateLookup',
	// so every TTL expiry delete was sent to every listening instance and dropped.
	// An insert event carries its document already.
	it('watches inserts only, without a lookup', async () => {
		const collection = newCollection();
		const repo = newRepository(collection);
		await repo.listen('cid');
		assert.deepEqual(collection.streams[0].pipeline, [ { $match: { operationType: 'insert' } } ]);
		assert.equal(collection.streams[0].options.fullDocument, undefined);
		await repo.shutdown('cid');
	});

	const newBareRepository = (tree = { db: { name: 'test' } }) => {
		const repo = new PubSubMongoRepository();
		inject(repo, '_logger', newLogger());
		inject(repo, '_config', newConfig(tree));
		repo._collectionsConfig = {
			getClientName: () => 'clientA',
			getCollectionPubSub: () => ({ clientName: 'clientA', databaseName: 'test', collectionName: 'pubsub' })
		};
		return repo;
	};

	const captureOptions = (repo) => {
		const seen = {};
		repo._getCollectionFromConfig = async (correlationId, config, options) => {
			seen.config = config;
			seen.options = options;
			return newCollection();
		};
		return seen;
	};

	it('defaults the write concern to majority', async () => {
		const repo = newBareRepository();
		const seen = captureOptions(repo);
		await repo._getCollectionPubSub('cid');
		assert.deepEqual(seen.options, { writeConcern: { w: 'majority' } });
	});

	it('resolves the collection from the collections service', async () => {
		const repo = newBareRepository();
		const seen = captureOptions(repo);
		await repo._getCollectionPubSub('cid');
		assert.equal(seen.config.collectionName, 'pubsub');
		assert.equal(seen.config.clientName, 'clientA');
	});

	it('takes db.pubSubWriteConcern for every client', async () => {
		const repo = newBareRepository({ db: { name: 'test', pubSubWriteConcern: 2 } });
		const seen = captureOptions(repo);
		await repo._getCollectionPubSub('cid');
		assert.deepEqual(seen.options, { writeConcern: { w: 2 } });
	});

	it('lets db.<client>.pubSubWriteConcern win for one', async () => {
		const repo = newBareRepository({ db: { name: 'test', pubSubWriteConcern: 2, clientA: { pubSubWriteConcern: 'majority' } } });
		const seen = captureOptions(repo);
		await repo._getCollectionPubSub('cid');
		assert.deepEqual(seen.options, { writeConcern: { w: 'majority' } });
	});

	// The write concern used to be looked up from config on every attempt.
	it('resolves the write concern once per client', async () => {
		const repo = newBareRepository();
		captureOptions(repo);
		let lookups = 0;
		const original = repo._configGetCoerced.bind(repo);
		repo._configGetCoerced = (...args) => { lookups++; return original(...args); };
		await repo._getCollectionPubSub('cid');
		await repo._getCollectionPubSub('cid');
		await repo._getCollectionPubSub('cid');
		assert.equal(lookups, 2, 'the per-client key and the global key, once');
	});

	// send() resolved the pub/sub config three times over: once for itself, once
	// in _getCollectionPubSub and once more in _getCollectionPubSubOptions.
	it('send resolves the pub/sub config once', async () => {
		const repo = newBareRepository();
		captureOptions(repo);
		let resolved = 0;
		const config = repo._collectionsConfig.getCollectionPubSub();
		repo._collectionsConfig.getCollectionPubSub = () => { resolved++; return config; };
		await repo.send('cid', 'a', {});
		assert.equal(resolved, 1);
	});

	it('still throws when there is no collections service to resolve from', async () => {
		const repo = new PubSubMongoRepository();
		inject(repo, '_logger', newLogger());
		inject(repo, '_config', newConfig({ db: { name: 'test' } }));
		await assert.rejects(() => repo._getCollectionPubSub('cid'));
	});
});

// The mirror of the cleanup sweep: an application that registers a pub/sub
// repository wants to be listening, and should not have to start it by hand.
describe('initPost', () => {
	const newListenable = (tree = { db: { name: 'test' } }) => {
		const collection = newCollection();
		const repo = newRepository(collection);
		inject(repo, '_config', newConfig(tree));
		return { repo, collection };
	};

	it('opens the change stream', async () => {
		const { repo, collection } = newListenable();
		await repo.initPost();
		assert.equal(collection.streams.length, 1);
	});

	it('does not open one when db.pubSubListen is false', async () => {
		const { repo, collection } = newListenable({ db: { name: 'test', pubSubListen: false } });
		await repo.initPost();
		assert.equal(collection.streams.length, 0);
	});

	it('treats the string form from the environment as false', async () => {
		const { repo, collection } = newListenable({ db: { name: 'test', pubSubListen: 'false' } });
		await repo.initPost();
		assert.equal(collection.streams.length, 0);
	});

	it('opens one when the setting is absent', async () => {
		const { repo, collection } = newListenable({ db: { name: 'test' } });
		await repo.initPost();
		assert.equal(collection.streams.length, 1);
	});

	// initPost is awaited in a Promise.all over every registered repository, so a
	// pub/sub that cannot reach Mongo must not take the boot down with it.
	it('does not throw when the stream cannot be opened', async () => {
		const { repo } = newListenable();
		repo._getCollectionPubSub = async () => { throw new Error('unreachable'); };
		repo._restartDelayMs = 100000;
		await repo.initPost();
		await repo.shutdown('cid');
	});
});
