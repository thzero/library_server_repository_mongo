import MongoRepository from './index';

class PlansMongoRepository extends MongoRepository {
	async listing(correlationId) {
		const collection = await this._getCollectionPlans();
		const response = this._initResponse();
		response.results = await this._fetchExtract(await this._find(collection, {}), this._initResponseExtract());
		return response;
	}

	async _getCollectionPlans() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionPlans());
	}
}

export default PlansMongoRepository;
