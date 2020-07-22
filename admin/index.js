import NotImplementedError from '@thzero/library_common/errors/notImplemented';

import MongoRepository from '../index';

class BaseAdminMongoRepository extends MongoRepository {
	async create(correlationId, userId, value) {
		if (!this._allowsCreate)
			return this._error();

		const collection = await this._getCollectionAdmin();
		const client = await this._getClient();
		const session = await this._transactionInit(client);
		try {
			await this._transactionStart(session);

			const response = await this._create(collection, userId, value);
			if (!response || !response.success)
				return this._transactionAbort(session, 'Unable to insert the value');

			await this._transactionCommit(session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(session, null, err);
		}
		finally {
			await this._transactionEnd(session);
		}
	}

	async delete(correlationId, id) {
		if (!this._allowsDelete)
			return this._error();

		const collection = await this._getCollectionAdmin();
		const response = this._initResponse();
		response.success = await this._deleteOne(collection, { id: id});
		return response;
	}

	async fetch(correlationId, id) {
		const collection = await this._getCollectionAdmin();
		const response = this._initResponse();
		response.results = await this._fetch(await this._find(collection, { id: id }));
		response.success = response.results != null;
		return response;
	}

	// eslint-disable-next-line
	async search(correlationId, params) {
		const collection = await this._getCollectionAdmin();
		const response = this._initResponse();

		const defaultFilter = { };

		const queryF = this._searchFilter(params, defaultFilter);
		const queryA = [
			{
				$match: this._searchFilter(params, defaultFilter)
			}
		];
		this._searchQueryAdditional(queryA);
		queryA.push({
			$project: { '_id': 0 }
		});
		queryA.push({
			$project: this._searchProjection({ '_id': 0 })
		});

		response.results = await this._aggregateExtract(await this._find(collection, queryF), await this._aggregate(collection, queryA), this._initResponseExtract());
		return response;
	}

	async update(correlationId, userId, value) {
		if (!this._allowsUpdate)
			return this._error();

		const collection = await this._getCollectionAdmin();
		const client = await this._getClient();
		const session = await this._transactionInit(client);
		try {
			await this._transactionStart(session);

			const response = await this._update(collection, userId, value.id, value);
			if (!response || !response.success)
				return this._transactionAbort(session, 'Unable to update the value');

			await this._transactionCommit(session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(session, null, err);
		}
		finally {
			await this._transactionEnd(session);
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
	_searchFilter(params, defaultFilter) {
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
