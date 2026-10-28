import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildRepos, createTestDb, ids, type TestDb } from "./helpers/db.js"

let t: TestDb
let repos: ReturnType<typeof buildRepos>
let users: InstanceType<ReturnType<typeof buildRepos>["UserRepo"]>
let posts: InstanceType<ReturnType<typeof buildRepos>["PostRepo"]>
let tags: InstanceType<ReturnType<typeof buildRepos>["TagRepo"]>

beforeAll(async () => {
    t = await createTestDb()
    repos = buildRepos()
    users = new repos.UserRepo(t.db)
    posts = new repos.PostRepo(t.db)
    tags = new repos.TagRepo(t.db)
})

beforeEach(() => t.reset())
afterAll(() => t.db.destroy())

const from = new Date("2026-02-01T00:00:00Z")
const to = new Date("2026-03-01T00:00:00Z")

describe("undefined range and text operators are skipped", () => {
    it("treats a one-sided date range as open on the missing side", async () => {
        expect(ids(await users.findMany({ where: { created_at: { gte: from, lte: undefined } } }))).toEqual([2, 3])
        expect(ids(await users.findMany({ where: { created_at: { gte: undefined, lte: to } } }))).toEqual([1, 2])
        expect(ids(await users.findMany({ where: { created_at: { gt: undefined, lt: to } } }))).toEqual([1, 2])
    })

    it("treats a range with every bound undefined as no filter", async () => {
        const where = { stars: { gt: undefined, gte: undefined, lt: undefined, lte: undefined } }
        expect(ids(await posts.findMany({ where }))).toEqual([1, 2, 3])
    })

    it("skips undefined contains, startsWith and endsWith in both modes", async () => {
        for (const mode of ["default", "insensitive"] as const) {
            const where = { email: { contains: undefined, startsWith: undefined, endsWith: undefined, mode } }
            expect(ids(await users.findMany({ where }))).toEqual([1, 2, 3])
        }
    })

    it("does not match the literal text 'undefined'", async () => {
        await users.create({ data: { email: "undefined@x.io" } })
        expect(await users.count({ where: { email: { contains: undefined } } })).toBe(4)
    })

    it("keeps defined operators next to undefined ones", async () => {
        const where = { stars: { gte: 2, lte: undefined }, title: { contains: undefined, startsWith: "B" } }
        expect(ids(await posts.findMany({ where }))).toEqual([3])
    })

    it("skips undefined text operators inside jsonb", async () => {
        const where = { jsonb: { "meta.plan": { contains: undefined, startsWith: undefined, endsWith: undefined } } }
        expect(ids(await users.findMany({ where }))).toEqual([1, 2, 3])
    })

    it("matches every row for AND and OR groups that drop to empty, like Prisma", async () => {
        expect(ids(await posts.findMany({ where: { AND: [{ stars: { gte: undefined } }] } }))).toEqual([1, 2, 3])
        expect(ids(await posts.findMany({ where: { OR: [{ stars: { gte: undefined } }, { stars: 1 }] } }))).toEqual([1, 2, 3])
    })
})

