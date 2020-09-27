import MongoRepository from './index';

class PlansMongoRepository extends MongoRepository {
	async find(correlationId, planId, project) {
		const collectionPlan = await this._getCollectionPlans();
		const response = this._initResponse(correlationId);
		response.results = await this._findOne(collectionPlan, { 'id': planId }, project);
		return response;
}

	async listing(correlationId) {
		const collection = await this._getCollectionPlans();
		const response = this._initResponse(correlationId);
		response.results = await this._fetchExtract(await this._find(collection, {}), this._initResponseExtract());
		return response;
	}

	async _getCollectionPlans() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionPlans());
	}
}

export default PlansMongoRepository;
