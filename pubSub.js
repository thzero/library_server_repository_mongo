import MongoRepository from './index.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class PubSubMongoRepository extends MongoRepository {
	constructor() {
		super();

		this._changeStream = null;
		// Bumped whenever the stream is replaced, so an event still in flight from an
		// old stream cannot schedule a reconnect against the new one.
		this._changeStreamGeneration = 0;
		this._restartHandle = null;
		this._restartAttempt = 0;
		this._resumeToken = null;
		this._shutdown = false;
		this._watchdogHandle = null;

		this._restartDelayMs = 3000;
		this._restartMaxDelayMs = 60000;
		this._watchdogIntervalMs = 30000;
	}

	// A change stream is not forever: a primary stepdown, a dropped connection or a
	// client close all end it, and the driver only resumes what it considers a
	// resumable error. Anything else arrives here as 'error' or 'close' and the
	// stream stays dead - previously in silence, with pub/sub simply stopping.
	async listen(correlationId, collection) {
		this._shutdown = false;
		try {
			return await this._openChangeStream(correlationId, collection);
		}
		catch (err) {
			this._scheduleReconnect(correlationId, err, 'listen', this._changeStreamGeneration);
			return this._error('PubSubMongoRepository', 'listen', null, err, null, null, correlationId);
		}
	}

	// Call from the host's shutdown hook, otherwise the reconnect timer keeps the
	// stream coming back while the process is trying to exit.
	async shutdown(correlationId) {
		this._shutdown = true;
		this._stopWatchdog();
		if (this._restartHandle) {
			clearTimeout(this._restartHandle);
			this._restartHandle = null;
		}
		await this._closeChangeStream();
		return this._success(correlationId);
	}

	async send(correlationId, type, params, collection) {
		const config = this._getConfigPubSub(correlationId);
		const provided = collection;
		try {
			// The retry has to wrap the insert, and the insert has to be free to throw
			// out of here - catching inside the operation hides every connectivity error
			// from _withMongoReconnect and defeats the retry entirely.
			return await this._withMongoReconnect(correlationId, config?.clientName, config?.databaseName, async () => {
				// Re-resolve per attempt; a handle cached across a retry still points at
				// the client that was just recycled.
				const target = provided ?? await this._getCollectionPubSub(correlationId);

				// A single document insert is already atomic. The transaction that used to
				// wrap this never received the session, so it committed an empty
				// transaction, cost two extra round trips, and never ended the session -
				// leaking one per publish. The insert was not awaited either, so a failure
				// surfaced as an unhandled rejection and the commit raced it.
				await target.insertOne({
					type: type,
					params: params,
					timestamp: new Date() // has to be a date for the Mongo TTL index to work
				});

				return this._success(correlationId);
			});
		}
		catch (err) {
			return this._error('PubSubMongoRepository', 'send', null, err, null, null, correlationId);
		}
	}

	async _closeChangeStream() {
		if (!this._changeStream)
			return;

		const changeStream = this._changeStream;
		this._changeStream = null;
		// Closing emits 'close' of its own; retire this generation so the handler
		// cannot mistake our own teardown for a failure and reconnect over the top.
		this._changeStreamGeneration++;
		try {
			changeStream.removeAllListeners();
			await changeStream.close();
		}
		catch {
		}
	}

	async _openChangeStream(correlationId, collection) {
		await this._closeChangeStream();
		if (this._restartHandle) {
			clearTimeout(this._restartHandle);
			this._restartHandle = null;
		}
		if (this._shutdown)
			return this._success(correlationId);

		const generation = this._changeStreamGeneration;
		const config = this._getConfigPubSub(correlationId);
		const provided = collection;

		return await this._withMongoReconnect(correlationId, config?.clientName, config?.databaseName, async () => {
			// Re-resolve per attempt; a handle cached across a retry still points at the
			// client that was just recycled.
			const target = provided ?? await this._getCollectionPubSub(correlationId);

			const options = { fullDocument: 'updateLookup' };
			// Resume where the last stream stopped, so nothing published during the outage
			// is lost. Without this a reconnect silently restarts from now.
			if (this._resumeToken)
				options.startAfter = this._resumeToken;

			const changeStream = target.watch([], options);
			this._changeStream = changeStream;

			changeStream.on('change', (next) => {
				this._resumeToken = next._id ?? changeStream.resumeToken ?? this._resumeToken;
				this._restartAttempt = 0;
				try {
					if (!next.fullDocument)
						return;
					this._listen(correlationId, next.fullDocument);
				}
				catch (err) {
					this._error('PubSubMongoRepository', 'listen.onchange', null, err, null, null, correlationId);
				}
			});

			// The server hands out a token after every batch, including empty ones, so an
			// idle stream still moves its resume point forward.
			changeStream.on('resumeTokenChanged', (token) => {
				this._resumeToken = token ?? this._resumeToken;
			});

			changeStream.on('error', (err) => {
				this._scheduleReconnect(correlationId, err, 'changeStream.error', generation);
			});

			changeStream.on('close', () => {
				this._scheduleReconnect(correlationId, new Error('Mongo change stream closed.'), 'changeStream.close', generation);
			});

			changeStream.on('end', () => {
				this._scheduleReconnect(correlationId, new Error('Mongo change stream ended.'), 'changeStream.end', generation);
			});

			this._startWatchdog(correlationId);

			this._logger.info('PubSubMongoRepository', '_openChangeStream', 'PubSub change stream opened.', { resumed: !!options.startAfter }, correlationId);
			return this._success(correlationId);
		});
	}

	_isChangeStreamHistoryLost(err) {
		if (!err)
			return false;
		// ChangeStreamHistoryLost (286) / ChangeStreamFatalError (280): the resume token
		// has aged out of the oplog, so resuming from it can never succeed.
		if (err.code === 286 || err.code === 280 || err.codeName === 'ChangeStreamHistoryLost')
			return true;
		const message = String(err.message || '');
		return message.includes('resume point may no longer be in the oplog') || message.includes('Resume of change stream was not possible');
	}

	_restartDelay() {
		const exponential = this._restartDelayMs * Math.pow(2, this._restartAttempt);
		const delay = Math.min(this._restartMaxDelayMs, exponential);
		// Jitter, so a fleet of instances does not reconnect in lockstep.
		return Math.floor(delay / 2 + Math.random() * (delay / 2));
	}

	_scheduleReconnect(correlationId, err, source, generation) {
		if (this._shutdown)
			return;
		// An event from a stream that has already been replaced.
		if (generation !== undefined && generation !== this._changeStreamGeneration)
			return;
		// 'error' is normally followed by 'close'; one reconnect covers both.
		if (this._restartHandle)
			return;

		if (this._isChangeStreamHistoryLost(err)) {
			this._logger.warn('PubSubMongoRepository', source, 'PubSub resume token is no longer valid; restarting from now.', err, correlationId);
			this._resumeToken = null;
		}

		const config = this._getConfigPubSub(correlationId);
		const connectivity = this._isMongoConnectivityError(err);
		const delayMs = this._restartDelay();
		this._restartAttempt++;
		this._error('PubSubMongoRepository', source, `PubSub change stream lost; reconnect attempt ${this._restartAttempt} in ${delayMs}ms.`, err, null, null, correlationId);

		this._restartHandle = setTimeout(async () => {
			this._restartHandle = null;
			if (this._shutdown)
				return;
			try {
				await this._closeChangeStream();
				// Only recycle the shared client when the failure really was connectivity;
				// a routine cursor close must not tear down every other repository.
				if (connectivity && config)
					await this._resetMongoConnection(correlationId, config.clientName, config.databaseName);
				await this.listen(correlationId);
			}
			catch (err2) {
				this._scheduleReconnect(correlationId, err2, 'changeStream.reconnect', this._changeStreamGeneration);
			}
		}, delayMs);
		if (this._restartHandle.unref)
			this._restartHandle.unref();
	}

	// Covers the case the events do not: a stream that died without emitting
	// anything we were still listening for.
	_startWatchdog(correlationId) {
		if (this._watchdogHandle)
			return;

		this._watchdogHandle = setInterval(() => {
			if (this._shutdown || this._restartHandle)
				return;
			const changeStream = this._changeStream;
			if (changeStream && !changeStream.closed)
				return;
			this._scheduleReconnect(correlationId, new Error('Mongo change stream is not active.'), 'changeStream.watchdog', this._changeStreamGeneration);
		}, this._watchdogIntervalMs);
		if (this._watchdogHandle.unref)
			this._watchdogHandle.unref();
	}

	_stopWatchdog() {
		if (!this._watchdogHandle)
			return;
		clearInterval(this._watchdogHandle);
		this._watchdogHandle = null;
	}

	// Implementations should pass { writeConcern: { w: 'majority' } } to
	// _getCollectionFromConfig: a change stream only ever surfaces majority committed
	// writes, so at the default w:1 a send() can report success for an insert that a
	// later election rolls back, and that message is never delivered.
	async _getCollectionPubSub(correlationId) {
		throw new NotImplementedError();
	}

	// The collection config for the pub/sub collection, so the retry and the client
	// reset act on the client that actually owns it. Returning null falls back to
	// the default client.
	_getConfigPubSub(correlationId) {
		return null;
	}

	async _listen(correlationId, message) {
		throw new NotImplementedError();
	}
}

export default PubSubMongoRepository;
