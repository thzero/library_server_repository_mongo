![GitHub package.json version](https://img.shields.io/github/package-json/v/thzero/library_server_repository_mongo)
![David](https://img.shields.io/david/thzero/library_server_repository_mongo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# library_server_repository_mongo

MongoDB repositories for [@thzero/library_server](https://github.com/thzero/library_server), built on the official [mongodb](https://www.mongodb.com/docs/drivers/node/current/) driver.

Supplies the repository base every data access class derives from, plus ready-made repositories for the entities the framework itself needs — users, plans, news, usage metrics.

## Requirements

### NodeJs

[NodeJs](https://nodejs.org) version 22+

### MongoDb

A reachable MongoDB server, local or hosted. [MongoDb Atlas](https://www.mongodb.com/cloud/atlas) is the recommendation for development.

Useful tools: [MongoDb Compass](https://www.mongodb.com/products/compass), [Robo3T](https://robomongo.org).

### Installation

[![NPM](https://nodei.co/npm/@thzero/library_server_repository_mongo.png?compact=true)](https://npmjs.org/package/@thzero/library_server_repository_mongo)

```
npm install @thzero/library_server_repository_mongo
```

#### Peer dependencies

* `@thzero/library_common`
* `@thzero/library_common_service`
* `@thzero/library_server`

## What it provides

### `index.js` — `MongoRepository`

The base every other repository here extends. Connection and database handles are cached in **static** maps, so all repositories in a process share one client per configured name and one database handle per client and database — opening is guarded by a mutex, so concurrent first calls open exactly one.

| Group | Members |
|---|---|
| Connection | `_getClient`, `_initializeClient`, `_initializeDb`, `_initClientName` |
| Collections | `_getCollection(correlationId, clientName, collectionName, databaseName)`, `_getCollectionFromConfig(correlationId, config)` |
| Read | `_find`, `_findOne`, `_fetch`, `_count`, `_fetchExtract`, `_fetchExtract2` |
| Aggregate | `_aggregate`, `_aggregate2`, `_aggregateCount`, `_aggregateCount2`, `_aggregateExtract`, `_aggregateExtract2`, `_aggregateExtract3` |
| Write | `_create`, `_update`, `_delete`, `_deleteOne`, `_checkUpdate` |
| Transactions | `_transactionInit`, `_transactionStart`, `_transactionCommit`, `_transactionAbort`, `_transactionEnd` |
| Search | `_searchFilterText`, `_searchFilterTextType` |

Behaviour worth knowing:

* `_find` and `_findOne` suppress `_id` unless the caller's projection asks for it.
* The `_aggregate*` helpers build a new pipeline rather than mutating the array they are handed, so a pipeline can be reused across calls.
* `_create` stamps `createdTimestamp`, `createdUserId`, `updatedTimestamp` and `updatedUserId` from a single clock reading, and generates an `id` only when one was not supplied.
* `_update` uses `replaceOne` with `upsert: false` — it updates, it never silently creates.
* `_checkUpdate` returns a `Response`, which is always truthy. Test it with `_hasFailed`, never with `if (!...)`.

### Entity repositories

| File | Class | Purpose |
|---|---|---|
| `baseUser.js` | `BaseUserMongoRepository` | Users — fetch by id, external id, gamer id or gamer tag; settings; plan; `updateFromExternal` create-or-update from the identity provider |
| `plans.js` | `PlansMongoRepository` | Plans — `find`, `listing` |
| `news.js` | `NewsMongoRepository` | News — `latest` |
| `usageMetrics.js` | `UsageMetricsMongoRepository` | Usage metrics — `register`, `listing`, `tag` |
| `pubSub.js` | `PubSubMongoRepository` | A change-stream based `listen` / `send` |
| `admin/index.js` | `BaseAdminMongoRepository` | Admin CRUD — `create`, `delete`, `fetch`, `search`, `update`, each in a transaction. Gate them by overriding `_allowsCreate`, `_allowsDelete`, `_allowsUpdate`. |
| `admin/baseNews.js`, `admin/baseUsers.js` | | Admin repositories for news and users |

### `collections/` — collection resolution

`BaseCollectionsService` turns a collection name into the `{ clientName, collectionName, databaseName }` triple that `_getCollectionFromConfig` consumes, resolving the database name from config. `BaseApiCollectionsService` reads the client name from `db.default`. Subclass and add a `getCollectionX()` per collection:

```js
class AppCollectionsService extends UserApiCollectionsService {
    static CollectionUsers = 'users';

    getCollectionUsers(correlationId) {
        return this._getCollection(correlationId, this.getClientName(), AppCollectionsService.CollectionUsers);
    }
}
```

Register it under `SERVICE_REPOSITORY_COLLECTIONS` from `library_server_repository_mongo/constants.js`.

## Configuration

```json
{
    "app": {
        "db": {
            "default": "mongo",
            "mongo": {
                "connection": "<mongo connection string>",
                "name": "<database name>",
                "search": {
                    "text": "text"
                }
            }
        }
    }
}
```

* **`db.default`** — the client name `BaseApiCollectionsService.getClientName()` returns. More than one client can be configured side by side (`mongo`, `atlas`, …) and selected per collection.
* **`db.<client>.connection`** — the driver connection string. Required; a missing one throws at boot rather than at the first query.
* **`db.<client>.name`** — the database. Resolution order is: the name passed by the caller, then `db.<client>.name`, then `db.name`. A caller-supplied name always wins.
* **`db.<client>.search.text`** — `text` for a normal text index, anything else (`atlas`) to disable `_searchFilterText`, which then returns `null` and lets the repository build its own filter.

### Environment variable overrides

Supplied by the application's `config/custom-environment-variables.json`; the framework's convention is `DB_DEFAULT`, `DB_CONNECTION_<CLIENT>`, `DB_NAME_<CLIENT>`.

## Wiring it up

Register the collections service and any repositories from your `BootMain` derived class or a boot plugin:

```js
import usageMetricsRepository from '@thzero/library_server_repository_mongo/usageMetrics.js';

class AppBootMain extends BootMain {
    _initRepositoriesUsageMetrics() {
        return new usageMetricsRepository();
    }
}
```

## Development

```
npm run lint       # eslint .
npm run lint:fix   # eslint . --fix
npm test           # node --test "test/*.test.js"
```

The tests use a recording fake collection rather than a live MongoDB, so they run without a server.
