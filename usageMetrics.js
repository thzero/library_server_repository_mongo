import MongoRepository from './index';

class UsageMetricsMongoRepository extends MongoRepository {
	async register(usageMetrics) {
		const correlationid = usageMetrics ? usageMetrics.correlationId : null;
		const collection = await this._getCollectionUsageMetrics(correlationid);
		await collection.insertOne(usageMetrics);
		return this._success(correlationid);
	}

	async _getCollectionUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetrics());
	}
}

export default UsageMetricsMongoRepository;
