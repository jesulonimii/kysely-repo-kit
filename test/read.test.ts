import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createRepoBuilder } from "../src/index.js"
import { buildRepos, createTestDb, type DB, ids, type TestDb } from "./helpers/db.js"

let t: TestDb
let users: InstanceType<ReturnType<typeof buildRepos>["UserRepo"]>
let posts: InstanceType<ReturnType<typeof buildRepos>["PostRepo"]>
let tags: InstanceType<ReturnType<typeof buildRepos>["TagRepo"]>

beforeAll(async () => {
    t = await createTestDb()
    const repos = buildRepos()
    users = new repos.UserRepo(t.db)
    posts = new repos.PostRepo(t.db)
    tags = new repos.TagRepo(t.db)
})

beforeEach(() => t.reset())
afterAll(() => t.db.destroy())

describe("findMany", () => {
    it("returns every live row with every column by default", async () => {
        const rows = await users.findMany({ orderBy: { id: "asc" } })
        expect(ids(rows)).toEqual([1, 2, 3])
        expect(rows[0]).toEqual({
            id: 1,
            email: "ada@x.io",
            name: "Ada",
            age: 36,
            role: "admin",
            meta: { plan: "pro", address: { city: "London" } },
            created_at: new Date("2026-01-10T00:00:00Z"),
            deleted_at: null,
        })
    })

    it("works with no arguments", async () => {
        expect(ids(await users.findMany())).toEqual([1, 2, 3])
    })

    it("applies skip and take", async () => {
        const rows = await posts.findMany({ orderBy: { id: "asc" }, skip: 1, take: 1 })
        expect(ids(rows)).toEqual([2])
    })

    it("caps results at 200 rows by default", async () => {
        await t.db.insertInto("tags").values(Array.from({ length: 210 }, (_, i) => ({ name: `t${i}` }))).execute()
        expect(await tags.findMany()).toHaveLength(200)
        expect(await tags.findMany({ take: 500 })).toHaveLength(212)
    })

    it("orders by one column, several columns and an array of objects", async () => {
        expect((await posts.findMany({ orderBy: { stars: "desc" } })).map(p => p.id)).toEqual([1, 3, 2])
        expect((await posts.findMany({ orderBy: { user_id: "asc", stars: "asc" } })).map(p => p.id)).toEqual([2, 1, 3])
        expect((await posts.findMany({ orderBy: [{ user_id: "desc" }, { stars: "desc" }] })).map(p => p.id)).toEqual([3, 1, 2])
    })

    it("hides soft-deleted rows unless includeDeleted is set", async () => {
        expect(ids(await users.findMany({ where: { age: { gte: 30 } } }))).toEqual([1])
        expect(ids(await users.findMany({ where: { age: { gte: 30 } }, includeDeleted: true }))).toEqual([1, 4])
        expect(ids(await users.findMany({ includeDeleted: true }))).toEqual([1, 2, 3, 4])
    })

    it("adds FOR UPDATE or FOR SHARE for lock", async () => {
        await t.db.transaction().execute(async trx => {
            await users.withSession(trx).findMany({ lock: "update" })
            await users.withSession(trx).findMany({ lock: "share" })
        })
        expect(t.queries.some(q => q.endsWith("for update"))).toBe(true)
        expect(t.queries.some(q => q.endsWith("for share"))).toBe(true)
    })
})

describe("findManyAndCount", () => {
    it("returns the page and the total count, ignoring skip and take for the count", async () => {
        const [rows, total] = await posts.findManyAndCount({ where: { user_id: 1 }, take: 1, orderBy: { id: "asc" } })
        expect(ids(rows)).toEqual([1])
        expect(total).toBe(2)
    })

    it("respects includeDeleted in the count", async () => {
        const [, total] = await posts.findManyAndCount({ includeDeleted: true })
        expect(total).toBe(4)
    })

    it("works with no arguments", async () => {
        const [rows, total] = await users.findManyAndCount()
        expect(rows).toHaveLength(3)
        expect(total).toBe(3)
    })
})

describe("findFirst", () => {
    it("returns the first match or null", async () => {
        expect((await posts.findFirst({ where: { stars: { gte: 3 } } }))?.id).toBeTypeOf("number")
        expect(await posts.findFirst({ where: { stars: 100 } })).toBeNull()
    })

    it("works with no arguments", async () => {
        expect(await users.findFirst()).not.toBeNull()
    })

    it("hides soft-deleted rows unless includeDeleted is set", async () => {
        expect(await users.findFirst({ where: { id: 4 } })).toBeNull()
        expect((await users.findFirst({ where: { id: 4 }, includeDeleted: true }))?.email).toBe("dee@x.io")
    })

    it("applies select", async () => {
        expect(await users.findFirst({ where: { id: 1 }, select: { email: true } })).toEqual({ email: "ada@x.io" })
    })

    it("adds a lock", async () => {
        await t.db.transaction().execute(trx => users.withSession(trx).findFirst({ lock: "update" }))
        expect(t.queries.some(q => q.endsWith("for update"))).toBe(true)
    })
})

