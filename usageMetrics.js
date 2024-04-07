import MongoRepository from './index.js';

class UsageMetricsMongoRepository extends MongoRepository {
	async register(usageMetrics) {
		const correlationId = usageMetrics ? usageMetrics.correlationId : null;
		const collection = await this._getCollectionUsageMetrics(correlationId);
		await collection.insertOne(usageMetrics);
		return this._success(correlationId);
	}

	async listing(correlationId, params) {
		try {
			const collection = await this._getCollectionMeasurementsUsageMetrics(correlationId);
	
			const queryMatch = [];
			const queryGroup = {
				type: '$metadata.type'
			};
			if (params && params.date) {
				queryMatch.push({
					$match: { timestamp: { $gte: new Date(params.date) } }
				});
				const unit = params.unit ?? 'month';
				const number = params.number ?? 1;
				queryGroup.date = {
					$dateTrunc: {
						date: '$timestamp',
						unit: unit,
						binSize: number
					}
				};
			}

			let querySort = {};
			if (params &&  params.sort) {
				let id;
				for (let item of params.sort) {
					id = (item.id !== 'value' ? '_id.' : '') + item.id;
					querySort[id] = item.dir === false ? -1 : 1
				}
			}
			else
				querySort = {
					value: -1,
					'_id.type': 1
				};
	
			const queryA = [
				...queryMatch,
				{
					$group: {
						_id: queryGroup,
						value: {
						  $count: {},
						}
					}
				},
				{
					$sort: querySort
				}
			];

			const results = await collection.aggregate(queryA).toArray();
			return this._successResponse(results, correlationId);
		}
		catch (err) {
			return this._error('AppUsageMetricsRepository', 'listing', null, err, null, null, correlationId);
		}
	}

	async tag(correlationId, userId, tag) {
		try {
			const collection = await this._getCollectionMeasurementsUsageMetrics(correlationId);
			const response = this._initResponse(correlationId);
	
			await collection.insertOne({
				timestamp: new Date(),
				metadata: { 
					userId: userId,
					type: tag.type,
					mobile: tag.mobile ?? false
				},
				value: tag.value ? Number(tag.value) : 1
			});

			return response;
		}
		catch (err) {
			return this._error('AppUsageMetricsRepository', 'tag', null, err, null, null, correlationId);
		}
	}

	async _getCollectionMeasurementsUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetricsMeasurements(correlationId));
	}

	async _getCollectionUsageMetrics(correlationId) {
		return await this._getCollectionFromConfig(correlationId, this._collectionsConfig.getCollectionUsageMetrics());
	}
}

export default UsageMetricsMongoRepository;
