import BaseCollectionsService from './index';

import NotImplementedError from '@thzero/library_common/errors/notImplemented';

class BaseApiCollectionsService extends BaseCollectionsService {
	getCollectionUsageMetrics() {
		throw new NotImplementedError();
	}
}

export default BaseApiCollectionsService;
