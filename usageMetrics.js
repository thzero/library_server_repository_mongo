import MongoRepository from './index.js';

class UsageMetricsMongoRepository extends MongoRepository {
	// Resolved like the reconnect options: db.<clientName>.<key> for the usage
	// metrics client, then db.<key>, then the default here.
	static UsageMetricsBufferOptions = [
		// Documents held before a flush is forced. 0 writes each one through as it
		// arrives, which is what register did before the buffer existed.
		{ name: 'size', key: 'usageMetricsBufferSize', type: 'uint', default: 100 },
		// How long a document waits before a flush when the size is not reached.
		{ name: 'flushMs', key: 'usageMetricsBufferFlushMs', type: 'uint', min: 1, default: 1000 },
		// Ceiling on the buffer while the database is unreachable. Past it the oldest
		// documents are dropped; for telemetry the recent picture is the one that matters.
		{ name: 'max', key: 'usageMetricsBufferMax', type: 'uint', default: 10000 }
	];

	constructor() {
		super();

		this._buffer = [];
		this._bufferOptions = null;
		this._dropped = 0;
		this._flushFailing = false;
		this._flushHandle = null;
		this._flushPromise = null;
		this._shutdown = false;
	}

	// The name the boot's cleanup sweep looks for. Flushes whatever is still held
	// and stops the timer; without it the last flush interval of metrics is lost
	// on exit.
	async cleanup(correlationId) {
		this._shutdown = true;
		this._stopFlushTimer();
		await this._flush(correlationId);
		return this._success(correlationId);
	}

	// Never rejects. A failed flush is logged and its documents requeued, so the
	// timer and register can fire it without a catch. Concurrent calls share the
	// flush already in progress rather than racing it to the collection.
	_flush(correlationId) {
		if (this._flushPromise)
			return this._flushPromise;
		if (this._buffer.length === 0)
			return Promise.resolve();

		this._flushPromise = this._flushBatch(correlationId)
			.finally(() => {
				this._flushPromise = null;
			});
		return this._flushPromise;
	}

	async _flushBatch(correlationId) {
		const batch = this._buffer;
		this._buffer = [];

		try {
			const collection = await this._getCollectionUsageMetrics(correlationId);
			await collection.insertMany(batch, { ordered: false });

			if (this._flushFailing) {
				this._flushFailing = false;
				this._logger.info('UsageMetricsMongoRepository', '_flushBatch', 'Usage metrics flush recovered.', { count: batch.length, dropped: this._dropped }, correlationId);
				this._dropped = 0;
			}
		}
		catch (err) {
			// A write error is not going to pass on a retry, and a duplicate key from
			// a document the server did apply would poison the buffer for good. Drop
			// what failed and say so.
			if (!this._isMongoConnectivityError(err)) {
				this._logger.warn('UsageMetricsMongoRepository', '_flushBatch', 'Usage metrics flush rejected; dropping the batch.', { count: batch.length, err: err }, correlationId);
				return;
			}

			// An unordered insertMany carries on past a failed document, and a bulk
			// write error reports which ones made it. Requeue only the rest so the
			// retry does not write duplicates.
			const insertedIds = err && err.result ? err.result.insertedIds : null;
			const remaining = insertedIds ? batch.filter((value, index) => !(index in insertedIds)) : batch;
			this._buffer = remaining.concat(this._buffer);
			this._trimBuffer(correlationId, this._getBufferOptions(correlationId));

			// Once per outage, not once per attempt. The timer keeps retrying.
			if (!this._flushFailing) {
				this._flushFailing = true;
				this._logger.warn('UsageMetricsMongoRepository', '_flushBatch', 'Usage metrics flush failed; buffering until the next attempt.', err, correlationId);
			}
		}
	}

	_getBufferOptions(correlationId) {
		if (this._bufferOptions)
			return this._bufferOptions;

		const config = this._collectionsConfig.getCollectionUsageMetrics();
		const clientName = config && config.clientName ? config.clientName.trim() : this._initClientName();
		const options = {};
		for (const option of UsageMetricsMongoRepository.UsageMetricsBufferOptions) {
			options[option.name] = this._configGetCoerced(`db.${clientName}.${option.key}`, option.type, option.min) ??
				this._configGetCoerced(`db.${option.key}`, option.type, option.min) ??
				option.default;
		}
		// A ceiling below the flush size would trim the buffer before it could ever
		// reach the size, leaving the timer as the only trigger.
		if (options.max < options.size)
			options.max = options.size;

		this._bufferOptions = options;
		return options;
	}

