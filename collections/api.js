import BaseCollectionsService from './index.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class BaseApiCollectionsService extends BaseCollectionsService {
	getClientName() {
		return this._config.get('db.default');
	}
	
	getCollectionUsageMetrics() {
		throw new NotImplementedError();
	}
}

export default BaseApiCollectionsService;
