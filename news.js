import MongoRepository from './index';

class NewsMongoRepository extends MongoRepository {
	async latest(correlationId, timestamp) {
		const collection = await this._getCollectionNews(correlationId);
		const response = this._initResponse(correlationId);
		const query = { $and: [ { $or: [ { 'timestamp': { $lte: timestamp } }, { 'sticky': true } ] }, { 'status': 'active' } ] };
		// response.results = await this._fetchExtract(correlationId, await this._count(correlationId, collection, query), await this._find(correlationId, collection, query), this._initResponseExtract(correlationId));
		response.results = await this._fetchExtract(correlationId, collection, query, this._initResponseExtract(correlationId));
		return response;
	}

	async _getCollectionNews(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionNews(correlationId));
	}
}

export default NewsMongoRepository;