describe("undefined identity values match nothing", () => {
    it("matches nothing for a top-level undefined value", async () => {
        expect(await users.findMany({ where: { id: undefined } })).toEqual([])
        expect(await users.findFirst({ where: { id: undefined } })).toBeNull()
    })

    it("matches nothing for undefined equals, not, in and notIn", async () => {
        expect(await users.findMany({ where: { id: { equals: undefined } } })).toEqual([])
        expect(await users.findMany({ where: { id: { not: undefined } } })).toEqual([])
        expect(await users.findMany({ where: { id: { in: undefined } } })).toEqual([])
        expect(await users.findMany({ where: { id: { notIn: undefined } } })).toEqual([])
    })

    it("matches nothing for undefined jsonb values and identity operators", async () => {
        expect(await users.findMany({ where: { jsonb: { "meta.plan": undefined } } })).toEqual([])
        expect(await users.findMany({ where: { jsonb: { "meta.plan": { equals: undefined } } } })).toEqual([])
        expect(await users.findMany({ where: { jsonb: { "meta.plan": { not: undefined } } } })).toEqual([])
        expect(await users.findMany({ where: { jsonb: { "meta.plan": { in: undefined } } } })).toEqual([])
        expect(await users.findMany({ where: { jsonb: { "meta.plan": { notIn: undefined } } } })).toEqual([])
    })

    it("still treats null as IS NULL", async () => {
        expect(ids(await users.findMany({ where: { age: null } }))).toEqual([3])
        expect(ids(await users.findMany({ where: { age: { not: null } } }))).toEqual([1, 2])
    })

    it("leaves writes as no-ops for a top-level undefined id", async () => {
        expect(await posts.update({ where: { id: undefined }, data: { title: "x" } })).toBeNull()
        expect(await posts.updateMany({ where: { id: undefined }, data: { title: "x" } })).toEqual([])
        expect(await tags.hardDelete({ where: { id: undefined } })).toBeNull()
        expect(await posts.deleteMany({ where: { user_id: undefined } })).toBe(0)
        expect(await posts.count({ where: { title: "x" } })).toBe(0)
        expect(await tags.count()).toBe(2)
    })
})

describe("bulk writes refuse a where that drops to no condition", () => {
    const empty = { stars: { gte: undefined } }

    it("throws for update, updateMany, delete, softDelete, hardDelete and deleteMany", async () => {
        await expect(posts.update({ where: empty, data: { title: "x" } })).rejects.toThrow(/update on posts refused/)
        await expect(posts.updateMany({ where: empty, data: { title: "x" } })).rejects.toThrow(/updateMany on posts refused/)
        await expect(posts.delete({ where: empty })).rejects.toThrow(/softDelete on posts refused/)
        await expect(posts.softDelete({ where: empty })).rejects.toThrow(/softDelete on posts refused/)
        await expect(posts.hardDelete({ where: empty })).rejects.toThrow(/hardDelete on posts refused/)
        await expect(posts.deleteMany({ where: empty })).rejects.toThrow(/deleteMany on posts refused/)
        await expect(tags.delete({ where: { name: { contains: undefined } } })).rejects.toThrow(/hardDelete on tags refused/)
    })

    it("throws for groups and jsonb filters that drop to empty", async () => {
        await expect(posts.deleteMany({ where: { AND: [empty] } })).rejects.toThrow(/refused/)
        await expect(posts.deleteMany({ where: { AND: [] } })).rejects.toThrow(/refused/)
        await expect(posts.deleteMany({ where: { OR: [empty, { stars: 1 }] } })).rejects.toThrow(/refused/)
        await expect(users.deleteMany({ where: { jsonb: { "meta.plan": { contains: undefined } } } })).rejects.toThrow(/refused/)
    })

    it("checks the caller's filter, not the soft-delete condition the repo adds", async () => {
        await expect(posts.deleteMany({ where: { published_at: { lte: undefined } } })).rejects.toThrow(/refused/)
    })

    it("runs no hook and changes no row when it refuses", async () => {
        expect(await posts.count()).toBe(3)
        await expect(posts.hardDelete({ where: empty })).rejects.toThrow()
        expect(await posts.count()).toBe(3)
        expect(t.queries.filter(q => /^(update|delete)/.test(q))).toEqual([])
    })

    it("allows filters that keep at least one condition", async () => {
        expect(await tags.deleteMany({ where: { id: { gte: 2, lte: undefined } } })).toBe(1)
        expect(await posts.deleteMany({ where: { OR: [] } })).toBe(0)
        expect(await posts.deleteMany({ where: { NOT: { stars: { gte: 0 } } } })).toBe(0)
        expect(await posts.updateMany({ where: { _raw: eb => eb("posts.stars", "=", 3) }, data: { title: "y" } })).toEqual([{ id: 3 }])
    })

    it("allows a literal empty where to target every row on purpose", async () => {
        expect(await users.updateMany({ where: {}, data: { role: "z" } })).toHaveLength(4)
        expect(await tags.deleteMany({ where: {} })).toBe(2)
    })
})
