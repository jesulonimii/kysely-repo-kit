# Kysely Repo Kit 🛡️🚀

A fully typed repository, relation population, and hook layer for [Kysely](https://github.com/kysely-org/kysely). 

`kysely-repo-kit` provides a declarative, type-safe API to construct repositories with native soft-delete support, life-cycle hooks, complex filtering (`AND`, `OR`, `NOT`, `jsonb`, and raw expressions), and nested relation populating using high-performance JSON helpers.

---

## Features

- **🛡️ 100% Type-Safe**: Complete autocomplete and compile-time type safety for inserts, updates, filters, selects, and nested population.
- **🔄 Auto-Population**: Effortlessly load relations (1-to-1 or 1-to-many) using native, highly optimized Postgres JSON helper functions (`jsonArrayFrom`, `jsonObjectFrom`).
- **🪝 Lifecycle Hooks**: Intercept database actions using `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, and `afterDelete`.
- **🗑️ Native Soft Delete**: Easily set up table-wide soft deletes. Safely filter out deleted records automatically across queries and populations.
- **🧩 Power Queries**: Multi-faceted filter system supporting nested `AND` / `OR` / `NOT`, Case-insensitive text searches, Jsonb paths filtering, and raw SQL escapes.
- **🕵️ Default Column Selection**: Configure a repo-wide default `select` (inclusion or exclusion) that per-query `select` options merge with, not replace.
- **🤝 Transaction Session Propagation**: Easily pass Kysely transactions down using `.withSession(tx)`.

---

## Installation

```bash
# With pnpm (recommended)
pnpm add kysely-repo-kit

# With npm
npm install kysely-repo-kit

# With yarn
yarn add kysely-repo-kit

# With bun
bun add kysely-repo-kit
```

*Note: `kysely` is a peer dependency of this library and must be installed in your project.*

---

## Quick Start

### 1. Define your Database Schema & Types

Let's assume you have a typical Kysely database definition:

```typescript
import { Kysely } from 'kysely';

export interface UserTable {
  id: string;
  email: string;
  name: string;
  created_at: Date;
  deleted_at: Date | null;
}

export interface PostTable {
  id: string;
  title: string;
  content: string;
  author_id: string;
  created_at: Date;
}

export interface Database {
  users: UserTable;
  posts: PostTable;
}

export const db = new Kysely<Database>({ ... });
```

### 2. Create the Repository Builder

Create a single instance of your repository builder associated with your `Database` type:

```typescript
import { createRepoBuilder } from 'kysely-repo-kit';
import { Database } from './db';

export const repoBuilder = createRepoBuilder<Database>();
```

### 3. Build & Define Your Repositories

Using the builder, we declare relations, soft delete rules, hooks, and compile them into executable repository classes.

```typescript
import { repoBuilder } from './builder';

// Define PostRepository
export const PostRepository = repoBuilder
  .table('posts')
  .init;

// Define UserRepository with soft delete, hooks, and relationships
export const UserRepository = repoBuilder
  .table('users')
  .softDelete('deleted_at') // Automatically filters out soft-deleted users
  .hooks({
    beforeCreate: (data) => {
      // Intercept and mutate data before inserting
      return { ...data, name: data.name.trim() };
    },
    afterCreate: (user) => {
      console.log(`User created: ${user.email}`);
    }
  })
  .populate({
    as: 'posts',
    ref: 'posts',
    foreignKey: 'author_id', // links posts.author_id to users.id
  })
  .init;
```

### 4. Perform Queries

Instantiate the repository classes with your Kysely database instance.

```typescript
import { db } from './db';
import { UserRepository } from './repositories';

const userRepo = new UserRepository(db);

// 1. Create a user
const newUser = await userRepo.create({
  data: {
    id: 'user-1',
    email: 'alice@example.com',
    name: ' Alice ',
  }
}); // Hooks trim name automatically! -> 'Alice'

// 2. Query with type-safe nested relations population
const userWithPosts = await userRepo.findFirst({
  where: { id: 'user-1' },
  populate: {
    posts: true // Auto-loaded via Postgres JSON serialization
  }
});

console.log(userWithPosts?.posts); // Type-safe Array of Post records!
```

---

## Detailed Usage Guide

### CRUD Interface

Every generated repository inherits from `BaseRepository` and exposes the following API:

#### Retrieve Queries
* **`findMany({ where, select, populate, skip, take, orderBy, lock, includeDeleted })`**
* **`findFirst({ where, select, populate, lock, includeDeleted })`**
* **`findUnique({ where: { id }, select, populate, includeDeleted })`**
* **`count({ where, includeDeleted })`**
* **`exists({ where, includeDeleted })`**

#### Mutation Queries
* **`create({ data, select })`**
* **`createMany({ data })`**
* **`update({ where, data, select })`**
* **`updateUnique({ where: { id }, data, select })`**
* **`updateMany({ where, data })`**
* **`upsert({ where, create, update })`**
* **`delete({ where })`** (performs soft-delete if enabled, otherwise hard-delete)
* **`softDelete({ where, deletedAt })`** (explicitly soft-delete records)
* **`hardDelete({ where })`** (explicitly hard-delete records)
* **`deleteUnique({ where: { id } })`**
* **`deleteMany({ where })`**

---

### Rich Filtering (`WhereFilter`)

`kysely-repo-kit` provides a powerful, type-safe filtering engine. 

```typescript
const activePremiumUsers = await userRepo.findMany({
  where: {
    // 1. Column filters with specific matching options
    name: {
      contains: 'John',
      mode: 'insensitive', // case-insensitive LIKE
    },
    // 2. OR / AND / NOT operators
    OR: [
      { email: { endsWith: '@gmail.com' } },
      { email: { endsWith: '@outlook.com' } }
    ],
    // 3. Raw Kysely expression fallback
    _raw: (eb) => eb('created_at', '>', sql`NOW() - INTERVAL '30 days'`)
  }
});
```

#### JSONB Filtering
Filter records by deeply nested keys within Postgres `JSONB` columns using type-safe path matching:

```typescript
const users = await userRepo.findMany({
  where: {
    jsonb: {
      'metadata.profile.theme': 'dark', // Type-safe leaf path matching!
      'metadata.loginCount': { gte: 10 }
    }
  }
});
```

---

### Default Column Selection

Configure a repo-wide default `select` with `.defaultSelect(...)` on the builder. It supports two shapes:

- **Exclusion (blacklist)** — mark a column `false` to hide it everywhere by default, while every other column stays visible:
  ```typescript
  export const UserRepository = repoBuilder
    .table('users')
    .defaultSelect({ password: false }) // hide `password` unless a query asks for it
    .init;

  await userRepo.findFirst({}); 
  // -> { id, email, name, created_at }  (no password)
  ```

- **Inclusion (whitelist)** — mark columns `true` to return *only* those columns by default:
  ```typescript
  export const UserRepository = repoBuilder
    .table('users')
    .defaultSelect({ id: true, email: true, name: true })
    .init;

  await userRepo.findFirst({});
  // -> { id, email, name }
  ```

A per-query `select` **merges** with the default rather than replacing it outright — the query only overrides the specific columns it mentions:

```typescript
// Repo default: { password: false }
await userRepo.findFirst({ select: { password: true } });
// -> un-hides `password` for this query only; every other column is still returned

// Repo default: { id: true, email: true, name: true }
await userRepo.findFirst({ select: { name: false } });
// -> { id, email }  (query removes `name` from the default include set)

await userRepo.findFirst({ select: { created_at: true } });
// -> { id, email, name, created_at }  (query adds a column to the default include set)
```

Whether a `select` behaves as a whitelist or a blacklist is determined by the repo's `defaultSelect` (if one is configured — a whitelist default keeps you in "only these columns" mode, a blacklist default keeps you in "everything except these columns" mode). With no `defaultSelect` configured at all, a bare `select: { column: true }` on its own behaves exactly as an inclusion-only whitelist for that one query, same as before this feature existed.

This applies everywhere a `select` option is accepted: `findMany`, `findFirst`, `findUnique`, `create`, `update`, and `updateUnique`.

---

### Relation Populations

To populate complex, deeply nested relational schemas, declare relationship rules on the builder:

```typescript
export const OrganisationRepository = repoBuilder
  .table('organisations')
  .init;

export const UserRepository = repoBuilder
  .table('users')
  .populate({
    as: 'org',
    ref: 'organisations',
    foreignKey: 'id',
    localKey: 'org_id',
    justOne: true, // Populates as single object instead of an array
  })
  .populate({
    as: 'posts',
    ref: 'posts',
    foreignKey: 'author_id',
    nestedPopulations: () => ({
      // Recursively nest population options!
      comments: definePopulation({
        table: 'comments',
        foreignKey: 'post_id',
      })
    })
  })
  .init;
```

Query with populated relations dynamically:
```typescript
const result = await userRepo.findMany({
  populate: {
    org: {
      select: { id: true, name: true } // Limit columns returned by relation
    },
    posts: {
      populate: {
        comments: true // Nested population loaded automatically!
      }
    }
  }
});
```

---

### Transactions & Session Propagation

To run operations safely within a database transaction, leverage the `.withSession()` method:

```typescript
await db.transaction().execute(async (tx) => {
  // Spawn repository instances bound to the transaction session
  const userRepoTx = userRepo.withSession(tx);
  const postRepoTx = new PostRepository(db).withSession(tx);

  const user = await userRepoTx.create({ data: { ... } });
  await postRepoTx.create({ data: { author_id: user.id, ... } });
});
```

---

## License

MIT © [jesulonimii](https://github.com/jesulonimii)
