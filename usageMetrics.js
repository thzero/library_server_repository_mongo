import MongoRepository from './index.js';

class UsageMetricsMongoRepository extends MongoRepository {
	async register(usageMetrics) {
		const correlationId = usageMetrics ? usageMetrics.correlationId : null;
		const collection = await this._getCollectionUsageMetrics(correlationId);
		await collection.insertOne(usageMetrics);
		return this._success(correlationId);
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

	async _getCollectionMeasurementsUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetricsMeasurements(correlationId));
	}

	async _getCollectionUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetrics());
	}
}

export default UsageMetricsMongoRepository;
