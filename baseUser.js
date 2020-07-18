import Utility from '@thzero/library/utility';

import NotImplementedError from '@thzero/library/errors/notImplemented';

import MongoRepository from './index';

class BaseUserMongoRepository extends MongoRepository {
	async fetch(correlationId, userId, excludePlan) {
		const response = this._initResponse();

		const collectionUsers = await this._getCollectionUsers();
		response.results = await this._findOne(collectionUsers, {'id': userId});
		response.success = response.results !== null;

		if (!excludePlan && response && response.success && response.results) {
			const collectionPlan = await this._getCollectionPlans();
			response.results.plan = await this._findOne(collectionPlan, {'id': response.results.planId});
		}

		return response;
	}

	async updateFromExternal(correlationId, id, user) {
		const timestamp = Utility.getTimestamp();
		const collection = await this._getCollectionUsers();
		user.updatedTimestamp = timestamp;

		const results = await collection.replaceOne({ 'id': id }, user, {upsert: true});
		if (!this._checkUpdate(results))
			return this._error('Invalid user update.');

		const response = this._initResponse();
		response.results = user;
		return response;
	}

	async updatePlan(correlationId, id, planId) {
		const collection = await this._getCollectionUsers();

		const client = await this._getClient();
		const session = await this._transactionInit(client);
		try {
			await this._transactionStart(session);

			const user = await this._findOne(collection, {'id': id});
			if (!user)
				return this._error('No user found.');
			user.planId = planId;
			user.updatedTimestamp = Utility.getTimestamp();
			const response = this._initResponse();
			response.results = user;

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

	async updateSettings(correlationId, id, settings) {
		const collection = await this._getCollectionUsers();

		const client = await this._getClient();
		const session = await this._transactionInit(client);
		try {
			await this._transactionStart(session);

			const data = await this._findOne(collection, { 'id': id });
			if (data) {
				data.settings = settings;
				data.updatedTimestamp = Utility.getTimestamp();
				const results = await collection.replaceOne({ 'id': id }, data, { upsert: true });
				if (!this._checkUpdate(results))
					return this._error('Invalid settings update.');
			}
			const response = this._initResponse();
			response.results = data;

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

	_externalUserProjection(projection) {
	}

	async _getCollectionPlans() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionPlans());
	}

	async _getCollectionUsers() {
		return await this._getCollectionFromConfig(this._collectionsConfig.getCollectionUsers());
	}

	_getDefaultPlan() {
		throw new NotImplementedError();
	}
}

export default BaseUserMongoRepository;
