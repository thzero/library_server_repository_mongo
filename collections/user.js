import BaseApiCollectionsService from './baseApi.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class UserApiCollectionsService extends BaseApiCollectionsService {
	getClientName() {
		return this._config.get('db.default');
	}
	
	getCollectionNews() {
		throw new NotImplementedError();
	}

	getCollectionPlans() {
		throw new NotImplementedError();
	}

	getCollectionUsers() {
		throw new NotImplementedError();
	}
}

export default UserApiCollectionsService;
