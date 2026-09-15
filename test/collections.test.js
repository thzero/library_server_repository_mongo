import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import BaseCollectionsService from '../collections/index.js';
import BaseApiCollectionsService from '../collections/api.js';

const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

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

const newService = (tree) => {
	const service = new BaseCollectionsService();
	inject(service, '_logger', newLogger());
	inject(service, '_config', newConfig(tree));
	return service;
};

let service;

beforeEach(() => {
	service = newService({ db: { atlas: { name: 'perClient' }, name: 'global' } });
});

describe('_getCollection', () => {
	it('requires a client name and a collection name', () => {
		assert.throws(() => service._getCollection('cid', null, 'users'), /clientName is empty/);
		assert.throws(() => service._getCollection('cid', 'atlas', null), /collectionName is empty/);
	});

	// Regression: the parameter was overwritten by the config lookup before it was
	// ever read, so a caller-supplied name had no effect. Same shape as the defect
	// MongoRepository._initializeDb carried.
	it('lets a caller-supplied database name win', () => {
		const collection = service._getCollection('cid', 'atlas', 'users', 'explicit');
		assert.equal(collection.databaseName, 'explicit');
	});

	it('falls back to db.<client>.name, then db.name', () => {
		assert.equal(service._getCollection('cid', 'atlas', 'users').databaseName, 'perClient');

		const globalOnly = newService({ db: { name: 'global' } });
		assert.equal(globalOnly._getCollection('cid', 'atlas', 'users').databaseName, 'global');
	});

	it('treats an empty string as no override', () => {
		assert.equal(service._getCollection('cid', 'atlas', 'users', '').databaseName, 'perClient');
	});

	it('leaves databaseName null when config resolves nothing', () => {
		const bare = newService({ db: {} });
		assert.equal(bare._getCollection('cid', 'atlas', 'users').databaseName, null);
	});

	it('returns the client and collection it was given', () => {
		assert.deepEqual(service._getCollection('cid', 'atlas', 'users'),
			{ clientName: 'atlas', collectionName: 'users', databaseName: 'perClient' });
	});
});

describe('getClientName', () => {
	it('is not implemented on the base', () => {
		assert.throws(() => service.getClientName(), /NotImplemented|not implemented/i);
	});

	it('the api subclass reads db.default', () => {
		const api = new BaseApiCollectionsService();
		inject(api, '_logger', newLogger());
		inject(api, '_config', newConfig({ db: { default: 'atlas' } }));
		assert.equal(api.getClientName(), 'atlas');
	});
});
