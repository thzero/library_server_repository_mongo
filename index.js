import { MongoClient } from 'mongodb';
import { Mutex as asyncMutex } from 'async-mutex';

import RepositoryConstants from './constants';

import Utility from '@thzero/library_common/utility';

import Repository from '@thzero/library_server/repository/index';

class MongoRepository extends Repository {
	static _client = {};
	static _db = {};
	constructor() {
		super();

		this._collectionsConfig = null;

		this._mutexClient = new asyncMutex();
		this._mutexDb = new asyncMutex();
	}

	async init(injector) {
		await super.init(injector);

		this._collectionsConfig = this._injector.getService(RepositoryConstants.InjectorKeys.SERVICE_REPOSITORY_COLLECTIONS);
	}

	async _aggregate(collection, query) {
		if (Array.isArray(query)) {
			query.push({
				$project: { '_id': 0 }
			});
		}
		return await collection.aggregate(query);
	}

	async _aggregateExtract(cursor, aggregateCursor, response) {
		response.total = await cursor.count();
		response.data = await aggregateCursor.toArray();
		response.count = response.data.length;
		return response;
	}

	_checkUpdate(results) {
		if (!results)
			return false;

		if (!results.result)
			return false;

		return results.result.ok;
	}

	async _count(cursor) {
		return await cursor.count();
	}

	async _create(collection, userId, value) {
		const response = this._initResponse();

		value.id = value.id ? value.id : Utility.generateId();
		value.createdTimestamp = Utility.getTimestamp();
		value.createdUserId = userId;
		value.updatedTimestamp = Utility.getTimestamp();
		value.updatedUserId = userId;
		await collection.insertOne(value);

		response.results = value;
		return response;
	}

	async _delete(collection, filter) {
		const response = this._initResponse();

		const results = await collection.deleteOne(filter);

		response.results = results.deletedCount === 1;
		return response;
	}

	async _deleteOne(collection, query) {
		const results = await collection.deleteOne(query);
		return (results && (results.deletedCount > 0));
	}

	async _fetch(cursor) {
		const results = await cursor.toArray();
		return (results && (results.length > 0) ? results[0] : null);
	}

	async _fetchExtract(cursor, response) {
		response.total = await cursor.count();
		response.data = await cursor.toArray();
		response.count = response.data.length;
		return response;
	}

	async _find(collection, query, projection) {
		const options = {}
		projection = projection ? projection : {};
		if (!projection['_id'])
			projection['_id'] = 0;
		options.projection = projection;
		return await collection.find(query, options);
	}

	async _findOne(collection, query, projection) {
		const options = {}
		projection = projection ? projection : {};
		if (!projection['_id'])
			projection['_id'] = 0;
		options.projection = projection;
		return await collection.findOne(query, options);
	}

	async _getClient() {
		return await this._initializeClient(this._initClientName());
	}

	async _getCollection(clientName, databaseName, collectionName) {
		if (String.isNullOrEmpty(collectionName))
			throw Error('Invalid collection name.');

		const db = await this._initializeDb(clientName, databaseName);
		return await db.collection(collectionName);
	}

	async _getCollectionFromConfig(config) {
		if (!config)
			throw Error('Invalid collection config.');
		if (String.isNullOrEmpty(config.clientName))
			throw Error('Invalid collection config client name.');
		if (String.isNullOrEmpty(config.databaseName))
			throw Error('Invalid collection config database name.');
		if (String.isNullOrEmpty(config.collectionName))
			throw Error('Invalid collection config collection name.');

		const db = await this._initializeDb(config.clientName, config.databaseName);
		return await db.collection(config.collectionName);
	}

	async _initializeClient(clientName) {
		if (String.isNullOrEmpty(clientName))
			throw Error('Invalid client name.');

		let client = MongoRepository._client[clientName];
		if (client)
			return client;

		const release = await this._mutexClient.acquire();
		try {
			client = MongoRepository._client[clientName];
			if (client)
				return client;

			try {
				client = await MongoClient.connect(this._config.get(`db.${clientName}.connection`), {
					useNewUrlParser: true,
					useUnifiedTopology: true
				});
				MongoRepository._client[clientName] = client;

				if (!client)
					throw Error('No client');
			}
			catch (err) {
				throw err;
			}
		}
		finally {
			release();
		}

		return client;
	}

	_initClientName() {
		return this._collectionsConfig.getClientName();
	}

	async _initializeDb(clientName, databaseName) {
		if (String.isNullOrEmpty(databaseName))
		databaseName = this._config.get('db.name');
		if (String.isNullOrEmpty(databaseName))
			throw Error('Invalid db name.');

		let db = MongoRepository._db[databaseName];
		if (db)
			return db;

		const release = await this._mutexDb.acquire();
		try {
			db = MongoRepository._db[databaseName];
			if (db)
				return db;

			try {
				const client = await this._initializeClient(clientName);
				const databaseName = this._config.get(`db.${clientName}.name`);
				db = client.db(databaseName);
				MongoRepository._db[databaseName] = db;

				if (!db)
					throw Error('No db');
			}
			catch (err) {
				throw err;
			}
		}
		finally {
			release();
		}

		return db;
	}

	async _transactionAbort(session, message, err) {
		try {
			await session.abortTransaction();
			return this._error('MongoRepository', '_transactionAbort', message, err);
		}
		catch (err2) {
			return this._error('MongoRepository', '_transactionAbort', message, err2);
		}
	}

	async _transactionCommit(session) {
		await session.commitTransaction();
	}

	async _transactionInit(client) {
		return await client.startSession();
	}

	async _transactionEnd(session) {
		return await session.endSession();
	}

	async _transactionStart(session) {
		session.startTransaction();
	}

	async _update(collection, userId, id, value) {
		const response = this._initResponse();

		value.updatedTimestamp = Utility.getTimestamp();
		value.updatedUserId = userId;
		const results = await collection.replaceOne({'id': id}, value, {upsert: true});
		if (!this._checkUpdate(results))
			return this._error('MongoRepository', '_update', 'Invalid update.');

		response.results = value;
		return response;
	}
}

export default MongoRepository;
