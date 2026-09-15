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
	// Shared by every repository, so the reconnect has to coordinate across them.
	static _reconnectMutexes = new Map();
	static _reconnectGenerations = new Map();
	static _resetTimestamps = new Map();

	// Resolved the same way as the client options below: db.<key> for every client,
	// db.<clientName>.<key> for one, otherwise the default here.
	static MongoReconnectOptions = [
		{ name: 'baseDelayMs', key: 'reconnectDelayMs', type: 'uint', default: 300 },
		{ name: 'maxDelayMs', key: 'reconnectMaxDelayMs', type: 'uint', default: 5000 },
		{ name: 'retries', key: 'reconnectRetries', type: 'uint', default: 2 },
		{ name: 'multiplier', key: 'reconnectBackoffMultiplier', type: 'float', min: 1, default: 2 },
		{ name: 'closeTimeoutMs', key: 'reconnectCloseTimeoutMs', type: 'uint', default: 5000 },
		{ name: 'resetCooldownMs', key: 'reconnectResetCooldownMs', type: 'uint', default: 15000 }
	];

	// Driver options, settable as db.<option> for every client or db.<clientName>.<option>
	// for one. A null default leaves the setting to the driver / connection string.
	static MongoClientOptions = [
		// Recycle pooled connections before an idle NAT or load balancer drops them
		// without a FIN and leaves us holding a socket that is already dead.
		{ name: 'maxIdleTimeMS', type: 'uint', default: 60000 },
		// Keep a few warm so a request arriving after an idle period does not pay for
		// a fresh TLS handshake and authentication.
		{ name: 'minPoolSize', type: 'uint', default: 5 },
		{ name: 'maxPoolSize', type: 'uint', default: 100 },
		{ name: 'maxConnecting', type: 'uint', default: null },
		{ name: 'waitQueueTimeoutMS', type: 'uint', default: null },
		// Surface an unreachable topology in seconds rather than the driver default of
		// 30s, which with retries becomes a minute and a half of wall clock.
		{ name: 'serverSelectionTimeoutMS', type: 'uint', default: 10000 },
		{ name: 'connectTimeoutMS', type: 'uint', default: 10000 },
		// Deliberately unset: any value low enough to be useful also kills change
		// streams and long running aggregations.
		{ name: 'socketTimeoutMS', type: 'uint', default: null },
		{ name: 'heartbeatFrequencyMS', type: 'uint', default: 10000 },
		{ name: 'retryWrites', type: 'boolean', default: true },
		{ name: 'retryReads', type: 'boolean', default: true },
		{ name: 'w', type: 'writeConcern', default: null },
		{ name: 'readPreference', type: 'string', default: null },
		{ name: 'appName', type: 'string', default: null },
		{ name: 'compressors', type: 'list', default: null },
		{ name: 'zlibCompressionLevel', type: 'uint', default: null },
		{ name: 'tls', type: 'boolean', default: null }
	];

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
		// Build a new pipeline rather than pushing onto the caller's array. Mutating
		// it meant a reused query accumulated a $project stage per call, which is why
		// _aggregateExtract2 had to cloneDeep both queries before calling in.
		const pipeline = Array.isArray(query) ? [ ...query, { $project: { '_id': 0 } } ] : query;
		return await collection.aggregate(pipeline);
	}

	async _aggregate2(correlationId, collection, query) {
		const pipeline = Array.isArray(query) ? [ ...query, { $project: { '_id': 0 } } ] : query;
		return collection.aggregate(pipeline).toArray();
	}

	async _aggregateCount(correlationId, collection, query) {
		const pipeline = [ ...query, { $project: { '_id': 1 } }, { $count: 'count' } ];
		const temp = await collection.aggregate(pipeline).toArray();
		return (temp[0] ?? {}).count ?? 0;
	}

	async _aggregateCount2(correlationId, collection, query) {
		const pipeline = [ ...query, { $project: { '_id': 1 } }, { $count: 'count' } ];
		const temp = await collection.aggregate(pipeline).toArray();
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
			this._aggregateCount2(correlationId, collection, queryC),
			this._aggregate2(correlationId, collection, queryD)
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
		const timestamp = LibraryMomentUtility.getTimestamp();
		value.createdTimestamp = timestamp;
		value.createdUserId = userId;
		value.updatedTimestamp = timestamp;
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

	_configGetOptional(key, defaultValue = null) {
		try {
			const value = this._config?.get?.(key);
			return value === undefined ? defaultValue : value;
		}
		catch {
			return defaultValue;
		}
	}

	_configGetCoerced(key, type, min) {
		const value = this._configGetOptional(key);
		// An absent key has to fall through to the next source. Number(null) is 0, which
		// would otherwise read as a deliberate zero and silently beat the default.
		if (value === null || value === undefined || value === '')
			return undefined;

		if (type === 'uint' || type === 'float') {
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed < (min ?? 0))
				return undefined;
			return type === 'uint' ? Math.floor(parsed) : parsed;
		}
		if (type === 'boolean') {
			if (typeof value === 'boolean')
				return value;
			const normalized = String(value).trim().toLowerCase();
			if (normalized === 'true' || normalized === '1')
				return true;
			if (normalized === 'false' || normalized === '0')
				return false;
			return undefined;
		}
		if (type === 'writeConcern') {
			// 'majority' or a numeric acknowledgement count.
			const normalized = String(value).trim();
			if (normalized.toLowerCase() === 'majority')
				return 'majority';
			const parsed = Number(normalized);
			return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
		}
		if (type === 'list') {
			if (Array.isArray(value))
				return value.length > 0 ? value : undefined;
			const parts = String(value).split(',').map((item) => item.trim()).filter((item) => item.length > 0);
			return parts.length > 0 ? parts : undefined;
		}

		const normalized = String(value).trim();
		return normalized.length > 0 ? normalized : undefined;
	}

	_getMongoClientOptions(correlationId, clientName) {
		const normalizedClientName = clientName ? clientName.trim() : this._initClientName();
		const options = {};

		for (const option of MongoRepository.MongoClientOptions) {
			// Per client beats the global setting, which beats the built in default;
			// anything still unset is left to the connection string.
			const value = this._configGetCoerced(`db.${normalizedClientName}.${option.name}`, option.type) ??
				this._configGetCoerced(`db.${option.name}`, option.type) ??
				option.default;
			if (value === null || value === undefined)
				continue;
			options[option.name] = value;
		}

		this._logger.debug('MongoRepository', '_getMongoClientOptions', 'options', options, correlationId);
		return options;
	}

	async _getClient(correlationId, clientName) {
		return await this._initializeClient(correlationId, clientName ?? this._initClientName());
	}

	// options carries per collection settings such as writeConcern / readConcern.
	async _getCollection(correlationId, clientName, collectionName, databaseName, options) {
		this._enforceNotEmpty('MongoRepository', '_getCollection', collectionName, 'collectionName', correlationId);

		const db = await this._initializeDb(correlationId, clientName, databaseName);
		return options ? await db.collection(collectionName, options) : await db.collection(collectionName);
	}

	async _getCollectionFromConfig(correlationId, config, options) {
		this._enforceNotNull('MongoRepository', '_getCollectionFromConfig', config, 'config', correlationId);
		this._enforceNotEmpty('MongoRepository', '_getCollectionFromConfig', config.clientName, 'config.clientName', correlationId);
		this._enforceNotEmpty('MongoRepository', '_getCollectionFromConfig', config.collectionName, 'config.collectionName', correlationId);

		const db = await this._initializeDb(correlationId, config.clientName, config.databaseName);
		return options ? await db.collection(config.collectionName, options) : await db.collection(config.collectionName);
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

			const configDb = this._config.get('db');
			if (!configDb)
				throw Error('Invalid db configuration.');
			const configDbClient = configDb[clientName];
			if (!configDbClient)
				throw Error(`Invalid db configuration, '${clientName}' not found.`);
			const connection = configDbClient.connection ? configDbClient.connection.trim() : null;
			if (String.isNullOrEmpty(connection))
				throw Error(`Invalid db configuration, connection missing for '${clientName}' or it was blank.`);

			// Connecting with no options at all left every pool and timeout setting to
			// whatever happened to be in the connection string.
			client = await MongoClient.connect(connection, this._getMongoClientOptions(correlationId, clientName));
			MongoRepository._client[clientName] = client;

			this._enforceNotNull('MongoRepository', '_initializeClient', client, 'client', correlationId);
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
		// databaseName is an override: a caller-supplied name wins, otherwise fall
		// back to config. It previously had no effect at all - it was defaulted,
		// validated and used as a cache key, but client.db() was always handed the
		// config value instead.
		if (String.isNullOrEmpty(databaseName))
			databaseName = this._config.get(`db.${clientName}.name`, null);
		if (String.isNullOrEmpty(databaseName))
			databaseName = this._config.get('db.name', null);
		this._enforceNotEmpty('MongoRepository', '_initializeDb', databaseName, 'databaseName', correlationId);

		// Key on client AND database. The same database name under two clients is
		// two different handles, and the read and write must use the same key -
		// they did not, so the cache never hit and every call built a new handle.
		const key = `${clientName}/${databaseName}`;

		let db = MongoRepository._db[key];
		if (db)
			return db;

		// const release = await this._mutexDb.acquire();
		const release = await MongoRepository._mutexDb.acquire();
		try {
			db = MongoRepository._db[key];
			if (db)
				return db;

			const client = await this._initializeClient(correlationId, clientName);
			db = client.db(databaseName);
			MongoRepository._db[key] = db;

			this._enforceNotNull('MongoRepository', '_initializeDb', db, 'db', correlationId);
		}
		finally {
			release();
		}

		return db;
	}

	_getMongoReconnectOptions(clientName) {
		const normalizedClientName = clientName ? clientName.trim() : this._initClientName();
		const options = {};

		for (const option of MongoRepository.MongoReconnectOptions) {
			const value = this._configGetCoerced(`db.${normalizedClientName}.${option.key}`, option.type, option.min) ??
				this._configGetCoerced(`db.${option.key}`, option.type, option.min) ??
				option.default;
			options[option.name] = value;
		}

		return options;
	}

	_getReconnectLockKey(clientName, databaseName) {
		const normalizedClientName = clientName ? clientName.trim() : this._initClientName();
		const resolvedDbName = databaseName || this._configGetOptional(`db.${normalizedClientName}.name`) || this._configGetOptional('db.name') || '';
		return `${normalizedClientName}|${resolvedDbName}`;
	}

	_getReconnectMutex(lockKey) {
		let mutex = MongoRepository._reconnectMutexes.get(lockKey);
		if (!mutex) {
			mutex = new asyncMutex();
			MongoRepository._reconnectMutexes.set(lockKey, mutex);
		}
		return mutex;
	}

	_isMongoConnectivityError(error) {
		if (!error)
			return false;

		const name = String(error.name || '');
		const message = String(error.message || '');
		const labels = error.errorLabelSet;

		if (
			name.includes('MongoNetworkTimeoutError') ||
			name.includes('MongoServerSelectionError') ||
			name.includes('MongoNetworkError')
		)
			return true;

		if (
			message.includes('MongoNetworkTimeoutError') ||
			message.includes('MongoServerSelectionError') ||
			message.includes('connection <monitor>') ||
			message.includes('timed out')
		)
			return true;

		if (labels && (labels.has('ResetPool') || labels.has('InterruptInUseConnections')))
			return true;

		return error.cause ? this._isMongoConnectivityError(error.cause) : false;
	}

	_isMongoServerSelectionError(error) {
		if (!error)
			return false;

		const name = String(error.name || '');
		const message = String(error.message || '');
		if (name.includes('MongoServerSelectionError') || message.includes('MongoServerSelectionError'))
			return true;

		return error.cause ? this._isMongoServerSelectionError(error.cause) : false;
	}

	_shouldResetMongoClient(error, retryAttempt) {
		if (!error)
			return false;

		// the topology itself is unreachable; a fresh client is the only way back.
		if (this._isMongoServerSelectionError(error))
			return true;

		// the driver already clears and rebuilds the pool for these, and the topology
		// monitor reconnects on its own.  Recreating the client would only tear down
		// healthy cursors - change streams especially - for no gain, so give the driver
		// one attempt to recover before taking the hammer to it.
		return retryAttempt > 0;
	}

	async _pause(ms) {
		if (!Number.isFinite(ms) || ms <= 0)
			return;
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	async _resetMongoConnection(correlationId, clientName, databaseName, expectedClient) {
		clientName = clientName ? clientName.trim() : this._initClientName();
		const options = this._getMongoReconnectOptions(clientName);
		const client = MongoRepository._client[clientName];

		// someone already recycled the client; do not tear down its replacement.
		if (expectedClient && client && client !== expectedClient)
			return false;

		// the client is shared by every repository, so a burst of concurrent failures
		// must not each recreate it - one reset per cooldown window is enough.
		const now = Date.now();
		const last = MongoRepository._resetTimestamps.get(clientName) ?? 0;
		if (client && now - last < options.resetCooldownMs) {
			this._logger.warn('MongoRepository', '_resetMongoConnection', 'Mongo client was reset recently; skipping.', { clientName: clientName, sinceMs: now - last }, correlationId);
			return false;
		}
		MongoRepository._resetTimestamps.set(clientName, now);

		delete MongoRepository._client[clientName];
		// drop every db handle bound to this client, not just the named one - they all
		// point at the client that is about to be closed.
		for (const key of Object.keys(MongoRepository._db)) {
			if (key.startsWith(`${clientName}/`))
				delete MongoRepository._db[key];
		}

		if (!client || !client.close)
			return true;

		await this._closeMongoClient(correlationId, client, options.closeTimeoutMs);
		return true;
	}

	async _closeMongoClient(correlationId, client, closeTimeoutMs) {
		// note: the driver ignores close(force) as of 7.x, so there is no 'gentler' close
		// to reach for - the only lever is not closing a shared client unless we must.
		const closing = Promise.resolve()
			.then(() => client.close())
			.then(() => true)
			.catch((err) => {
				this._logger.warn('MongoRepository', '_closeMongoClient', 'Unable to close cached Mongo client cleanly.', err, correlationId);
				return true;
			});

		if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
			await closing;
			return;
		}

		let handle = null;
		const expired = new Promise((resolve) => {
			handle = setTimeout(() => resolve(false), closeTimeoutMs);
			if (handle.unref)
				handle.unref();
		});

		const closed = await Promise.race([closing, expired]);
		if (handle)
			clearTimeout(handle);
		if (closed)
			return;

		// the client is already detached from the cache, so let the close finish on its
		// own rather than holding the reconnect behind a wedged shutdown.
		this._logger.warn('MongoRepository', '_closeMongoClient', 'Mongo client did not close within the grace period; abandoning it.', null, correlationId);
	}

	async _reconnectWithLock(correlationId, clientName, databaseName, delayMs, expectedGeneration, reset) {
		const lockKey = this._getReconnectLockKey(clientName, databaseName);
		const mutex = this._getReconnectMutex(lockKey);
		const release = await mutex.acquire();
		try {
			const currentGeneration = MongoRepository._reconnectGenerations.get(lockKey) ?? 0;
			if (currentGeneration !== expectedGeneration)
				return;

			// backing off alone is enough for most blips; only recycle the shared client
			// when the caller decided the driver cannot recover on its own.
			if (reset)
				await this._resetMongoConnection(correlationId, clientName, databaseName);
			await this._pause(delayMs);

			MongoRepository._reconnectGenerations.set(lockKey, currentGeneration + 1);
		}
		finally {
			release();
		}
	}

	async _withMongoReconnect(correlationId, clientName, databaseName, operation) {
		const options = this._getMongoReconnectOptions(clientName);
		let retryAttempt = 0;

		while (true) {
			try {
				return await operation();
			}
			catch (err) {
				if (!this._isMongoConnectivityError(err))
					throw err;
				if (retryAttempt >= options.retries)
					throw err;

				const lockKey = this._getReconnectLockKey(clientName, databaseName);
				const reconnectGeneration = MongoRepository._reconnectGenerations.get(lockKey) ?? 0;

				const exponentialDelay = Math.floor(options.baseDelayMs * Math.pow(options.multiplier, retryAttempt));
				const delayMs = Math.min(options.maxDelayMs, exponentialDelay);
				const reset = this._shouldResetMongoClient(err, retryAttempt);
				retryAttempt++;

				await this._reconnectWithLock(correlationId, clientName, databaseName, delayMs, reconnectGeneration, reset);
			}
		}
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
		const results = await collection.replaceOne({id: id}, value, {upsert: false});
		const responseUpdate = this._checkUpdate(correlationId, results);
		if (this._hasFailed(responseUpdate))
			return responseUpdate;

		response.results = value;
		return response;
	}
}

export default MongoRepository;
