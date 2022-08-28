import BaseAdminMongoRepository from './index.js';

class NewsBaseAdminMongoRepository extends BaseAdminMongoRepository {
	async _getCollectionAdmin(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionNews());
	}
}

export default NewsBaseAdminMongoRepository;