describe("findUnique", () => {
    it("finds by id or returns null", async () => {
        expect((await users.findUnique({ where: { id: 2 } }))?.email).toBe("BOB@x.io")
        expect(await users.findUnique({ where: { id: 99 } })).toBeNull()
    })

    it("hides soft-deleted rows unless includeDeleted is set", async () => {
        expect(await users.findUnique({ where: { id: 4 } })).toBeNull()
        expect((await users.findUnique({ where: { id: 4 }, includeDeleted: true }))?.id).toBe(4)
    })

    it("returns null for an undefined id", async () => {
        expect(await users.findUnique({ where: { id: undefined as any } })).toBeNull()
    })

    it("applies select", async () => {
        expect(await users.findUnique({ where: { id: 1 }, select: { name: true, age: true } })).toEqual({ name: "Ada", age: 36 })
    })

    it.todo("applies the other where keys, so findUnique({ where: { id, user_id } }) can check ownership")
})

describe("count, countMany and exists", () => {
    it("counts live rows and honours includeDeleted", async () => {
        expect(await users.count()).toBe(3)
        expect(await users.count({ includeDeleted: true })).toBe(4)
        expect(await users.count({ where: { role: "member" } })).toBe(2)
        expect(await users.count({ where: { role: "member" }, includeDeleted: true })).toBe(3)
    })

    it("counts several filters in one query", async () => {
        const counts = await posts.countMany({
            where: { all: {}, byAda: { user_id: 1 }, popular: { stars: { gte: 3 } } },
        })
        expect(counts).toEqual({ all: 3, byAda: 2, popular: 2 })
        expect(t.queries).toHaveLength(1)
    })

    it("honours includeDeleted in countMany", async () => {
        expect(await posts.countMany({ where: { byAda: { user_id: 1 } }, includeDeleted: true })).toEqual({ byAda: 3 })
    })

    it("returns an empty object without a query when countMany gets no keys", async () => {
        expect(await posts.countMany({ where: {} })).toEqual({})
        expect(t.queries).toHaveLength(0)
    })

    it("reports existence", async () => {
        expect(await users.exists({ where: { email: "ada@x.io" } })).toBe(true)
        expect(await users.exists({ where: { email: "dee@x.io" } })).toBe(false)
        expect(await users.exists({ where: { email: "dee@x.io" }, includeDeleted: true })).toBe(true)
        expect(await users.exists()).toBe(true)
    })
})

describe("select", () => {
    const row = { id: 1, email: "ada@x.io", name: "Ada", age: 36, role: "admin" }

    function repoWithDefault(defaultSelect?: Record<string, boolean>) {
        let b: any = createRepoBuilder<DB>().table("users", { softDelete: "deleted_at" })
        if (defaultSelect) b = b.defaultSelect(defaultSelect)
        return new b.init(t.db)
    }

    async function first(repo: any, select?: Record<string, boolean>) {
        return repo.findFirst({ where: { id: 1 }, select })
    }

    it("returns only true keys when there is no default", async () => {
        expect(await first(repoWithDefault(), { id: true, email: true })).toEqual({ id: 1, email: "ada@x.io" })
    })

    it("drops false keys when there is no default", async () => {
        const result = await first(repoWithDefault(), { meta: false, created_at: false, deleted_at: false })
        expect(result).toEqual(row)
    })

    it("lets true keys win over false keys when they are mixed", async () => {
        expect(await first(repoWithDefault(), { email: true, name: false })).toEqual({ email: "ada@x.io" })
    })

    it("applies a blacklist default and lets the query un-hide a column", async () => {
        const repo = repoWithDefault({ meta: false, created_at: false, deleted_at: false })
        expect(await first(repo)).toEqual(row)
        expect(await first(repo, { meta: true })).toEqual({ ...row, meta: { plan: "pro", address: { city: "London" } } })
    })

    it("keeps blacklist mode when the query asks for a column with true", async () => {
        const repo = repoWithDefault({ meta: false, created_at: false, deleted_at: false })
        expect(await first(repo, { email: true })).toEqual(row)
    })

    it("lets the query hide more columns on top of a blacklist default", async () => {
        const repo = repoWithDefault({ meta: false, created_at: false, deleted_at: false })
        expect(await first(repo, { role: false, age: false })).toEqual({ id: 1, email: "ada@x.io", name: "Ada" })
    })

    it("applies a whitelist default and lets the query add or remove columns", async () => {
        const repo = repoWithDefault({ id: true, email: true })
        expect(await first(repo)).toEqual({ id: 1, email: "ada@x.io" })
        expect(await first(repo, { name: true })).toEqual({ id: 1, email: "ada@x.io", name: "Ada" })
        expect(await first(repo, { email: false })).toEqual({ id: 1 })
    })

    it("returns every column when a whitelist turns every key off (current behaviour)", async () => {
        const result = await first(repoWithDefault({ id: true }), { id: false })
        expect(Object.keys(result)).toHaveLength(8)
    })

    it("applies the default to findMany and findUnique", async () => {
        const repo = repoWithDefault({ id: true, email: true })
        expect((await repo.findMany({ orderBy: { id: "asc" }, take: 1 }))[0]).toEqual({ id: 1, email: "ada@x.io" })
        expect(await repo.findUnique({ where: { id: 1 } })).toEqual({ id: 1, email: "ada@x.io" })
    })

    it("applies an exclude select to findMany rows", async () => {
        const rows = await users.findMany({ select: { meta: false, created_at: false, deleted_at: false }, orderBy: { id: "asc" } })
        expect(rows[0]).toEqual(row)
    })
})
