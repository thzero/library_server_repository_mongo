import MongoRepository from './index';

class PlansMongoRepository extends MongoRepository {
	async find(correlationId, planId, project) {
		const collectionPlan = await this._getCollectionPlans(correlationId);
		const response = this._initResponse(correlationId);
		response.results = await this._findOne(correlationId, collectionPlan, { 'id': planId }, project);
		return response;
}

	async listing(correlationId) {
		const collection = await this._getCollectionPlans(correlationId);
		const response = this._initResponse(correlationId);
		// response.results = await this._fetchExtract(correlationId, await this._count(correlationId, collection, {}), await this._find(correlationId, collection, {}), this._initResponseExtract());
		response.results = await this._fetchExtract(correlationId, collection, {}, this._initResponseExtract(correlationId));
		return response;
	}

	async _getCollectionPlans(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionPlans(correlationId));
	}
}

export default PlansMongoRepository;
