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
| Connection | `_getClient`, `_initializeClient`, `_initializeDb`, `_initClientName`, `_getMongoClientOptions` |
| Collections | `_getCollection(correlationId, clientName, collectionName, databaseName, options)`, `_getCollectionFromConfig(correlationId, config, options)` |
| Read | `_find`, `_findOne`, `_fetch`, `_count`, `_fetchExtract`, `_fetchExtract2` |
| Aggregate | `_aggregate`, `_aggregate2`, `_aggregateCount`, `_aggregateCount2`, `_aggregateExtract`, `_aggregateExtract2`, `_aggregateExtract3` |
| Write | `_create`, `_update`, `_delete`, `_deleteOne`, `_checkUpdate` |
| Transactions | `_transactionInit`, `_transactionStart`, `_transactionCommit`, `_transactionAbort`, `_transactionEnd` |
| Search | `_searchFilterText`, `_searchFilterTextType` |
| Resilience | `_withMongoReconnect`, `_resetMongoConnection`, `_isMongoConnectivityError`, `_isMongoServerSelectionError`, `_shouldResetMongoClient` |
| Config | `_configGetOptional`, `_configGetCoerced` |

Behaviour worth knowing:

* `_find` and `_findOne` suppress `_id` unless the caller's projection asks for it.
* `_fetchExtract` is unpaged unless its trailing `options` carries a `skip` or `limit`. Unpaged, it is one query and `total` is the length of the data. Paged, it also counts, since a page cannot know the total otherwise. `options` may carry `sort` and `projection` as well.
* The `_aggregate*` helpers build a new pipeline rather than mutating the array they are handed, so a pipeline can be reused across calls.
* `_create` stamps `createdTimestamp`, `createdUserId`, `updatedTimestamp` and `updatedUserId` from a single clock reading, and generates an `id` only when one was not supplied.
* `_update` uses `replaceOne` with `upsert: false` — it updates, it never silently creates.
* `_checkUpdate` returns a `Response`, which is always truthy. Test it with `_hasFailed`, never with `if (!...)`.
* Both collection helpers take an optional trailing `options`, passed straight to the driver's `db.collection()` — per collection `writeConcern` / `readConcern`.

### Connection resilience

Wrap an operation in `_withMongoReconnect(correlationId, clientName, databaseName, operation)` and a connectivity failure is retried instead of surfacing:

```js
return await this._withMongoReconnect(correlationId, config?.clientName, config?.databaseName, async () => {
    // Re-resolve the collection per attempt - a handle cached across a retry
    // still points at the client that was just recycled.
    const collection = await this._getCollectionFromConfig(correlationId, config);
    return await collection.insertOne(document);
});
```

* Only connectivity errors are retried — network and server-selection errors, `timed out`, and the `ResetPool` / `InterruptInUseConnections` error labels, including through an error's `cause` chain. Everything else is rethrown untouched on the first attempt.
* Retries back off exponentially from `reconnectDelayMs`, capped at `reconnectMaxDelayMs`, up to `reconnectRetries` times.
* The shared client is only torn down and rebuilt when the topology itself is unreachable (a server-selection error), or from the second attempt onward. For a pool reset the driver recovers on its own, and recreating the client would kill healthy cursors — change streams especially — for nothing.
* A reset is serialized per client/database behind a mutex and generation counter, so concurrent failures rebuild the client once rather than each racing to replace it, and is rate limited by `reconnectResetCooldownMs`.
* The operation must let errors escape. Catching inside it hides the connectivity error from the retry and defeats it entirely.

### Entity repositories

