import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { BaseRepository, createRepoBuilder } from "../src/index.js"
import { createTestDb, type DB, type TestDb } from "./helpers/db.js"

let t: TestDb

beforeAll(async () => {
    t = await createTestDb()
})

beforeEach(() => t.reset())
afterAll(() => t.db.destroy())

describe("generated repository class", () => {
    it("extends BaseRepository and exposes tableName and populations", () => {
        const Repo = createRepoBuilder<DB>()
            .table("users")
            .populate({ as: "posts", ref: "posts", foreignKey: "user_id" })
            .init
        expect(Repo.tableName).toBe("users")
        expect(Object.keys(Repo.populations)).toEqual(["posts"])
        expect(Repo.populations.posts).toMatchObject({ table: "posts", foreignKey: "user_id", resolveSoftDeleteFromTable: true })
        expect(new Repo(t.db)).toBeInstanceOf(BaseRepository)
    })

    it("returns an empty object from opts", () => {
        const Repo = createRepoBuilder<DB>().table("tags").init
        expect(new Repo(t.db).opts()).toEqual({})
    })

    it("defaults foreignKey to id and makes localKey relations single", () => {
        const Repo = createRepoBuilder<DB>().table("posts").populate({ as: "author", ref: "users", localKey: "user_id" }).init
        expect(Repo.populations.author).toMatchObject({ foreignKey: "id", localKey: "user_id", justOne: true })
    })

    it("keeps each builder step immutable", async () => {
        const base = createRepoBuilder<DB>().table("posts")
        const Plain = base.init
        const WithPop = base.populate({ as: "author", ref: "users", localKey: "user_id" }).init
        expect(Object.keys(Plain.populations)).toEqual([])
        expect(Object.keys(WithPop.populations)).toEqual(["author"])
    })
})

describe("soft delete configuration", () => {
    it("enables soft delete from the table config", async () => {
        const Repo = createRepoBuilder<DB>().table("users", { softDelete: "deleted_at" }).init
        expect(await new Repo(t.db).count()).toBe(3)
    })

    it("enables soft delete from the softDelete method", async () => {
        const Repo = createRepoBuilder<DB>().table("users").softDelete("deleted_at").init
        expect(await new Repo(t.db).count()).toBe(3)
    })

    it("inherits soft delete when the same table is built again", async () => {
        const b = createRepoBuilder<DB>()
        b.table("users", { softDelete: "deleted_at" })
        expect(await new (b.table("users").init)(t.db).count()).toBe(3)
    })

    it("turns soft delete off with false in the table config or the method", async () => {
        const b = createRepoBuilder<DB>()
        b.table("users", { softDelete: "deleted_at" })
        expect(await new (b.table("users", { softDelete: false }).init)(t.db).count()).toBe(4)
        expect(await new (b.table("users").init)(t.db).count()).toBe(4)

        const c = createRepoBuilder<DB>()
        expect(await new (c.table("users", { softDelete: "deleted_at" }).softDelete(false).init)(t.db).count()).toBe(4)
    })

    it("keeps registries separate between builders", async () => {
        createRepoBuilder<DB>().table("users", { softDelete: "deleted_at" })
        expect(await new (createRepoBuilder<DB>().table("users").init)(t.db).count()).toBe(4)
    })
})

