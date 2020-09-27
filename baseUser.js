import LibraryConstants from '@thzero/library_server/constants';

import Utility from '@thzero/library_common/utility';

import NotImplementedError from '@thzero/library_common/errors/notImplemented';

import MongoRepository from './index';

class BaseUserMongoRepository extends MongoRepository {
	async init(injector) {
		await super.init(injector);

		this._repositoryPlans = this._injector.getService(LibraryConstants.InjectorKeys.REPOSITORY_PLANS);
	}

	async fetch(correlationId, userId, excludePlan) {
		const response = this._initResponse(correlationId);

		const collectionUsers = await this._getCollectionUsers(correlationId);
		response.results = await this._findOne(collectionUsers, {'id': userId});
		response.success = response.results !== null;

		if (!excludePlan && response && response.success && response.results) {
			const planResponse = await this._repositoryPlans.find(correlationId, response.results.planId);
			if (planResponse.success)
				response.results.plan = planResponse.results;
		}

		return response;
	}

	async fetchByExternalId(correlationId, userId, excludePlan) {
		const response = this._initResponse(correlationId);

		const collectionUsers = await this._getCollectionUsers(correlationId);
		response.results = await this._findOne(collectionUsers, { 'external.id': userId });
		response.success = response.results !== null;

		if (!excludePlan && response && response.success && response.results) {
			const planResponse = await this._repositoryPlans.find(correlationId, response.results.planId, {
				'roles': 0
			});
		}

		return response;
	}

	async updateFromExternal(correlationId, id, user) {
		const timestamp = Utility.getTimestamp();
		const collection = await this._getCollectionUsers(correlationId);
		user.updatedTimestamp = timestamp;

		const results = await collection.replaceOne({ 'id': id }, user, {upsert: true});
		if (!this._checkUpdate(results))
			return this._error('BaseUserMongoRepository', 'updateFromExternal', 'Invalid user update.', null, null, null, correlationId);

		const response = this._initResponse(correlationId);
		response.results = user;
		return response;
	}

	async updatePlan(correlationId, id, planId) {
		const collection = await this._getCollectionUsers(correlationId);

		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(client);
		try {
			await this._transactionStart(session);

			const user = await this._findOne(collection, {'id': id});
			if (!user)
				return this._error('BaseUserMongoRepository', 'updatePlan', 'No user found.', null, null, null, correlationId);
			user.planId = planId;
			user.updatedTimestamp = Utility.getTimestamp();
			const response = this._initResponse(correlationId);
			response.results = user;

			await this._transactionCommit(session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err);
		}
		finally {
			await this._transactionEnd(session);
		}
	}

	async updateSettings(correlationId, id, settings) {
		const collection = await this._getCollectionUsers(correlationId);

		const client = await this._getClient(correlationId);
		const session = await this._transactionInit(client);
		try {
			await this._transactionStart(session);

			const data = await this._findOne(collection, { 'id': id });
			if (data) {
				data.settings = settings;
				data.updatedTimestamp = Utility.getTimestamp();
				const results = await collection.replaceOne({ 'id': id }, data, { upsert: true });
				if (!this._checkUpdate(results))
					return this._error('BaseUserMongoRepository', 'updateSettings', 'Invalid settings update.', null, null, null, correlationId);
			}
			const response = this._initResponse(correlationId);
			response.results = data;

			await this._transactionCommit(session);
			return response;
		}
		catch (err) {
			return this._transactionAbort(correlationId, session, null, err);
		}
		finally {
			await this._transactionEnd(session);
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
