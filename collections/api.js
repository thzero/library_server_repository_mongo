import BaseApiCollectionsService from './baseApi';

import NotImplementedError from '@thzero/library/errors/notImplemented';

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
