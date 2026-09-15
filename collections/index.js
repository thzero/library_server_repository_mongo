import LibraryServerRepositoryConstants from '../constants.js';

import Service from '@thzero/library_server/service/index.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class BaseCollectionsService extends Service {
	constructor() {
		super();

		this._collectionsConfig = null;
	}

	async init(injector) {
		await super.init(injector);

		this._collectionsConfig = this._injector.getService(LibraryServerRepositoryConstants.InjectorKeys.SERVICE_REPOSITORY_COLLECTIONS);
	}

	getClientName() {
		throw new NotImplementedError();
	}

	_getCollection(correlationId, clientName, collectionName, databaseName) {
		this._enforceNotEmpty('BaseCollectionsService', '_getCollection', clientName, 'clientName', correlationId);
		this._enforceNotEmpty('BaseCollectionsService', '_getCollection', collectionName, 'collectionName', correlationId);

		// databaseName is an override: a caller-supplied name wins, otherwise fall
		// back to config. Matches MongoRepository._initializeDb. Without the first
		// guard the parameter was overwritten before it was ever read.
		if (String.isNullOrEmpty(databaseName))
			databaseName = this._config.get(`db.${clientName}.name`, null);
		if (String.isNullOrEmpty(databaseName))
			databaseName = this._config.get('db.name', null);

		return {
			clientName: clientName,
			collectionName: collectionName,
			databaseName: databaseName
		};
	}
}

export default BaseCollectionsService;
