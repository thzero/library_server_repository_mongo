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
			return this._error('BaseUserMongoRepository', 'fetch', null, err, null, null, correlationId);
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
				if (this._hasSucceeded(planResponse))
					response.results.plan = planResponse.results;
			}
	
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'fetchByExternalId', null, err, null, null, correlationId);
		}
	}

	async fetchByGamerId(correlationId, gamerId, excludePlan) {
		try {
			const response = this._initResponse(correlationId);

			const collectionUsers = await this._getCollectionUsers(correlationId);
			response.results = await this._findOne(correlationId, collectionUsers, { 'gamerId': gamerId });
			response.success = response.results !== null;
	
			if (!excludePlan && this._hasSucceeded(response) && response.results) {
				const planResponse = await this._repositoryPlans.find(correlationId, response.results.planId, {
					'roles': 0
				});
				if (this._hasSucceeded(planResponse))
					response.results.plan = planResponse.results;
			}
	
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'fetchByGamerId', null, err, null, null, correlationId);
		}
	}

	async fetchByGamerTag(correlationId, gamerTag, excludePlan) {
		try {
			const response = this._initResponse(correlationId);

			const collectionUsers = await this._getCollectionUsers(correlationId);
			response.results = await this._findOne(correlationId, collectionUsers, { 'settings.gamerTag': gamerTag });
			response.success = response.results !== null;
	
			if (!excludePlan && this._hasSucceeded(response) && response.results) {
				const planResponse = await this._repositoryPlans.find(correlationId, response.results.planId, {
					'roles': 0
				});
				if (this._hasSucceeded(planResponse))
					response.results.plan = planResponse.results;
			}
	
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'fetchByGamerTag', null, err, null, null, correlationId);
		}
	}

	// One read. The transaction that wrapped it never received the session, so it
	// was a session checkout and an empty commit around a single findOne.
	async refreshSettings(correlationId, userId) {
		try {
			const collection = await this._getCollectionUsers(correlationId);
			const response = this._initResponse(correlationId);
			response.results = await this._findOne(correlationId, collection, { 'id': userId });
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'refreshSettings', null, err, null, null, correlationId);
		}
	}

	async updateFromExternal(correlationId, id, user) {
		try {
			const timestamp = LibraryMomentUtility.getTimestamp();
			const collection = await this._getCollectionUsers(correlationId);
			user.updatedTimestamp = timestamp;
			// This path is a deliberate create-or-update, so the upsert stays. But
			// replaceOne writes the whole document: without these the created fields
			// were never set on insert and were erased on update.
			if (!user.createdTimestamp)
				user.createdTimestamp = timestamp;
			if (!user.createdUserId)
				user.createdUserId = user.id ?? id;

			const results = await collection.replaceOne({ 'id': id }, user, {upsert: true});
			// _checkUpdate returns a Response, which is always truthy; test it with _hasFailed.
			const responseUpdate = this._checkUpdate(correlationId, results);
			if (this._hasFailed(responseUpdate))
				return this._error('BaseUserMongoRepository', 'updateFromExternal', 'Invalid user update.', null, null, null, correlationId);
	
			const response = this._initResponse(correlationId);
			response.results = user;
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'updateFromExternal', null, err, null, null, correlationId);
		}
	}

	// One round trip that writes. This read the user, set planId and the
	// timestamp on the copy, and returned that without ever writing it, inside a
	// transaction that never received the session: the plan change was not
	// persisted.
	async updatePlan(correlationId, id, planId) {
		try {
			const collection = await this._getCollectionUsers(correlationId);
			const user = await this._updateFields(correlationId, collection, id, { planId: planId });
			if (!user)
				return this._error('BaseUserMongoRepository', 'updatePlan', 'No user found.', null, null, null, correlationId);

			const response = this._initResponse(correlationId);
			response.results = user;
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'updatePlan', null, err, null, null, correlationId);
		}
	}

	// One round trip. This was a findOne and then a replaceOne of the whole
	// document to change two fields, inside a transaction that never received the
	// session. results is the document as written, or null for no such user, as
	// before.
	async updateSettings(correlationId, id, settings) {
		try {
			const collection = await this._getCollectionUsers(correlationId);
			const response = this._initResponse(correlationId);
			response.results = await this._updateFields(correlationId, collection, id, { settings: settings });
			return response;
		}
		catch (err) {
			return this._error('BaseUserMongoRepository', 'updateSettings', null, err, null, null, correlationId);
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

	// $set of the fields plus updatedTimestamp, returning the document as written,
	// or null when there is no such user.
	async _updateFields(correlationId, collection, id, fields) {
		return await collection.findOneAndUpdate(
			{ 'id': id },
			{ $set: { ...fields, updatedTimestamp: LibraryMomentUtility.getTimestamp() } },
			{ returnDocument: 'after', projection: { '_id': 0 } });
	}
}

export default BaseUserMongoRepository;
