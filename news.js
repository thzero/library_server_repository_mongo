import MongoRepository from './index';

class NewsMongoRepository extends MongoRepository {
	async latest(correlationId, timestamp) {
		const collection = await this._getCollectionNews();
		const response = this._initResponse(correlationId);
		response.results = await this._fetchExtract(await this._find(collection, { $and: [ { $or: [ { 'timestamp': { $lte: timestamp } }, { 'sticky': true } ] }, { 'status': 'active' } ] }), this._initResponseExtract(correlationId));
		return response;
	}

	async _getCollectionNews(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionNews());
	}
}

export default NewsMongoRepository;
