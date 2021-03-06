import NotImplementedError from '@thzero/library_common/errors/notImplemented';

import MongoRepository from '../index';

class BaseAdminMongoRepository extends MongoRepository {
	async create(correlationId, userId, value) {
		if (!this._allowsCreate)
			return this._error('BaseAdminMongoRepository', 'create', 'Not authorized');

		const collection = await this._getCollectionAdmin(correlationId);
		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(correlationId, client);
		try {
			await this._transactionStart(correlationId, session);

			const response = await this._create(correlationId, collection, userId, value);
			if (!response || !response.success)
				return this._transactionAbort(correlationId, session, 'Unable to insert the value', null, null, null, correlationId);

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err);
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	async delete(correlationId, id) {
		if (!this._allowsDelete)
			return this._error('BaseAdminMongoRepository', 'delete', 'Not authorized', null, null, null, correlationId);

		const collection = await this._getCollectionAdmin(correlationId);
		const response = this._initResponse(correlationId);
		response.success = await this._deleteOne(correlationId, collection, { id: id});
		return response;
	}

	async fetch(correlationId, id) {
		const collection = await this._getCollectionAdmin(correlationId);
		const response = this._initResponse(correlationId);
		response.results = await this._fetch(correlationId, await this._find(correlationId, collection, { id: id }));
		response.success = response.results != null;
		return response;
	}

	// eslint-disable-next-line
	async search(correlationId, params) {
		const collection = await this._getCollectionAdmin(correlationId);
		const response = this._initResponse(correlationId);

		const defaultFilter = { };

		const queryF = this._searchFilter(correlationId, params, defaultFilter);
		const queryA = [
			{
				$match: this._searchFilter(correlationId, params, defaultFilter)
			}
		];
		this._searchQueryAdditional(queryA);
		queryA.push({
			$project: { '_id': 0 }
		});
		queryA.push({
			$project: this._searchProjection({ '_id': 0 })
		});

		response.results = await this._aggregateExtract(correlationId, await this._find(correlationId, collection, queryF), await this._aggregate(correlationId, collection, queryA), this._initResponseExtract(correlationId));
		return response;
	}

	async update(correlationId, userId, value) {
		if (!this._allowsUpdate)
			return this._error('BaseAdminMongoRepository', 'update', 'Not authorized', null, null, null, correlationId);

		const collection = await this._getCollectionAdmin(correlationId);
		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(correlationId, client);
		try {
			await this._transactionStart(correlationId, session);

			const response = await this._update(correlationId, collection, userId, value.id, value);
			if (!response || !response.success)
				return this._transactionAbort(correlationId, correlationId, session, 'Unable to update the value');

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err);
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	get _allowsCreate() {
		return true
	}

	get _allowsDelete() {
		return true
	}

	get _allowsUpdate() {
		return true
	}

	async _getCollectionAdmin() {
		throw new NotImplementedError();
	}

	// eslint-disable-next-line
	_searchFilter(correlationId, params, defaultFilter) {
		return defaultFilter
	}

	_searchProjection(projection) {
		return projection
	}

	// eslint-disable-next-line
	_searchQueryAdditional(query) {
	}
}

export default BaseAdminMongoRepository;
