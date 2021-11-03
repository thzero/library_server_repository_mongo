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

	async _aggregate(correlationId, collection, query) {
		if (Array.isArray(query)) {
			query.push({
				$project: { '_id': 0 }
			});
		}
		return await collection.aggregate(query);
	}

	async _aggregateExtract(correlationId, cursor, aggregateCursor, response) {
		response.total = await cursor.count();
		response.data = await aggregateCursor.toArray();
		response.count = response.data.length;
		return response;
	}

	_checkUpdate(correlationId, results) {
		if (!results)
			return this._error('MongoRepository', '_checkUpdate', 'Invalid results.', null, null, null, correlationId);

		if (results.modifiedCount || results.upsertedCount)
			return this._success(correlationId);

		return this._error('MongoRepository', '_checkUpdate', 'Not updated.', null, null, null, correlationId);
	}

	async _count(cursor) {
		return await cursor.count();
	}

	async _create(correlationId, collection, userId, value) {
		const response = this._initResponse(correlationId);

		value.id = value.id ? value.id : Utility.generateId();
		value.createdTimestamp = Utility.getTimestamp();
		value.createdUserId = userId;
		value.updatedTimestamp = Utility.getTimestamp();
		value.updatedUserId = userId;
		await collection.insertOne(value);

		response.results = value;
		return response;
	}

	async _delete(correlationId, collection, filter) {
		const response = this._initResponse(correlationId);

		const results = await collection.deleteOne(filter);

		response.results = results.deletedCount === 1;
		return response;
	}

	async _deleteOne(correlationId, collection, query) {
		const results = await collection.deleteOne(query);
		return (results && (results.deletedCount > 0));
	}

	async _fetch(correlationId, cursor) {
		const results = await cursor.toArray();
		return (results && (results.length > 0) ? results[0] : null);
	}

	async _fetchExtract(correlationId, cursor, response) {
		response.total = await cursor.count();
		response.data = await cursor.toArray();
		response.count = response.data.length;
		return response;
	}

	async _find(correlationId, collection, query, projection) {
		const options = {}
		projection = projection ? projection : {};
		if (!projection['_id'])
			projection['_id'] = 0;
		options.projection = projection;
		return await collection.find(query, options);
	}

	async _findOne(correlationId, collection, query, projection) {
		const options = {}
		projection = projection ? projection : {};
		if (!projection['_id'])
			projection['_id'] = 0;
		options.projection = projection;
		return await collection.findOne(query, options);
	}

	async _getClient(correlationId) {
		return await this._initializeClient(correlationId, this._initClientName());
	}

	async _getCollection(correlationId, clientName, databaseName, collectionName) {
		this._enforceNotEmpty('MongoRepository', '_getCollection', 'collectionName', collectionName, correlationId);

		const db = await this._initializeDb(correlationId, clientName, databaseName);
		return await db.collection(collectionName);
	}

	async _getCollectionFromConfig(correlationId, config) {
		this._enforceNotNull('MongoRepository', '_getCollectionFromConfig', 'config', config, correlationId);
		this._enforceNotEmpty('MongoRepository', '_getCollectionFromConfig', 'config.clientName', config.clientName, correlationId);
		this._enforceNotEmpty('MongoRepository', '_getCollectionFromConfig', 'config.databaseName', config.databaseName, correlationId);
		this._enforceNotEmpty('MongoRepository', '_getCollectionFromConfig', 'config.collectionName', config.collectionName, correlationId);

		const db = await this._initializeDb(correlationId, config.clientName, config.databaseName);
		return await db.collection(config.collectionName);
	}

	async _initializeClient(correlationId, clientName) {
		this._enforceNotEmpty('MongoRepository', '_initializeClient', 'clientName', clientName, correlationId);

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

				this._enforceNotNull('MongoRepository', '_initializeClient', 'client', client, correlationId);
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

	async _initializeDb(correlationId, clientName, databaseName) {
		if (String.isNullOrEmpty(databaseName))
			databaseName = this._config.get('db.name');
		this._enforceNotEmpty('MongoRepository', '_initializeDb', 'databaseName', databaseName, correlationId);

		let db = MongoRepository._db[databaseName];
		if (db)
			return db;

		const release = await this._mutexDb.acquire();
		try {
			db = MongoRepository._db[databaseName];
			if (db)
				return db;

			try {
				const client = await this._initializeClient(correlationId, clientName);
				const databaseName = this._config.get(`db.${clientName}.name`);
				db = client.db(databaseName);
				MongoRepository._db[databaseName] = db;

				this._enforceNotNull('MongoRepository', '_initializeDb', 'db', db, correlationId);
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

	async _transactionAbort(correlationId, session, message, err) {
		try {
			await session.abortTransaction();
			return this._error('MongoRepository', '_transactionAbort', message, err, null, null, correlationId);
		}
		catch (err2) {
			return this._error('MongoRepository', '_transactionAbort', message, err2, null, null, correlationId);
		}
	}

	async _transactionCommit(correlationId, session) {
		await session.commitTransaction();
	}

	async _transactionInit(correlationId, client) {
		return await client.startSession();
	}

	async _transactionEnd(correlationId, session) {
		return await session.endSession();
	}

	async _transactionStart(correlationId, session) {
		session.startTransaction();
	}

	async _update(correlationId, collection, userId, id, value) {
		const response = this._initResponse(correlationId);

		value.updatedTimestamp = Utility.getTimestamp();
		value.updatedUserId = userId;
		const results = await collection.replaceOne({'id': id}, value, {upsert: true});
		const responseUpdate = this._checkUpdate(correlationId, results);
		if (this._hasFailed(responseUpdate))
			return responseUpdate;

		response.results = value;
		return response;
	}
}

export default MongoRepository;
