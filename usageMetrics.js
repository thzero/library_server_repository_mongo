import MongoRepository from './index';

class UsageMetricsMongoRepository extends MongoRepository {
	async register(usageMetrics) {
		const correlationId = usageMetrics ? usageMetrics.correlationId : null;
		const collection = await this._getCollectionUsageMetrics(correlationId);
		await collection.insertOne(usageMetrics);
		return this._success(correlationId);
	}

	async _getCollectionUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetrics());
	}
}

export default UsageMetricsMongoRepository;
