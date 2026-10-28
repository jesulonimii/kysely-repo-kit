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

async function tagNames() {
    return (await t.db.selectFrom("tags").select("name").orderBy("id").execute()).map(r => r.name)
}

describe("create", () => {
    it("inserts and returns the full row with database defaults", async () => {
        const user = await users.create({ data: { email: "eve@x.io", meta: { plan: "free" } } })
        expect(user).toMatchObject({ id: 5, email: "eve@x.io", role: "member", meta: { plan: "free" }, deleted_at: null })
        expect(user.created_at).toBeInstanceOf(Date)
    })

    it("applies an include select to the returned row", async () => {
        expect(await tags.create({ data: { name: "go" }, select: { id: true } })).toEqual({ id: 3 })
    })

    it("applies an exclude select to the returned row", async () => {
        const user = await users.create({ data: { email: "eve@x.io" }, select: { meta: false, created_at: false } })
        expect(Object.keys(user).sort()).toEqual(["age", "deleted_at", "email", "id", "name", "role"])
    })

    it("surfaces constraint errors", async () => {
        await expect(tags.create({ data: { name: "sql" } })).rejects.toThrow(/tags_name_key/)
    })
})

describe("createMany", () => {
    it("inserts every row in one statement and returns them", async () => {
        const rows = await tags.createMany({ data: [{ name: "a" }, { name: "b" }] })
        expect(rows).toEqual([{ id: 3, name: "a" }, { id: 4, name: "b" }])
        expect(t.queries.filter(q => q.startsWith("insert"))).toHaveLength(1)
    })
})

describe("update", () => {
    it("updates the matching row and returns it", async () => {
        expect(await tags.update({ where: { id: 1 }, data: { name: "postgres" } })).toEqual({ id: 1, name: "postgres" })
        expect(await tagNames()).toEqual(["postgres", "ts"])
    })

    it("returns null when nothing matches", async () => {
        expect(await tags.update({ where: { id: 99 }, data: { name: "x" } })).toBeNull()
    })

    it("applies select to the returned row", async () => {
        expect(await users.update({ where: { id: 1 }, data: { age: 37 }, select: { age: true } })).toEqual({ age: 37 })
    })

    it("updates every match but returns one row (current behaviour)", async () => {
        const row = await posts.update({ where: { user_id: 1 }, data: { stars: 0 } })
        expect(row?.stars).toBe(0)
        expect(await posts.count({ where: { stars: 0 }, includeDeleted: true })).toBe(3)
    })

    it("does not hide soft-deleted rows (current behaviour)", async () => {
        expect((await users.update({ where: { id: 4 }, data: { age: 41 } }))?.age).toBe(41)
    })
})

describe("updateUnique", () => {
    it("updates by id and returns the row", async () => {
        expect(await tags.updateUnique({ where: { id: 2 }, data: { name: "js" } })).toEqual({ id: 2, name: "js" })
    })

    it("returns null for a missing or undefined id", async () => {
        expect(await tags.updateUnique({ where: { id: 99 }, data: { name: "x" } })).toBeNull()
        expect(await tags.updateUnique({ where: { id: undefined as any }, data: { name: "x" } })).toBeNull()
        expect(await tagNames()).toEqual(["sql", "ts"])
    })

    it("applies select", async () => {
        expect(await tags.updateUnique({ where: { id: 2 }, data: { name: "js" }, select: { name: true } })).toEqual({ name: "js" })
    })
})

describe("updateMany", () => {
    it("returns only ids by default", async () => {
        const rows = await posts.updateMany({ where: { user_id: 1 }, data: { stars: 0 } })
        expect(ids(rows as any)).toEqual([1, 2, 4])
        expect(Object.keys(rows[0]!)).toEqual(["id"])
    })

    it("returns the selected columns with an include select", async () => {
        const rows = await tags.updateMany({ where: { id: 1 }, data: { name: "pg" }, select: { name: true } })
        expect(rows).toEqual([{ name: "pg" }])
    })

    it("returns every column except the hidden ones with an exclude select", async () => {
        const rows = await users.updateMany({ where: { id: 1 }, data: { age: 1 }, select: { meta: false } })
        expect(rows[0]).not.toHaveProperty("meta")
        expect(rows[0]).toMatchObject({ id: 1, age: 1 })
    })

    it("returns an empty array when nothing matches", async () => {
        expect(await tags.updateMany({ where: { id: 99 }, data: { name: "x" } })).toEqual([])
    })

    it("ignores defaultSelect and skips beforeUpdate hooks (current behaviour)", async () => {
        let calls = 0
        const Repo = createRepoBuilder<DB>()
            .table("tags")
            .defaultSelect({ name: true })
            .hooks({ beforeUpdate: data => (calls++, data) })
            .init
        expect(await new Repo(t.db).updateMany({ where: { id: 1 }, data: { name: "pg" } })).toEqual([{ id: 1 }])
        expect(calls).toBe(0)
    })
})

