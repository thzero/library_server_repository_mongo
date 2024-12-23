import ApiCollectionsService from './api.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class UserApiCollectionsService extends ApiCollectionsService {
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
