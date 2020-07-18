import BaseAdminMongoRepository from './index';

class BaseUsersMongoRepository extends BaseAdminMongoRepository {
	get _allowsCreate() {
		return false
	}

	get _allowsDelete() {
		return true
	}

	get _allowsUpdate() {
		return true
	}

	async _getCollectionAdmin() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionUsers());
	}
}

export default BaseUsersMongoRepository;
