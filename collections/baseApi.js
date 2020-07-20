import BaseCollectionsService from './index';

import NotImplementedError from '@thzero/library/errors/notImplemented';

class BaseApiCollectionsService extends BaseCollectionsService {
	getCollectionUsageMetrics() {
		throw new NotImplementedError();
	}
}

export default BaseApiCollectionsService;
