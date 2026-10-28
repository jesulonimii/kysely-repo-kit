import { PGlite } from "@electric-sql/pglite"
import { type Generated, Kysely, PostgresDialect } from "kysely"
import { createRepoBuilder } from "../../src/index.js"

export interface Meta {
    plan: string
    address?: { city: string }
}

export interface UsersTable {
    id: Generated<number>
    email: string
    name: string | null
    age: number | null
    role: Generated<string>
    meta: Meta | null
    created_at: Generated<Date>
    deleted_at: Date | null
}

export interface ProfilesTable {
    id: Generated<number>
    user_id: number
    bio: string | null
}

export interface PostsTable {
    id: Generated<number>
    user_id: number
    title: string
    stars: Generated<number>
    published_at: Date | null
    deleted_at: Date | null
}

export interface CommentsTable {
    id: Generated<number>
    post_id: number
    body: string
    deleted_at: Date | null
}

export interface TagsTable {
    id: Generated<number>
    name: string
}

export interface DB {
    users: UsersTable
    profiles: ProfilesTable
    posts: PostsTable
    comments: CommentsTable
    tags: TagsTable
}

const SCHEMA = `
create table users (
    id serial primary key,
    email text not null unique,
    name text,
    age int,
    role text not null default 'member',
    meta jsonb,
    created_at timestamptz not null default now(),
    deleted_at timestamptz
);
create table profiles (id serial primary key, user_id int not null unique references users(id), bio text);
create table posts (
    id serial primary key,
    user_id int not null references users(id),
    title text not null,
    stars int not null default 0,
    published_at timestamptz,
    deleted_at timestamptz
);
create table comments (id serial primary key, post_id int not null references posts(id), body text not null, deleted_at timestamptz);
create table tags (id serial primary key, name text not null unique);
`

const SEED = `
truncate comments, posts, profiles, users, tags restart identity cascade;
insert into users (id, email, name, age, role, meta, created_at, deleted_at) values
    (1, 'ada@x.io', 'Ada', 36, 'admin', '{"plan":"pro","address":{"city":"London"}}', '2026-01-10T00:00:00Z', null),
    (2, 'BOB@x.io', 'Bob', 25, 'member', '{"plan":"free","address":{"city":"Paris"}}', '2026-02-10T00:00:00Z', null),
    (3, 'cy@x.io', null, null, 'member', null, '2026-03-10T00:00:00Z', null),
    (4, 'dee@x.io', 'Dee', 40, 'member', '{"plan":"pro"}', '2026-04-10T00:00:00Z', '2026-05-01T00:00:00Z');
select setval('users_id_seq', 4);
insert into profiles (id, user_id, bio) values (1, 1, 'Mathematician');
select setval('profiles_id_seq', 1);
insert into posts (id, user_id, title, stars, published_at, deleted_at) values
    (1, 1, 'Hello World', 5, '2026-01-15T00:00:00Z', null),
    (2, 1, 'Second', 1, null, null),
    (3, 2, 'Bob Post', 3, '2026-02-15T00:00:00Z', null),
    (4, 1, 'Old', 9, null, '2026-03-01T00:00:00Z');
select setval('posts_id_seq', 4);
insert into comments (id, post_id, body, deleted_at) values
    (1, 1, 'nice', null),
    (2, 1, 'gone', '2026-03-01T00:00:00Z'),
    (3, 3, 'hey bob', null);
select setval('comments_id_seq', 3);
insert into tags (id, name) values (1, 'sql'), (2, 'ts');
select setval('tags_id_seq', 2);
`

// PGlite has one session, so each connect waits for the previous release to keep transactions apart.
function pglitePool(pg: PGlite) {
    let queue: Promise<void> = Promise.resolve()

    return {
        async connect() {
            let release!: () => void
            const previous = queue
            queue = new Promise<void>(resolve => (release = resolve))
            await previous
            return { query: (text: string, params: unknown[]) => pg.query(text, params), release }
        },
        async end() {
            await pg.close()
        },
    }
}

export interface TestDb {
    pg: PGlite
    db: Kysely<DB>
    reset: () => Promise<void>
    queries: string[]
}

export async function createTestDb(): Promise<TestDb> {
    const pg = new PGlite()
    await pg.exec(SCHEMA)

    const queries: string[] = []
    const db = new Kysely<DB>({
        dialect: new PostgresDialect({ pool: pglitePool(pg) as any }),
        log: event => {
            if (event.level === "query") queries.push(event.query.sql)
        },
    })

    return {
        pg,
        db,
        queries,
        reset: async () => {
            await pg.exec(SEED)
            queries.length = 0
        },
    }
}

export function buildRepos() {
    const builder = createRepoBuilder<DB>()

    const CommentRepo = builder.table("comments", { softDelete: "deleted_at" }).init

    const PostRepo = builder
        .table("posts", { softDelete: "deleted_at" })
        .populate({ as: "author", ref: "users", localKey: "user_id" })
        .populate({
            as: "comments",
            ref: "comments",
            foreignKey: "post_id",
            nestedPopulations: () => ({}),
        })
        .init

    const UserRepo = builder
        .table("users", { softDelete: "deleted_at" })
        .populate({ as: "profile", ref: "profiles", foreignKey: "user_id", justOne: true })
        .populate({
            as: "posts",
            ref: "posts",
            foreignKey: "user_id",
            nestedPopulations: () => PostRepo.populations,
        })
        .init

    const TagRepo = builder.table("tags").init

    return { UserRepo, PostRepo, CommentRepo, TagRepo }
}

export function sortById<T extends { id: number }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => a.id - b.id)
}

export function ids(rows: { id: number }[]): number[] {
    return rows.map(r => r.id).sort((a, b) => a - b)
}
