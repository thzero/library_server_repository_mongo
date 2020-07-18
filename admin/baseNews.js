import BaseAdminMongoRepository from './index';

class NewsBaseAdminMongoRepository extends BaseAdminMongoRepository {
	async _getCollectionAdmin() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionNews());
	}
}

export default NewsBaseAdminMongoRepository;
