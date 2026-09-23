import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import '@thzero/library_common/utility/string.js';
import UsageMetricsMongoRepository from '../usageMetrics.js';

const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => {
	const calls = { info: [], warn: [] };
	return {
		calls,
		debug() {}, error() {}, exception() {}, fatal() {}, trace() {},
		info(clazz, method, message, data) { calls.info.push({ message, data }); },
		warn(clazz, method, message, data) { calls.warn.push({ message, data }); }
	};
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

// Records what the driver was handed. `fail` is consulted per insertMany and
// may be an Error to throw for that call.
const newCollection = () => {
	const calls = { insertOne: [], insertMany: [] };
	const collection = {
		calls,
		fail: null,
		async insertOne(value) { calls.insertOne.push(value); return { insertedId: 'x' }; },
		async insertMany(values, options) {
			calls.insertMany.push({ values: [ ...values ], options });
			if (collection.fail) {
				const err = collection.fail;
				collection.fail = null;
				throw err;
			}
			return { insertedCount: values.length };
		}
	};
	return collection;
};

const connectivityError = (result) => {
	const err = new Error('connection lost');
	err.name = 'MongoNetworkError';
	if (result)
		err.result = result;
	return err;
};

const doc = (n) => ({ correlationId: `cid-${n}`, url: `/u/${n}` });

// Lets a fired flush get through its awaits. mock.timers.tick only runs the
// interval callback; the insert behind it is a real promise chain. Only
// setInterval is mocked, so this setTimeout is the real one.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let repository;
let collection;
let logger;

const newRepository = (config = {}) => {
	const instance = new UsageMetricsMongoRepository();
	logger = newLogger();
	inject(instance, '_logger', logger);
	inject(instance, '_config', newConfig(config));
	instance._collectionsConfig = {
		getClientName: () => 'mongo',
		getCollectionUsageMetrics: () => ({ clientName: 'mongo', collectionName: 'usageMetrics' })
	};
	collection = newCollection();
	instance._getCollectionUsageMetrics = async () => collection;
	return instance;
};

beforeEach(() => {
	mock.timers.enable({ apis: [ 'setInterval' ] });
	repository = newRepository({ db: { usageMetricsBufferSize: 3, usageMetricsBufferFlushMs: 1000, usageMetricsBufferMax: 5 } });
});

afterEach(async () => {
	await repository.cleanup('cid');
	mock.timers.reset();
});

describe('register', () => {
	it('buffers the document instead of inserting it', async () => {
		const response = await repository.register(doc(1));
		assert.equal(repository._hasSucceeded(response), true);
		assert.equal(collection.calls.insertOne.length, 0);
		assert.equal(collection.calls.insertMany.length, 0);
		assert.equal(repository._buffer.length, 1);
	});

	it('flushes with an unordered insertMany once the buffer reaches its size', async () => {
		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await settle();

		assert.equal(collection.calls.insertMany.length, 1);
		assert.deepEqual(collection.calls.insertMany[0].values, [ doc(1), doc(2), doc(3) ]);
		assert.deepEqual(collection.calls.insertMany[0].options, { ordered: false });
		assert.equal(repository._buffer.length, 0);
	});

	it('flushes on the interval when the size is not reached', async () => {
		await repository.register(doc(1));
		mock.timers.tick(999);
		await settle();
		assert.equal(collection.calls.insertMany.length, 0, 'nothing before the interval');

		mock.timers.tick(1);
		await settle();
		assert.equal(collection.calls.insertMany.length, 1);
		assert.deepEqual(collection.calls.insertMany[0].values, [ doc(1) ]);
	});

	it('does not flush an empty buffer on the interval', async () => {
		await repository.register(doc(1));
		mock.timers.tick(1000);
		await settle();
		mock.timers.tick(1000);
		await settle();
		assert.equal(collection.calls.insertMany.length, 1);
	});

	it('writes through when the buffer size is 0', async () => {
		await repository.cleanup('cid');
		repository = newRepository({ db: { usageMetricsBufferSize: 0 } });

		await repository.register(doc(1));
		assert.deepEqual(collection.calls.insertOne, [ doc(1) ]);
		assert.equal(repository._flushHandle, null, 'no timer for a write-through repository');
	});

	it('resolves the per-client option over the global one', async () => {
		await repository.cleanup('cid');
		repository = newRepository({ db: { usageMetricsBufferSize: 50, mongo: { usageMetricsBufferSize: 2 } } });

		await repository.register(doc(1));
		await repository.register(doc(2));
		await settle();
		assert.equal(collection.calls.insertMany.length, 1);
	});

	// The collections carry TTL indexes on these fields. TTL silently ignores a
	// document whose field is a string or missing, so the Date the service stamps
	// has to reach the driver as a Date, through both the batch and the
	// write-through paths.
	it('hands the driver the Date the service stamped, unserialized, in a batch', async () => {
		const stamped = { ...doc(1), date: new Date('2026-01-02T03:04:05Z') };
		await repository.register(stamped);
		await repository.cleanup('cid');

		const written = collection.calls.insertMany[0].values[0];
		assert.ok(written.date instanceof Date);
		assert.equal(written.date.getTime(), stamped.date.getTime());
	});

	it('hands the driver the Date the service stamped, unserialized, on write-through', async () => {
		await repository.cleanup('cid');
		repository = newRepository({ db: { usageMetricsBufferSize: 0 } });

		const stamped = { ...doc(1), date: new Date('2026-01-02T03:04:05Z') };
		await repository.register(stamped);
		assert.ok(collection.calls.insertOne[0].date instanceof Date);
	});

	it('raises the ceiling to the flush size when configured below it', async () => {
		await repository.cleanup('cid');
		repository = newRepository({ db: { usageMetricsBufferSize: 4, usageMetricsBufferMax: 2 } });
		assert.equal(repository._getBufferOptions('cid').max, 4);
	});
});

describe('tag', () => {
	it('writes a Date timestamp, which the measurements TTL expires on', async () => {
		repository._getCollectionMeasurementsUsageMetrics = async () => collection;
		const before = Date.now();
		const response = await repository.tag('cid', 'u1', { type: 'view' });
		assert.equal(repository._hasSucceeded(response), true);

		const written = collection.calls.insertOne[0];
		assert.ok(written.timestamp instanceof Date);
		assert.ok(written.timestamp.getTime() >= before);
		assert.deepEqual(written.metadata, { userId: 'u1', type: 'view', mobile: false });
		assert.equal(written.value, 1);
	});
});

describe('cleanup', () => {
	it('flushes what is still buffered and stops the timer', async () => {
		await repository.register(doc(1));
		await repository.register(doc(2));
		assert.notEqual(repository._flushHandle, null);

		const response = await repository.cleanup('cid');
		assert.equal(repository._hasSucceeded(response), true);
		assert.equal(collection.calls.insertMany.length, 1);
		assert.deepEqual(collection.calls.insertMany[0].values, [ doc(1), doc(2) ]);
		assert.equal(repository._flushHandle, null);
		assert.equal(repository._buffer.length, 0);
	});

	it('writes through anything registered after it, rather than holding it', async () => {
		await repository.cleanup('cid');
		await repository.register(doc(9));
		assert.deepEqual(collection.calls.insertOne, [ doc(9) ]);
		assert.equal(repository._buffer.length, 0);
	});

	it('is safe with nothing buffered', async () => {
		const response = await repository.cleanup('cid');
		assert.equal(repository._hasSucceeded(response), true);
		assert.equal(collection.calls.insertMany.length, 0);
	});
});

describe('a failed flush', () => {
	it('requeues the batch on a connectivity error and retries on the next interval', async () => {
		collection.fail = connectivityError();
		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await settle();

		assert.equal(collection.calls.insertMany.length, 1);
		assert.deepEqual(repository._buffer, [ doc(1), doc(2), doc(3) ], 'the batch is back in the buffer');
		assert.equal(repository._flushFailing, true);

		mock.timers.tick(1000);
		await settle();
		assert.equal(collection.calls.insertMany.length, 2);
		assert.deepEqual(collection.calls.insertMany[1].values, [ doc(1), doc(2), doc(3) ]);
		assert.equal(repository._buffer.length, 0);
		assert.equal(repository._flushFailing, false);
	});

	it('keeps requeued documents ahead of ones registered during the flush', async () => {
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		const original = collection.insertMany;
		collection.insertMany = async function (values, options) {
			await gate;
			return original.call(collection, values, options);
		};
		collection.fail = connectivityError();

		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await repository.register(doc(4));
		release();
		await settle();

		assert.deepEqual(repository._buffer, [ doc(1), doc(2), doc(3), doc(4) ]);
	});

	it('does not let the size trigger hammer an unreachable database', async () => {
		collection.fail = connectivityError();
		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await settle();
		assert.equal(collection.calls.insertMany.length, 1);

		await repository.register(doc(4));
		await repository.register(doc(5));
		await settle();
		assert.equal(collection.calls.insertMany.length, 1, 'still only the one failed attempt');
		assert.equal(repository._buffer.length, 5);
	});

	it('requeues only the documents a partial bulk write did not insert', async () => {
		collection.fail = connectivityError({ insertedIds: { 0: 'a', 2: 'c' } });
		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await settle();

		assert.deepEqual(repository._buffer, [ doc(2) ]);
	});

	it('drops the batch on an error that is not connectivity', async () => {
		collection.fail = new Error('E11000 duplicate key');
		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await settle();

		assert.equal(repository._buffer.length, 0);
		assert.equal(repository._flushFailing, false);
		assert.equal(logger.calls.warn.length, 1);
		assert.match(logger.calls.warn[0].message, /dropping the batch/);
	});

	it('logs the outage once and the recovery once', async () => {
		collection.fail = connectivityError();
		await repository.register(doc(1));
		await repository.register(doc(2));
		await repository.register(doc(3));
		await settle();

		collection.fail = connectivityError();
		mock.timers.tick(1000);
		await settle();
		assert.equal(collection.calls.insertMany.length, 2);
		assert.equal(logger.calls.warn.length, 1, 'the second failure is not logged again');

		mock.timers.tick(1000);
		await settle();
		assert.equal(logger.calls.info.length, 1);
		assert.match(logger.calls.info[0].message, /recovered/);
	});

	it('caps the buffer at its ceiling by dropping the oldest', async () => {
		collection.fail = connectivityError();
		for (let i = 1; i <= 3; i++)
			await repository.register(doc(i));
		await settle();
		for (let i = 4; i <= 7; i++)
			await repository.register(doc(i));

		assert.deepEqual(repository._buffer, [ doc(3), doc(4), doc(5), doc(6), doc(7) ]);
		assert.equal(repository._dropped, 2);
		assert.equal(logger.calls.warn.filter(w => /buffer is full/.test(w.message)).length, 1, 'one warning for the run of drops');

		mock.timers.tick(1000);
		await settle();
		assert.equal(logger.calls.info[0].data.dropped, 2, 'the recovery log carries the count');
		assert.equal(repository._dropped, 0);
	});
});
