import Service from '@thzero/library_server/service';

import NotImplementedError from '@thzero/library_common/errors/notImplemented';

class BaseCollectionsService extends Service {
	getClientName() {
		throw new NotImplementedError();
	}

	_getCollection(correlationId, clientName, databaseName, collectionName) {
		this._enforceNotEmpty('BaseCollectionsService', '_getCollection', 'clientName', clientName, correlationId);
		this._enforceNotEmpty('BaseCollectionsService', '_getCollection', 'databaseName', databaseName, correlationId);
		this._enforceNotEmpty('BaseCollectionsService', '_getCollection', 'collectionName', collectionName, correlationId);

		return {
			clientName: clientName,
			databaseName: databaseName,
			collectionName: collectionName
		}
	}
}

export default BaseCollectionsService;
