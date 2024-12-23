import { MongoClient } from 'mongodb';
import { Mutex as asyncMutex } from 'async-mutex';

import LibraryServerRepositoryConstants from './constants.js';

import LibraryCommonUtility from '@thzero/library_common/utility/index.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';

import Repository from '@thzero/library_server/repository/index.js';

class MongoRepository extends Repository {
	static _client = {};
	static _mutexClient = new asyncMutex();
	static _mutexDb = new asyncMutex();
	static _db = {};
	constructor() {
		super();

		this._collectionsConfig = null;

		// this._mutexClient = new asyncMutex();
		// this._mutexDb = new asyncMutex();
	}

	async init(injector) {
		await super.init(injector);

		this._collectionsConfig = this._injector.getService(LibraryServerRepositoryConstants.InjectorKeys.SERVICE_REPOSITORY_COLLECTIONS);
	}

	async _aggregate(correlationId, collection, query) {
		if (Array.isArray(query)) {
			query.push({
				$project: { '_id': 0 }
			});
		}
		return await collection.aggregate(query);
	}

	async _aggregate2(correlationId, collection, query) {
		if (Array.isArray(query)) {
			query.push({
				$project: { '_id': 0 }
			});
		}
		return collection.aggregate(query).toArray();
	}

	async _aggregateCount(correlationId, collection, query) {
		query.push({
			$project: { '_id': 1 }
		});
		query.push({
			$count: 'count'
		});
		const temp = await collection.aggregate(query).toArray();
		return (temp[0] ?? {}).count ?? 0;
	}

	async _aggregateCount2(correlationId, collection, query) {
		query.push({
			$project: { '_id': 1 }
		});
		query.push({
			$count: 'count'
		});
		const temp = await collection.aggregate(query).toArray();
		return (temp[0] ?? {}).count ?? 0;
	}

	async _aggregateExtract(correlationId, count, aggregateCursor, response) {
		response.total = count;
		response.data = await aggregateCursor.toArray();
		response.count = response.data.length;
		return response;
	}

	async _aggregateExtract2(correlationId, collection, queryC, queryD, response) {
		const results = await Promise.all([ 
			this._aggregateCount2(correlationId, collection, LibraryCommonUtility.cloneDeep(queryC)),
			this._aggregate2(correlationId, collection, LibraryCommonUtility.cloneDeep(queryD))
		 ]);
		response.total = results[0];
		response.data = results[1];
		response.count = response.data.length;
		return response;
	}

	async _aggregateExtract3(correlationId, countCursor, aggregateCursor, response) {
		const results = await Promise.all([countCursor.toArray(), aggregateCursor.toArray()]);
		response.total = (results[0] ?? {}).count ?? 0;
		response.data = await results[1];
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

	async _count(correlationId, collection, query) {
		return await collection.countDocuments(query);
	}

	async _create(correlationId, collection, userId, value, idName) {
		const response = this._initResponse(correlationId);

		value['id'] = value['id'] ? value['id'] : LibraryCommonUtility.generateId();
		value.createdTimestamp = LibraryMomentUtility.getTimestamp();
		value.createdUserId = userId;
		value.updatedTimestamp = LibraryMomentUtility.getTimestamp();
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

	async _fetchExtract(correlationId, collection, query, response) {
		const values = await Promise.all([ this._count(correlationId, collection, query), this._find(correlationId, collection, query) ]);
		if (values) {
			response.total = values[0];
			response.data = await values[1].toArray();
			response.count = response.data.length;
		}
		return response;
	}

	async _fetchExtract2(correlationId, count, cursor, response) {
		response.total = count;
		response.data = await cursor.toArray();
		response.count = response.data.length;
		return response;
	}

	async _find(correlationId, collection, query, projection) {
		const options = {};
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

	async _getClient(correlationId, clientName) {
		return await this._initializeClient(correlationId, clientName ?? this._initClientName());
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
		clientName = clientName ? clientName.trim() : null;
		this._logger.debug('MongoRepository', '_initializeClient', 'clientName', clientName, correlationId);
		if (String.isNullOrEmpty(clientName))
			throw Error('Invalid db configuration, clientName missing.');

		let client = MongoRepository._client[clientName];
		if (client)
			return client;

		// const release = await this._mutexClient.acquire();
		const release = await MongoRepository._mutexClient.acquire();
		try {
			client = MongoRepository._client[clientName];
			if (client)
				return client;

			clientName = clientName ? clientName.trim() : null;
			this._logger.debug('MongoRepository', '_initializeClient', 'clientName', clientName, correlationId);
			if (String.isNullOrEmpty(clientName))
				throw Error('Invalid db configuration, clientName missing or it was blank.');

			const configDb = this._config.get('db');
			if (!configDb)
				throw Error('Invalid db configuration.');
			const configDbClient = configDb[clientName];
			if (!configDbClient)
				throw Error(`Invalid db configuration, '${clientName}' not found.`);
			const connection = configDbClient.connection ? configDbClient.connection.trim() : null;
			if (String.isNullOrEmpty(connection))
				throw Error(`Invalid db configuration, connection missing for '${clientName}' or it was blank.`);

			client = await MongoClient.connect(connection);
			MongoRepository._client[clientName] = client;

			this._enforceNotNull('MongoRepository', '_initializeClient', 'client', client, correlationId);
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

		// const release = await this._mutexDb.acquire();
		const release = await MongoRepository._mutexDb.acquire();
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

	_searchFilterText(correlationId, query, name, index) {
		if (String.isNullOrEmpty(query))
			return null;
		if ('text' !== (this._searchFilterTextType ?? '').toLowerCase())
			return null;
		
		name = !String.isNullOrEmpty(name) ? name : 'searchName';

		return {
			$search: {
				'text': {
					'path': name,
					'query': query
				}
			} 
		};
	}

	get _searchFilterTextType() {
		const clientName = this._initClientName();
		const search = this._config.get(`db.${clientName}.search`);
		if (!search)
			return 'text';

		return search.text;
	}

	async _transactionAbort(correlationId, session, message, err, clazz, method) {
		try {
			await session.abortTransaction();
			return this._error(clazz ? clazz : 'MongoRepository', method ? method : '_transactionAbort', message, err, null, null, correlationId);
		}
		catch (err2) {
			return this._error('MongoRepository', '_transactionAbort', null, err2, null, null, correlationId);
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

	async _update(correlationId, collection, userId, id, value, idName) {
		const response = this._initResponse(correlationId);

		value.updatedTimestamp = LibraryMomentUtility.getTimestamp();
		value.updatedUserId = userId;
		const results = await collection.replaceOne({id: id}, value, {upsert: true});
		const responseUpdate = this._checkUpdate(correlationId, results);
		if (this._hasFailed(responseUpdate))
			return responseUpdate;

		response.results = value;
		return response;
	}
}

export default MongoRepository;
