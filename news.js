import MongoRepository from './index.js';

class NewsMongoRepository extends MongoRepository {
	async latest(correlationId, timestamp, options) {
		try {
			const collection = await this._getCollectionNews(correlationId);
			const response = this._initResponse(correlationId);

			const conditions = [ { $or: [ { 'timestamp': { $lte: timestamp } }, { 'sticky': true } ] }, { 'status': 'active' } ];
			if (options && (options.authenticated === false))
				conditions.push({ 'requiresAuth': { $ne: true } });
			const query = { $and: conditions };

			const findOptions = { sort: { 'sticky': -1, 'timestamp': -1 } };
			if (options && Number.isInteger(options.limit) && (options.limit > 0))
				findOptions.limit = options.limit;

			const cursor = await this._findExtract(correlationId, collection, query, findOptions);
			const extract = this._initResponseExtract(correlationId);
			extract.data = await cursor.toArray();
			extract.count = extract.data.length;
			extract.total = extract.count;
			response.results = extract;
			return response;
		}
		catch (err) {
			return this._error('NewsMongoRepository', 'latest', null, err, null, null, correlationId);
		}
	}

	async _getCollectionNews(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionNews(correlationId));
	}
}

export default NewsMongoRepository;
