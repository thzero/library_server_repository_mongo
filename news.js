import MongoRepository from './index';

class NewsMongoRepository extends MongoRepository {
	async latest(correlationId, timestamp) {
		const collection = await this._getCollectionNews();
		const response = this._initResponse();
		response.results = await this._fetchExtract(await this._find(collection, { $and: [ { $or: [ { 'timestamp': { $lte: timestamp } }, { 'sticky': true } ] }, { 'status': 'active' } ] }), this._initResponseExtract());
		return response;
	}

	async _getCollectionNews() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionNews());
	}
}

export default NewsMongoRepository;
