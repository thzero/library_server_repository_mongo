import LibraryCommonUtility from '@thzero/library_common/utility/index.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

import MongoRepository from '../index.js';

class BaseAdminMongoRepository extends MongoRepository {
	async create(correlationId, userId, value) {
		if (!this._allowsCreate)
			return this._error('BaseAdminMongoRepository', 'create', 'Not authorized', null, null, null, correlationId);

		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(correlationId, client);
		try {
			await this._transactionStart(correlationId, session);
			
			const collection = await this._getCollectionAdmin(correlationId);

			const response = await this._create(correlationId, collection, userId, value);
			if (this._hasFailed(response))
				return this._transactionAbort(correlationId, session, 'Unable to insert the value');

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err, 'BaseAdminMongoRepository', 'create');
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	async delete(correlationId, id) {
		try {
			if (!this._allowsDelete)
				return this._error('BaseAdminMongoRepository', 'delete', 'Not authorized', null, null, null, correlationId);

			const collection = await this._getCollectionAdmin(correlationId);
			const response = this._initResponse(correlationId);
			response.success = await this._deleteOne(correlationId, collection, { id: id});
			return response;
		}
		catch (err) {
			return this._error('BaseAdminMongoRepository', 'delete', null, err, null, null, correlationId);
		}
	}

	async fetch(correlationId, id) {
		try {
			const collection = await this._getCollectionAdmin(correlationId);
			const response = this._initResponse(correlationId);
			// One document, asked for as one. This fetched every match and kept the
			// first.
			response.results = await this._findOne(correlationId, collection, { id: id });
			response.success = LibraryCommonUtility.isNotNull(response.results);
			return response;
		}
		catch (err) {
			return this._error('BaseAdminMongoRepository', 'fetch', null, err, null, null, correlationId);
		}
	}

	// Unpaged unless params carries a skip or a limit. Unpaged is one query, and
	// the total is the length of the data. Paged, the count runs as well, over the
	// stages that decide what matches and nothing else. This used to run the
	// whole pipeline twice, projections included, the second time only to count
	// what the first had already fetched, and had no way to page at all.
	async search(correlationId, params) {
		try {
			const collection = await this._getCollectionAdmin(correlationId);
			const response = this._initResponse(correlationId);

			const defaultFilter = { };

			const queryF = this._searchFilter(correlationId, params, defaultFilter);
			// What matches: the filter, plus whatever the subclass adds, which may
			// itself narrow the set. A count is taken over exactly these.
			const queryMatch = [
				{
					$match: queryF
				}
			];
			this._searchQueryAdditional(queryMatch);

			const paging = this._searchPaging(params);
			const queryData = [ ...queryMatch ];
			if (paging.sort)
				queryData.push({ $sort: paging.sort });
			if (paging.skip)
				queryData.push({ $skip: paging.skip });
			if (paging.limit)
				queryData.push({ $limit: paging.limit });
			// One projection, last, so it shapes only the page. There used to be two
			// in a row, the first dropping only _id, which the second already did.
			queryData.push({
				$project: this._searchProjection({ '_id': 0 })
			});

			const extract = this._initResponseExtract(correlationId);
			if (paging.skip || paging.limit) {
				response.results = await this._aggregateExtract2(correlationId, collection, queryMatch, queryData, extract);
				return response;
			}

			extract.data = await this._aggregate2(correlationId, collection, queryData);
			extract.count = extract.data.length;
			extract.total = extract.count;
			response.results = extract;
			return response;
		}
		catch (err) {
			return this._error('BaseAdminMongoRepository', 'search', null, err, null, null, correlationId);
		}
	}

	async update(correlationId, userId, value) {
		if (!this._allowsUpdate)
			return this._error('BaseAdminMongoRepository', 'update', 'Not authorized', null, null, null, correlationId);

		const session = await this._transactionInit(correlationId, await this._getClient(correlationId));
		try {
			await this._transactionStart(correlationId, session);
			
			const collection = await this._getCollectionAdmin(correlationId);

			const response = await this._update(correlationId, collection, userId, value.id, value);
			if (this._hasFailed(response))
				return this._transactionAbort(correlationId, session, 'Unable to update the value');

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err, 'BaseAdminMongoRepository', 'update');
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	get _allowsCreate() {
		return true;
	}

	get _allowsDelete() {
		return true;
	}

	get _allowsUpdate() {
		return true;
	}

	async _getCollectionAdmin() {
		throw new NotImplementedError();
	}

	// eslint-disable-next-line
	_searchFilter(correlationId, params, defaultFilter) {
		return defaultFilter;
	}

	// skip, limit and sort from the search params, where present and usable. The
	// base search schema allows none of them: an application that wants a paged
	// admin list adds them to its search schema and has its UI send them.
	_searchPaging(params) {
		const paging = { skip: 0, limit: 0, sort: null };
		if (!params)
			return paging;

		if (Number.isInteger(params.skip) && params.skip > 0)
			paging.skip = params.skip;
		if (Number.isInteger(params.limit) && params.limit > 0)
			paging.limit = params.limit;
		if (params.sort && (typeof params.sort === 'object') && (Object.keys(params.sort).length > 0))
			paging.sort = params.sort;
		return paging;
	}

	_searchProjection(projection) {
		return projection;
	}

	// eslint-disable-next-line
	_searchQueryAdditional(query) {
	}
}

export default BaseAdminMongoRepository;
