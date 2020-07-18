import MongoRepository from './index';

class UsageMetricsMongoRepository extends MongoRepository {
	async register(usageMetrics) {
		const collection = await this._getCollectionUsageMetrics();
		await collection.insertOne(usageMetrics);
		return this._success();
	}

	async _getCollectionUsageMetrics() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionUsageMetrics());
	}
}

export default UsageMetricsMongoRepository;
