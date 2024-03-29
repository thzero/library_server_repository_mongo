import BaseApiCollectionsService from './baseApi.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class ApiCollectionsService extends BaseApiCollectionsService {
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

export default ApiCollectionsService;