| File | Class | Purpose |
|---|---|---|
| `baseUser.js` | `BaseUserMongoRepository` | Users — fetch by id, external id, gamer id or gamer tag; settings; plan; `updateFromExternal` create-or-update from the identity provider |
| `plans.js` | `PlansMongoRepository` | Plans: `find` (served from an in-memory cache per id for five minutes, since one is read with every user fetch; `invalidate(planId)` drops it early), `listing` |
| `news.js` | `NewsMongoRepository` | News — `latest` |
| `usageMetrics.js` | `UsageMetricsMongoRepository` | Usage metrics: `register` (buffered, see [Usage metrics buffer](#usage-metrics-buffer)), `listing`, `tag`, and `cleanup` for the shutdown flush |
| `pubSub.js` | `PubSubMongoRepository` | A change-stream based `listen` / `send` / `shutdown` — see [Pub/sub](#pubsub) |
| `admin/index.js` | `BaseAdminMongoRepository` | Admin CRUD — `create`, `delete`, `fetch`, `search`, `update`, each in a transaction. Gate them by overriding `_allowsCreate`, `_allowsDelete`, `_allowsUpdate`. `search` is unpaged unless the params carry a `skip` or `limit` (and optionally a `sort`); unpaged it is one query, paged it also counts over the match stages. The base search schema allows none of these, so an application adds them to its schema and has its UI send them. |
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

## Pub/sub

`PubSubMongoRepository` watches a collection's change stream and hands each inserted document to `_listen`. Implement one member:

| Member | Purpose |
|---|---|
| `_listen(correlationId, message)` | Called with `fullDocument` for each inserted document. The stream is filtered to inserts, so a TTL expiry is never delivered. |

Everything else resolves itself. The collection comes from the collections service's `getCollectionPubSub`, and it is opened with `{ writeConcern: { w: 'majority' } }` — a change stream only ever surfaces majority committed writes, so at the default `w: 1` a `send` can report success for an insert a later election rolls back, and that message is never delivered. That is a property of change streams rather than of any one application, so it is not left to each implementation to remember.

### Lifecycle

Register the repository and it runs itself — there is no boot hook to write:

| Hook | What happens |
|---|---|
| `initPost()` | Opens the change stream, as part of the boot's post-init sweep. Set `db.pubSubListen` false for a deployment that publishes but should not also consume, so it does not pay for a stream it never reads. |
| `cleanup(correlationId)` | Closes the stream and stops the reconnect timer and watchdog, as part of the boot's cleanup sweep. Without it those keep bringing the stream back while the process is trying to exit. |

`shutdown(correlationId)` remains as the explicit form, for a host that wants to stop pub/sub on its own terms rather than at shutdown.

Three optional overrides, in the order you are likely to want them:

| Member | Purpose |
|---|---|
| `_getCollectionPubSubOptions(correlationId)` | The collection options. Rarely needed — the write concern is already configurable as `db.<clientName>.pubSubWriteConcern` for one client or `db.pubSubWriteConcern` for every client. |
| `_getConfigPubSub(correlationId)` | The collection config, so the retry and any client reset act on the client that owns the collection. Defaults to `this._collectionsConfig.getCollectionPubSub(correlationId)`. |
| `_getCollectionPubSub(correlationId)` | The collection itself. Only for a collection the config cannot reach; overriding it takes the write concern into your hands. |

`send(correlationId, type, params, collection)` inserts `{ type, params, timestamp }`. `timestamp` is a `Date` so a Mongo TTL index can expire it.

### Staying connected

A change stream is not forever — a primary stepdown, a dropped connection or a client close all end it, and the driver only resumes what it deems a resumable error. Everything else used to leave the stream dead in silence, with pub/sub simply stopping. Now:

* **Resume tokens.** A reconnect continues from the last token, so nothing published during an outage is lost. Tokens advance on every batch, including empty ones, so an idle stream still moves its resume point forward.
* **Reconnect.** `error`, `close` and `end` all schedule one reconnect, backing off exponentially from 3s to a 60s ceiling with jitter so a fleet does not reconnect in lockstep. A generation counter discards events from a stream that has already been replaced.
* **Lost history.** If the resume token has aged out of the oplog (`ChangeStreamHistoryLost`, codes 286 / 280) it is dropped and the stream restarts from now, rather than retrying a resume that can never succeed.
* **Watchdog.** A 30s interval catches a stream that died without emitting anything, and reconnects it.
* **Client reset.** The shared client is only recycled when the failure was genuinely connectivity — a routine cursor close must not tear down every other repository.

The backoff and watchdog intervals are instance fields (`_restartDelayMs`, `_restartMaxDelayMs`, `_watchdogIntervalMs`), not configuration.

### Shutting down

```js
await this._repositoryPubSub.shutdown(correlationId);
```

Call this from the host's shutdown hook. Without it the reconnect timer keeps bringing the stream back while the process is trying to exit. The timers are `unref`'d, so they will not by themselves hold the event loop open.

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

### Driver options

Every option below is resolved **`db.<client>.<option>`, then `db.<option>`, then the default**. Anything still unset is left to the connection string. A value that will not coerce is ignored rather than overriding the next source, and an absent key falls through — so a configured `0` is honoured as a deliberate zero.

| Option | Type | Default | Notes |
|---|---|---|---|
| `maxIdleTimeMS` | uint | `60000` | Recycles pooled connections before an idle NAT or load balancer drops them without a FIN |
| `minPoolSize` | uint | `5` | Keeps a few warm, so a request after an idle period skips a fresh TLS handshake and auth |
| `maxPoolSize` | uint | `100` | |
| `maxConnecting` | uint | driver | |
| `waitQueueTimeoutMS` | uint | driver | |
| `serverSelectionTimeoutMS` | uint | `10000` | Surfaces an unreachable topology in seconds, not the driver's 30s which with retries becomes 90s of wall clock |
| `connectTimeoutMS` | uint | `10000` | |
| `socketTimeoutMS` | uint | unset | Deliberately unset — any useful value also kills change streams and long aggregations |
| `heartbeatFrequencyMS` | uint | `10000` | |
| `retryWrites` | boolean | `true` | |
| `retryReads` | boolean | `true` | |
| `w` | `majority` or uint | driver | |
| `readPreference` | string | driver | |
| `appName` | string | driver | |
| `compressors` | list | driver | Array, or a comma separated string |
| `zlibCompressionLevel` | uint | driver | |
| `tls` | boolean | driver | |

Booleans accept `true` / `false` / `1` / `0`, as strings or real booleans, so they survive being supplied as environment variables.

### Reconnect options

Same resolution order. These govern `_withMongoReconnect`.

| Option | Type | Default | Notes |
|---|---|---|---|
| `reconnectDelayMs` | uint | `300` | First backoff delay |
| `reconnectMaxDelayMs` | uint | `5000` | Ceiling on the backoff |
| `reconnectRetries` | uint | `2` | Retries before the error is rethrown |
| `reconnectBackoffMultiplier` | float ≥ 1 | `2` | |
| `reconnectCloseTimeoutMs` | uint | `5000` | How long to wait on closing the old client before abandoning it |
| `reconnectResetCooldownMs` | uint | `15000` | Minimum gap between client rebuilds, so a burst of failures cannot thrash the pool |

### Usage metrics buffer

`UsageMetricsMongoRepository.register` does not insert. It buffers the document and returns, and the buffer is written with one unordered `insertMany` when it reaches its size or the flush interval elapses, whichever comes first. One insert per response was a second database write for every request served.

Same resolution order as the driver options, against the usage metrics collection's client.

| Option | Type | Default | Notes |
|---|---|---|---|
| `usageMetricsBufferSize` | uint | `100` | Documents held before a flush is forced. `0` writes each one through as it arrives |
| `usageMetricsBufferFlushMs` | uint ≥ 1 | `1000` | Longest a document waits when the size is not reached |
| `usageMetricsBufferMax` | uint | `10000` | Ceiling on the buffer while the database is unreachable. Raised to the size if configured below it |

* **Shutdown.** The repository has a `cleanup(correlationId)`, which the boot's cleanup sweep calls for anything registered. It flushes what is still held and stops the timer. Anything registered after that is written through rather than held. The timer is `unref`'d, so it does not by itself keep the process open.
* **Outage.** A flush that fails on a connectivity error is requeued ahead of anything buffered since, and retried on the next interval rather than on the next request. A partial bulk write requeues only the documents the driver reports as not inserted, so a retry does not write duplicates. Past the ceiling the oldest documents are dropped; the outage, the drop, and the recovery are each logged once, with the dropped count on the recovery.
* **Write errors.** An error that is not connectivity, such as a duplicate key, will not pass on a retry and is dropped with a warning rather than left to poison the buffer.

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
