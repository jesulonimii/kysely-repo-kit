import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildRepos, createTestDb, ids, type TestDb } from "./helpers/db.js"

let t: TestDb
let users: InstanceType<ReturnType<typeof buildRepos>["UserRepo"]>
let posts: InstanceType<ReturnType<typeof buildRepos>["PostRepo"]>

beforeAll(async () => {
    t = await createTestDb()
    const repos = buildRepos()
    users = new repos.UserRepo(t.db)
    posts = new repos.PostRepo(t.db)
})

beforeEach(() => t.reset())
afterAll(() => t.db.destroy())

describe("field values", () => {
    it("matches a primitive by equality", async () => {
        expect(ids(await users.findMany({ where: { role: "member" } }))).toEqual([2, 3])
        expect(ids(await posts.findMany({ where: { stars: 5 } }))).toEqual([1])
    })

    it("matches a Date by equality", async () => {
        expect(ids(await users.findMany({ where: { created_at: new Date("2026-02-10T00:00:00Z") } }))).toEqual([2])
    })

    it("matches null with IS NULL", async () => {
        expect(ids(await posts.findMany({ where: { published_at: null } }))).toEqual([2])
    })

    it("combines several fields with AND", async () => {
        expect(ids(await posts.findMany({ where: { user_id: 1, stars: 5 } }))).toEqual([1])
        expect(await posts.findMany({ where: { user_id: 2, stars: 5 } })).toEqual([])
    })
})

describe("number and date operators", () => {
    it("supports equals and not", async () => {
        expect(ids(await posts.findMany({ where: { stars: { equals: 3 } } }))).toEqual([3])
        expect(ids(await posts.findMany({ where: { stars: { not: 3 } } }))).toEqual([1, 2])
    })

    it("treats not: null as IS NOT NULL", async () => {
        expect(ids(await posts.findMany({ where: { published_at: { not: null } } }))).toEqual([1, 3])
    })

    it("supports gt, gte, lt and lte", async () => {
        expect(ids(await posts.findMany({ where: { stars: { gt: 3 } } }))).toEqual([1])
        expect(ids(await posts.findMany({ where: { stars: { gte: 3 } } }))).toEqual([1, 3])
        expect(ids(await posts.findMany({ where: { stars: { lt: 3 } } }))).toEqual([2])
        expect(ids(await posts.findMany({ where: { stars: { lte: 3 } } }))).toEqual([2, 3])
        expect(ids(await posts.findMany({ where: { stars: { gt: 1, lt: 5 } } }))).toEqual([3])
    })

    it("supports date ranges", async () => {
        const where = { created_at: { gte: new Date("2026-02-01T00:00:00Z"), lt: new Date("2026-03-10T00:00:00Z") } }
        expect(ids(await users.findMany({ where }))).toEqual([2])
    })

    it("supports in and notIn", async () => {
        expect(ids(await posts.findMany({ where: { id: { in: [1, 3] } } }))).toEqual([1, 3])
        expect(ids(await posts.findMany({ where: { id: { notIn: [1, 3] } } }))).toEqual([2])
    })

    it("treats an empty in as no match and an empty notIn as every row", async () => {
        expect(await posts.findMany({ where: { id: { in: [] } } })).toEqual([])
        expect(ids(await posts.findMany({ where: { id: { notIn: [] } } }))).toEqual([1, 2, 3])
    })
})

describe("string operators", () => {
    it("supports contains, startsWith and endsWith", async () => {
        expect(ids(await posts.findMany({ where: { title: { contains: "o" } } }))).toEqual([1, 2, 3])
        expect(ids(await posts.findMany({ where: { title: { contains: "World" } } }))).toEqual([1])
        expect(ids(await posts.findMany({ where: { title: { startsWith: "Se" } } }))).toEqual([2])
        expect(ids(await posts.findMany({ where: { title: { endsWith: "Post" } } }))).toEqual([3])
    })

    it("is case sensitive by default", async () => {
        expect(await users.findMany({ where: { email: { startsWith: "bob" } } })).toEqual([])
        expect(await users.findMany({ where: { email: { contains: "bob", mode: "default" } } })).toEqual([])
    })

    it("ignores case in insensitive mode", async () => {
        expect(ids(await users.findMany({ where: { email: { startsWith: "bob", mode: "insensitive" } } }))).toEqual([2])
        expect(ids(await users.findMany({ where: { email: { contains: "OB@", mode: "insensitive" } } }))).toEqual([2])
        expect(ids(await users.findMany({ where: { email: { endsWith: "X.IO", mode: "insensitive" } } }))).toEqual([1, 2, 3])
    })

    it("does not apply insensitive mode to equals", async () => {
        expect(await users.findMany({ where: { email: { equals: "bob@x.io", mode: "insensitive" } } })).toEqual([])
    })

    it("ignores a filter object that holds only mode", async () => {
        expect(ids(await users.findMany({ where: { email: { mode: "insensitive" } } }))).toEqual([1, 2, 3])
    })
})

