import MongoRepository from './index.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

class PubSubMongoRepository extends MongoRepository {
	async listen(correlationId, collection) {
		try {
			if (!collection)
				collection = await this._getCollectionPubSub(correlationId);

			const changeStream = collection.watch([], { fullDocument: 'updateLookup' });
			changeStream.on('change', next => {
				this._listen(correlationId, next.fullDocument);
			});

			return this._success(correlationId);
		}
		catch (err) {
			return this._error('PubSubMongoRepository', 'listen', null, err, null, null, correlationId);
		}
	}

	async send(correlationId, type, collection) {
		const session = await this._transactionInit(correlationId, await this._getClient(correlationId));
		try {
			await this._transactionStart(correlationId, session);

			if (!collection)
				collection = await this._getCollectionPubSub(correlationId);

			collection.insertOne({
				type: type,
				timestamp: new Date() // has to be a date for the Mongo TTL index to work
			});

			await this._transactionCommit(correlationId, session);
			return this._success(correlationId);
		}
		catch (err) {
			return this._error('PubSubMongoRepository', 'send', null, err, null, null, correlationId);
		}
	}

	async _getCollectionPubSub(correlationId) {
		throw new NotImplementedError();
	}

	async _listen(correlationId) {
		throw new NotImplementedError();
	}
}

export default PubSubMongoRepository;