	async _getCollectionMeasurementsUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetricsMeasurements(correlationId));
	}

	async _getCollectionUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetrics());
	}

	async listing(correlationId, params) {
		try {
			const collection = await this._getCollectionMeasurementsUsageMetrics(correlationId);

			const queryMatch = [];
			const queryGroup = {
				type: '$metadata.type'
			};
			if (params && params.date) {
				queryMatch.push({
					$match: { timestamp: { $gte: new Date(params.date) } }
				});
				const unit = params.unit ?? 'month';
				const number = params.number ?? 1;
				queryGroup.date = {
					$dateTrunc: {
						date: '$timestamp',
						unit: unit,
						binSize: number
					}
				};
			}

			let querySort = {};
			if (params &&  params.sort) {
				let id;
				for (let item of params.sort) {
					id = (item.id !== 'value' ? '_id.' : '') + item.id;
					querySort[id] = item.dir === false ? -1 : 1
				}
			}
			else
				querySort = {
					value: -1,
					'_id.type': 1
				};

			const queryA = [
				...queryMatch,
				{
					$group: {
						_id: queryGroup,
						value: {
						  $count: {},
						}
					}
				},
				{
					$sort: querySort
				}
			];

			const results = await collection.aggregate(queryA).toArray();
			return this._successResponse(results, correlationId);
		}
		catch (err) {
			return this._error('AppUsageMetricsRepository', 'listing', null, err, null, null, correlationId);
		}
	}

	// Buffers the document and returns at once; the write happens in a batch when
	// the buffer reaches its size or the flush interval elapses, whichever is
	// first. One insert per response was a second database write for every request
	// served.
	async register(usageMetrics) {
		const correlationId = usageMetrics ? usageMetrics.correlationId : null;
		const options = this._getBufferOptions(correlationId);

		// Write through once the shutdown flush has run, so a document arriving after
		// it is not held by a buffer that will never flush again. Also the configured
		// behaviour when the size is 0.
		if (this._shutdown || options.size === 0) {
			const collection = await this._getCollectionUsageMetrics(correlationId);
			await collection.insertOne(usageMetrics);
			return this._success(correlationId);
		}

		this._buffer.push(usageMetrics);
		this._trimBuffer(correlationId, options);
		this._startFlushTimer(options);

		// While the database is unreachable the size trigger would fire a failing
		// insert on every request; the timer retries on its own cadence instead.
		if (this._buffer.length >= options.size && !this._flushFailing)
			this._flush(correlationId);

		return this._success(correlationId);
	}

	_startFlushTimer(options) {
		if (this._flushHandle)
			return;

		this._flushHandle = setInterval(() => {
			this._flush(null);
		}, options.flushMs);
		// Must not hold the process open on its own; cleanup does the final flush.
		if (this._flushHandle.unref)
			this._flushHandle.unref();
	}

	_stopFlushTimer() {
		if (!this._flushHandle)
			return;

		clearInterval(this._flushHandle);
		this._flushHandle = null;
	}

	async tag(correlationId, userId, tag) {
		try {
			const collection = await this._getCollectionMeasurementsUsageMetrics(correlationId);
			const response = this._initResponse(correlationId);

			await collection.insertOne({
				timestamp: new Date(),
				metadata: {
					userId: userId,
					type: tag.type,
					mobile: tag.mobile ?? false
				},
				value: tag.value ? Number(tag.value) : 1
			});

			return response;
		}
		catch (err) {
			return this._error('AppUsageMetricsRepository', 'tag', null, err, null, null, correlationId);
		}
	}

	// Oldest first. Counted rather than logged here: during an outage this runs on
	// every request, and the total is reported once when the flush recovers.
	_trimBuffer(correlationId, options) {
		const excess = this._buffer.length - options.max;
		if (excess <= 0)
			return;

		this._buffer.splice(0, excess);
		if (this._dropped === 0)
			this._logger.warn('UsageMetricsMongoRepository', '_trimBuffer', 'Usage metrics buffer is full; dropping the oldest.', { max: options.max }, correlationId);
		this._dropped += excess;
	}
}

export default UsageMetricsMongoRepository;