describe("hooks", () => {
    function hookedTags() {
        const calls: Array<[string, unknown, unknown?]> = []
        const Repo = createRepoBuilder<DB>()
            .table("tags")
            .hooks({
                beforeCreate: data => (calls.push(["beforeCreate", data]), { ...data, name: data.name.trim() }),
                afterCreate: row => void calls.push(["afterCreate", row]),
                beforeUpdate: async (data, where) => (calls.push(["beforeUpdate", data, where]), { ...data, name: `${data.name}!` }),
                afterUpdate: row => void calls.push(["afterUpdate", row]),
                beforeDelete: async where => void calls.push(["beforeDelete", where]),
                afterDelete: row => void calls.push(["afterDelete", row]),
            })
            .init
        return { repo: new Repo(t.db), calls }
    }

    it("runs beforeCreate and afterCreate around create", async () => {
        const { repo, calls } = hookedTags()
        const row = await repo.create({ data: { name: "  go  " } })
        expect(row).toEqual({ id: 3, name: "go" })
        expect(calls).toEqual([["beforeCreate", { name: "  go  " }], ["afterCreate", { id: 3, name: "go" }]])
    })

    it("runs beforeCreate but not afterCreate for createMany (current behaviour)", async () => {
        const { repo, calls } = hookedTags()
        expect(await repo.createMany({ data: [{ name: " a " }, { name: " b " }] })).toEqual([{ id: 3, name: "a" }, { id: 4, name: "b" }])
        expect(calls.map(c => c[0])).toEqual(["beforeCreate", "beforeCreate"])
    })

    it("runs beforeUpdate with the where and afterUpdate with the row", async () => {
        const { repo, calls } = hookedTags()
        expect(await repo.update({ where: { id: 1 }, data: { name: "pg" } })).toEqual({ id: 1, name: "pg!" })
        expect(await repo.updateUnique({ where: { id: 2 }, data: { name: "js" } })).toEqual({ id: 2, name: "js!" })
        expect(calls).toEqual([
            ["beforeUpdate", { name: "pg" }, { id: 1 }],
            ["afterUpdate", { id: 1, name: "pg!" }],
            ["beforeUpdate", { name: "js" }, { id: 2 }],
            ["afterUpdate", { id: 2, name: "js!" }],
        ])
    })

    it("passes null to afterUpdate when nothing matched", async () => {
        const { repo, calls } = hookedTags()
        await repo.update({ where: { id: 99 }, data: { name: "x" } })
        expect(calls.at(-1)).toEqual(["afterUpdate", null])
    })

    it("runs beforeDelete and afterDelete for delete, hardDelete and deleteUnique", async () => {
        const { repo, calls } = hookedTags()
        await repo.delete({ where: { id: 1 } })
        await repo.deleteUnique({ where: { id: 2 } })
        await repo.hardDelete({ where: { id: 99 } })
        expect(calls).toEqual([
            ["beforeDelete", { id: 1 }],
            ["afterDelete", { id: 1, name: "sql" }],
            ["beforeDelete", { id: 2 }],
            ["afterDelete", { id: 2, name: "ts" }],
            ["beforeDelete", { id: 99 }],
            ["afterDelete", null],
        ])
    })

    it("runs delete hooks for softDelete", async () => {
        const calls: string[] = []
        const Repo = createRepoBuilder<DB>()
            .table("posts", { softDelete: "deleted_at" })
            .hooks({ beforeDelete: () => void calls.push("before"), afterDelete: row => void calls.push(`after:${row?.id}`) })
            .init
        await new Repo(t.db).delete({ where: { id: 1 } })
        expect(calls).toEqual(["before", "after:1"])
    })

    it("skips delete hooks for deleteMany (current behaviour)", async () => {
        const { repo, calls } = hookedTags()
        await repo.deleteMany({ where: { id: 1 } })
        expect(calls).toEqual([])
    })

    it("runs beforeCreate and beforeUpdate for upsert", async () => {
        const { repo, calls } = hookedTags()
        expect(await repo.upsert({ where: { name: "sql" }, create: { name: " sql " }, update: { name: "sql" } })).toEqual({
            id: 1,
            name: "sql!",
        })
        expect(calls.map(c => c[0])).toEqual(["beforeCreate", "beforeUpdate"])
    })

    it("stops the write when a before hook throws", async () => {
        const Repo = createRepoBuilder<DB>()
            .table("tags")
            .hooks({ beforeDelete: () => { throw new Error("blocked") } })
            .init
        await expect(new Repo(t.db).delete({ where: { id: 1 } })).rejects.toThrow("blocked")
        expect(await new Repo(t.db).count()).toBe(2)
    })

    it("keeps hooks and other settings across later builder steps", async () => {
        const calls: string[] = []
        const Repo = createRepoBuilder<DB>()
            .table("tags")
            .hooks({ afterCreate: () => void calls.push("after") })
            .defaultSelect({ name: true })
            .populate({ as: "x", ref: "posts", foreignKey: "id" })
            .init
        expect(await new Repo(t.db).create({ data: { name: "go" } })).toEqual({ name: "go" })
        expect(calls).toEqual(["after"])
    })
})

describe("transactions", () => {
    it("runs queries on the session given to withSession", async () => {
        const Repo = createRepoBuilder<DB>().table("tags").init
        const repo = new Repo(t.db)

        await expect(
            t.db.transaction().execute(async trx => {
                await repo.withSession(trx).create({ data: { name: "go" } })
                expect(await repo.withSession(trx).count()).toBe(3)
                throw new Error("rollback")
            }),
        ).rejects.toThrow("rollback")

        expect(await repo.count()).toBe(2)
    })

    it("commits work done through withSession", async () => {
        const Repo = createRepoBuilder<DB>().table("tags").init
        const repo = new Repo(t.db)
        await t.db.transaction().execute(trx => repo.withSession(trx).create({ data: { name: "go" } }))
        expect(await repo.count()).toBe(3)
    })

    it("returns a clone that keeps the repo settings and leaves the original unbound", async () => {
        const Repo = createRepoBuilder<DB>().table("users", { softDelete: "deleted_at" }).defaultSelect({ id: true }).init
        const repo = new Repo(t.db)

        await t.db.transaction().execute(async trx => {
            const bound = repo.withSession(trx)
            expect(bound).toBeInstanceOf(Repo)
            expect(bound).not.toBe(repo)
            expect(await bound.findMany({ orderBy: { id: "asc" } })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
            expect((repo as any).transaction).toBeUndefined()
        })
    })

    it("accepts a transaction in the constructor", async () => {
        const Repo = createRepoBuilder<DB>().table("tags").init
        await expect(
            t.db.transaction().execute(async trx => {
                await new Repo(t.db, trx).create({ data: { name: "go" } })
                throw new Error("rollback")
            }),
        ).rejects.toThrow()
        expect(await new Repo(t.db).count()).toBe(2)
    })
})
