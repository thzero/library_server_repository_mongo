import Service from '@thzero/library_server/service';

import NotImplementedError from '@thzero/library_common/errors/notImplemented';

class BaseCollectionsService extends Service {
	getClientName() {
		throw new NotImplementedError();
	}

	_getCollection(clientName, databaseName, collectionName) {
		if (String.isNullOrEmpty(clientName))
			throw Error('Invalid collection client name.');
		if (String.isNullOrEmpty(databaseName))
			throw Error('Invalid collection database name.');
		if (String.isNullOrEmpty(collectionName))
			throw Error('Invalid collection name.');

		return {
			clientName: clientName,
			databaseName: databaseName,
			collectionName: collectionName
		}
	}
}

export default BaseCollectionsService;
