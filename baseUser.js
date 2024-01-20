import LibraryServerConstants from '@thzero/library_server/constants.js';

import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';

import NotImplementedError from '@thzero/library_common/errors/notImplemented.js';

import MongoRepository from './index.js';

class BaseUserMongoRepository extends MongoRepository {
	async init(injector) {
		await super.init(injector);

		this._repositoryPlans = this._injector.getService(LibraryServerConstants.InjectorKeys.REPOSITORY_PLANS);
	}

	async fetch(correlationId, userId, excludePlan) {
		try {
			const response = this._initResponse(correlationId);

			const collectionUsers = await this._getCollectionUsers(correlationId);
			response.results = await this._findOne(correlationId, collectionUsers, {'id': userId});
			response.success = response.results !== null;
	
			if (!excludePlan && this._hasSucceeded(response) && response.results) {
				const planResponse = await this._repositoryPlans.find(correlationId, response.results.planId);
				if (this._hasSucceeded(planResponse))
					response.results.plan = planResponse.results;
			}
	
			return response;
		}
		catch (err) {
			return this._error('BaseAdminMongoRepository', 'fetch', null, err, null, null, correlationId);
		}
	}

	async fetchByExternalId(correlationId, userId, excludePlan) {
		try {
			const response = this._initResponse(correlationId);

			const collectionUsers = await this._getCollectionUsers(correlationId);
			response.results = await this._findOne(correlationId, collectionUsers, { 'external.id': userId });
			response.success = response.results !== null;
	
			if (!excludePlan && this._hasSucceeded(response) && response.results) {
				const planResponse = await this._repositoryPlans.find(correlationId, response.results.planId, {
					'roles': 0
				});
			}
	
			return response;
		}
		catch (err) {
			return this._error('BaseAdminMongoRepository', 'fetchByExternalId', null, err, null, null, correlationId);
		}
	}

	async refreshSettings(correlationId, userId) {
		const collection = await this._getCollectionUsers(correlationId);

		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(correlationId, client);
		try {
			await this._transactionStart(correlationId, session);

			const data = await this._findOne(correlationId, collection, { 'id': userId });

			const response = this._initResponse(correlationId);
			response.results = data;

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, correlationId, session, null, err, 'BaseUserMongoRepository', 'refreshSettings');
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	async updateFromExternal(correlationId, id, user) {
		try {
			const timestamp = LibraryMomentUtility.getTimestamp();
			const collection = await this._getCollectionUsers(correlationId);
			user.updatedTimestamp = timestamp;
	
			const results = await collection.replaceOne({ 'id': id }, user, {upsert: true});
			if (!this._checkUpdate(correlationId, results))
				return this._error('BaseUserMongoRepository', 'updateFromExternal', 'Invalid user update.', null, null, null, correlationId);
	
			const response = this._initResponse(correlationId);
			response.results = user;
			return response;
		}
		catch (err) {
			return this._error('BaseAdminMongoRepository', 'updateFromExternal', null, err, null, null, correlationId);
		}
	}

	async updatePlan(correlationId, id, planId) {
		const collection = await this._getCollectionUsers(correlationId);

		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(correlationId, client);
		try {
			await this._transactionStart(correlationId, session);

			const user = await this._findOne(correlationId, collection, {'id': id});
			if (!user)
				return this._error('BaseUserMongoRepository', 'updatePlan', 'No user found.', null, null, null, correlationId);
			user.planId = planId;
			user.updatedTimestamp = LibraryMomentUtility.getTimestamp();
			const response = this._initResponse(correlationId);
			response.results = user;

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err, 'BaseUserMongoRepository', 'updatePlan');
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	async updateSettings(correlationId, id, settings) {
		const collection = await this._getCollectionUsers(correlationId);

		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(correlationId, client);
		try {
			await this._transactionStart(correlationId, session);

			const data = await this._findOne(correlationId, collection, { 'id': id });
			if (data) {
				data.settings = settings;
				data.updatedTimestamp = LibraryMomentUtility.getTimestamp();
				const results = await collection.replaceOne({ 'id': id }, data, { upsert: true });
				if (!this._checkUpdate(correlationId, results))
					return this._error('BaseUserMongoRepository', 'updateSettings', 'Invalid settings update.', null, null, null, correlationId);
			}
			const response = this._initResponse(correlationId);
			response.results = data;

			await this._transactionCommit(correlationId, session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, correlationId, session, null, err, 'BaseUserMongoRepository', 'updateSettings');
		}
		finally {
			await this._transactionEnd(correlationId, session);
		}
	}

	_externalUserProjection(projection) {
	}

	async _getCollectionPlans(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionPlans());
	}

	async _getCollectionUsers(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsers());
	}

	_getDefaultPlan() {
		throw new NotImplementedError();
	}
}

export default BaseUserMongoRepository;