describe("logical groups", () => {
    it("supports AND", async () => {
        expect(ids(await posts.findMany({ where: { AND: [{ user_id: 1 }, { stars: { gt: 2 } }] } }))).toEqual([1])
    })

    it("supports OR", async () => {
        expect(ids(await posts.findMany({ where: { OR: [{ stars: 1 }, { stars: 3 }] } }))).toEqual([2, 3])
    })

    it("treats an empty OR as no match and an empty AND as every row", async () => {
        expect(await posts.findMany({ where: { OR: [] } })).toEqual([])
        expect(ids(await posts.findMany({ where: { AND: [] } }))).toEqual([1, 2, 3])
    })

    it("supports NOT", async () => {
        expect(ids(await posts.findMany({ where: { NOT: { user_id: 1 } } }))).toEqual([3])
        expect(ids(await users.findMany({ where: { NOT: { age: null } } }))).toEqual([1, 2])
    })

    it("supports nesting", async () => {
        const where = {
            OR: [
                { AND: [{ user_id: 1 }, { stars: { lt: 2 } }] },
                { NOT: { OR: [{ user_id: 1 }, { stars: { lt: 3 } }] } },
            ],
        }
        expect(ids(await posts.findMany({ where }))).toEqual([2, 3])
    })

    it("supports jsonb and operator filters inside groups", async () => {
        const where = {
            OR: [{ jsonb: { "meta.plan": "free" } }, { email: { startsWith: "ada" } }],
        }
        expect(ids(await users.findMany({ where }))).toEqual([1, 2])
    })
})

describe("jsonb", () => {
    it("matches a nested path by equality", async () => {
        expect(ids(await users.findMany({ where: { jsonb: { "meta.plan": "pro" } } }))).toEqual([1])
        expect(ids(await users.findMany({ where: { jsonb: { "meta.address.city": "Paris" } } }))).toEqual([2])
    })

    it("compares numbers and booleans as text", async () => {
        await t.db.updateTable("users").set({ meta: JSON.stringify({ plan: "x", seats: 3, trial: true }) as any }).where("id", "=", 3).execute()
        expect(ids(await users.findMany({ where: { jsonb: { "meta.seats": 3 } as any } }))).toEqual([3])
        expect(ids(await users.findMany({ where: { jsonb: { "meta.trial": true } as any } }))).toEqual([3])
    })

    it("matches a missing path with null", async () => {
        expect(ids(await users.findMany({ where: { jsonb: { "meta.address.city": null } } }))).toEqual([3])
    })

    it("supports every string operator", async () => {
        const find = (f: object) => users.findMany({ where: { jsonb: { "meta.plan": f } } })
        expect(ids(await find({ equals: "free" }))).toEqual([2])
        expect(ids(await find({ equals: "FREE", mode: "insensitive" }))).toEqual([2])
        expect(ids(await find({ not: "free" }))).toEqual([1])
        expect(ids(await find({ not: "PRO", mode: "insensitive" }))).toEqual([2])
        expect(ids(await find({ not: null }))).toEqual([1, 2])
        expect(ids(await find({ contains: "re" }))).toEqual([2])
        expect(ids(await find({ contains: "RE", mode: "insensitive" }))).toEqual([2])
        expect(ids(await find({ startsWith: "p" }))).toEqual([1])
        expect(ids(await find({ startsWith: "P", mode: "insensitive" }))).toEqual([1])
        expect(ids(await find({ endsWith: "ee" }))).toEqual([2])
        expect(ids(await find({ endsWith: "EE", mode: "insensitive" }))).toEqual([2])
        expect(ids(await find({ in: ["pro", "free"] }))).toEqual([1, 2])
        expect(ids(await find({ notIn: ["pro"] }))).toEqual([2])
    })

    it("treats an empty in as no match and an empty notIn as every row", async () => {
        expect(await users.findMany({ where: { jsonb: { "meta.plan": { in: [] } } } })).toEqual([])
        expect(ids(await users.findMany({ where: { jsonb: { "meta.plan": { notIn: [] } } } }))).toEqual([1, 2, 3])
    })

    it("compiles the same SQL through applyWhere and through groups", async () => {
        const f = { jsonb: { "meta.plan": { in: ["pro"], contains: "r" } } }
        expect(ids(await users.findMany({ where: f }))).toEqual([1])
        expect(ids(await users.findMany({ where: { AND: [f] } }))).toEqual([1])
    })

    it("rejects a path without a nested key", async () => {
        await expect(users.findMany({ where: { jsonb: { meta: "x" } as any } })).rejects.toThrow(/Invalid jsonb path: meta/)
    })
})

describe("_raw", () => {
    it("adds a raw expression at the top level and inside groups", async () => {
        expect(ids(await posts.findMany({ where: { _raw: eb => eb("posts.stars", ">", 2) } }))).toEqual([1, 3])
        expect(ids(await posts.findMany({ where: { OR: [{ _raw: (() => sql<boolean>`posts.stars = 1`) as any }, { id: 3 }] } }))).toEqual([2, 3])
    })
})

describe("applyWhere on the repository", () => {
    it("is exposed for custom queries", async () => {
        let q: any = t.db.selectFrom("posts").select("id")
        q = users.applyWhere(q, "posts", { stars: { gte: 3 } })
        expect(ids(await q.execute())).toEqual([1, 3, 4])
    })
})