describe("upsert", () => {
    it("inserts when no row conflicts", async () => {
        const row = await tags.upsert({ where: { name: "go" }, create: { name: "go" }, update: { name: "go!" } })
        expect(row).toEqual({ id: 3, name: "go" })
    })

    it("updates the conflicting row", async () => {
        const row = await tags.upsert({ where: { name: "sql" }, create: { name: "sql" }, update: { name: "sql!" } })
        expect(row).toEqual({ id: 1, name: "sql!" })
    })

    it("returns the existing row unchanged when update is empty", async () => {
        const row = await tags.upsert({ where: { name: "ts" }, create: { name: "ts" }, update: {} })
        expect(row).toEqual({ id: 2, name: "ts" })
        expect(await tagNames()).toEqual(["sql", "ts"])
    })

    it("inserts when update is empty and no row conflicts", async () => {
        expect(await tags.upsert({ where: { name: "rs" }, create: { name: "rs" }, update: {} })).toEqual({ id: 3, name: "rs" })
    })

    it("merges where into the insert values", async () => {
        const row = await users.upsert({ where: { email: "eve@x.io" }, create: { email: "ignored", name: "Eve" } as any, update: {} })
        expect(row).toMatchObject({ email: "ignored", name: "Eve" })
    })

    it("fails when the where columns have no unique constraint", async () => {
        await expect(posts.upsert({ where: { title: "x" }, create: { title: "x", user_id: 1 }, update: { stars: 1 } })).rejects.toThrow(
            /no unique or exclusion constraint/,
        )
    })
})

describe("upsertMany", () => {
    it("upserts each item in input order", async () => {
        const rows = await tags.upsertMany({
            data: [
                { where: { name: "ts" }, create: { name: "ts" }, update: { name: "typescript" } },
                { where: { name: "go" }, create: { name: "go" }, update: {} },
            ],
        })
        expect(rows.map(r => r.name)).toEqual(["typescript", "go"])
        expect(rows[0]?.id).toBe(2)
    })

    it("returns an empty array for no items", async () => {
        expect(await tags.upsertMany({ data: [] })).toEqual([])
    })
})

describe("deletes on a table without soft delete", () => {
    it("delete removes the row and returns it", async () => {
        expect(await tags.delete({ where: { id: 1 } })).toEqual({ id: 1, name: "sql" })
        expect(await tagNames()).toEqual(["ts"])
    })

    it("hardDelete returns null when nothing matches", async () => {
        expect(await tags.hardDelete({ where: { id: 99 } })).toBeNull()
    })

    it("deleteUnique removes by id", async () => {
        expect(await tags.deleteUnique({ where: { id: 2 } })).toEqual({ id: 2, name: "ts" })
        expect(await tags.deleteUnique({ where: { id: 2 } })).toBeNull()
    })

    it("deleteMany returns the number of deleted rows", async () => {
        expect(await tags.deleteMany({ where: { id: { in: [1, 2, 99] } } })).toBe(2)
        expect(await tagNames()).toEqual([])
    })

    it("softDelete throws", async () => {
        await expect(tags.softDelete({ where: { id: 1 } })).rejects.toThrow("Soft delete is not enabled for table tags")
    })
})

describe("deletes on a soft-delete table", () => {
    async function raw(id: number) {
        return t.db.selectFrom("posts").selectAll().where("id", "=", id).executeTakeFirst()
    }

    it("delete stamps deleted_at and keeps the row", async () => {
        const row = await posts.delete({ where: { id: 1 } })
        expect(row?.deleted_at).toBeInstanceOf(Date)
        expect((await raw(1))?.deleted_at).toBeInstanceOf(Date)
        expect(await posts.findUnique({ where: { id: 1 } })).toBeNull()
    })

    it("softDelete accepts a custom deletedAt", async () => {
        const at = new Date("2030-01-01T00:00:00Z")
        expect((await posts.softDelete({ where: { id: 2 }, deletedAt: at }))?.deleted_at).toEqual(at)
    })

    it("hardDelete removes the row", async () => {
        await posts.hardDelete({ where: { id: 2 } })
        expect(await raw(2)).toBeUndefined()
    })

    it("deleteUnique soft-deletes by id", async () => {
        expect((await posts.deleteUnique({ where: { id: 3 } }))?.deleted_at).toBeInstanceOf(Date)
        expect(await raw(3)).toBeDefined()
    })

    it("deleteMany soft-deletes and returns the count", async () => {
        expect(await posts.deleteMany({ where: { user_id: 2 } })).toBe(1)
        expect(await posts.count()).toBe(2)
        expect(await posts.count({ includeDeleted: true })).toBe(4)
    })

    it("skips already-deleted rows in delete, softDelete and deleteUnique, so they return null", async () => {
        const original = (await raw(4))?.deleted_at
        expect(await posts.delete({ where: { id: 4 } })).toBeNull()
        expect(await posts.softDelete({ where: { id: 4 }, deletedAt: new Date("2030-01-01T00:00:00Z") })).toBeNull()
        expect(await posts.deleteUnique({ where: { id: 4 } })).toBeNull()
        expect((await raw(4))?.deleted_at).toEqual(original)
    })

    it("skips already-deleted rows in deleteMany and leaves them out of the count", async () => {
        const original = (await raw(4))?.deleted_at
        expect(await posts.deleteMany({ where: { user_id: 1 } })).toBe(2)
        expect((await raw(4))?.deleted_at).toEqual(original)
        expect(await posts.deleteMany({ where: { user_id: 1 } })).toBe(0)
    })

    it("still lets hardDelete remove an already-deleted row", async () => {
        expect((await posts.hardDelete({ where: { id: 4 } }))?.id).toBe(4)
        expect(await raw(4)).toBeUndefined()
    })
})
