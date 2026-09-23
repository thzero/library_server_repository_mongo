import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';

import MongoRepository from './index.js';

class PlansMongoRepository extends MongoRepository {
	constructor() {
		super();

		// id -> { time, plan }. Plans are few and rarely change, and one is read
		// with every user fetch, so inside the ttl a find is served from here
		// rather than being a second round trip on the auth and profile paths.
		this._planCache = new Map();
		this._planCacheTtlMs = 5 * 60 * 1000;
	}

	async find(correlationId, planId, project) {
		const response = this._initResponse(correlationId);

		// An exclusion projection ({ roles: 0 }) is applied to a copy of the cached
		// document. Anything else goes to the database with the projection as
		// given, so the cache never has to reproduce the driver's rules.
		if (project && !this._isExclusion(project)) {
			const collectionPlan = await this._getCollectionPlans(correlationId);
			response.results = await this._findOne(correlationId, collectionPlan, { 'id': planId }, project);
			return response;
		}

		response.results = this._exclude(await this._findCached(correlationId, planId), project);
		return response;
	}

	// Drops what is cached, for a host that writes plans and wants the change seen
	// before the ttl runs out. With no id, everything.
	invalidate(planId) {
		if (planId === undefined || planId === null)
			this._planCache.clear();
		else
			this._planCache.delete(planId);
	}

	async listing(correlationId) {
		const collection = await this._getCollectionPlans(correlationId);
		const response = this._initResponse(correlationId);
		// response.results = await this._fetchExtract(correlationId, await this._count(correlationId, collection, {}), await this._find(correlationId, collection, {}), this._initResponseExtract());
		response.results = await this._fetchExtract(correlationId, collection, {}, this._initResponseExtract(correlationId));
		return response;
	}

	// A copy without the excluded keys. A copy even with no projection, so a
	// caller that decorates the result does not decorate the cached document.
	_exclude(plan, project) {
		if (!plan)
			return plan;

		const copy = { ...plan };
		if (!project)
			return copy;

		for (const key of Object.keys(project))
			delete copy[key];
		return copy;
	}

	async _findCached(correlationId, planId) {
		const cached = this._planCache.get(planId);
		if (cached && ((LibraryMomentUtility.getTimestamp() - cached.time) <= this._planCacheTtlMs))
			return cached.plan;

		const collectionPlan = await this._getCollectionPlans(correlationId);
		const plan = await this._findOne(correlationId, collectionPlan, { 'id': planId });
		if (plan)
			this._planCache.set(planId, { time: LibraryMomentUtility.getTimestamp(), plan: plan });
		else
			this._planCache.delete(planId);
		return plan;
	}

	async _getCollectionPlans(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionPlans(correlationId));
	}

	_isExclusion(project) {
		const keys = Object.keys(project);
		if (keys.length === 0)
			return true;
		return keys.every((key) => project[key] === 0 || project[key] === false);
	}
}

export default PlansMongoRepository;
