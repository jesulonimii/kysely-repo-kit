import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createRepoBuilder, definePopulation } from "../src/index.js"
import { buildRepos, createTestDb, type DB, type TestDb } from "./helpers/db.js"

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

describe("one-to-many", () => {
    it("loads related rows as an array and skips soft-deleted ones", async () => {
        const ada = await users.findUnique({ where: { id: 1 }, populate: { posts: true } })
        expect(ada?.posts.map(p => p.title).sort()).toEqual(["Hello World", "Second"])
    })

    it("returns an empty array when there are no related rows", async () => {
        const cy = await users.findUnique({ where: { id: 3 }, populate: { posts: true } })
        expect(cy?.posts).toEqual([])
    })

    it("camelCases keys and returns dates as strings, because rows come back as JSON (current behaviour)", async () => {
        const ada = await users.findUnique({ where: { id: 1 }, populate: { posts: { where: { id: 1 } } } })
        expect(ada?.posts).toEqual([
            { id: 1, userId: 1, title: "Hello World", stars: 5, publishedAt: "2026-01-15T00:00:00+00:00", deletedAt: null },
        ])
    })

    it("works on findMany and findFirst", async () => {
        const all = await users.findMany({ populate: { posts: true }, orderBy: { id: "asc" } })
        expect(all.map(u => u.posts.length)).toEqual([2, 1, 0])
        expect((await users.findFirst({ where: { id: 2 }, populate: { posts: true } }))?.posts).toHaveLength(1)
    })
})

describe("one-to-one", () => {
    it("loads an object or null with justOne", async () => {
        expect((await users.findUnique({ where: { id: 1 }, populate: { profile: true } }))?.profile).toEqual({
            id: 1,
            userId: 1,
            bio: "Mathematician",
        })
        expect((await users.findUnique({ where: { id: 2 }, populate: { profile: true } }))?.profile).toBeNull()
    })

    it("follows localKey to the parent row", async () => {
        const post = await posts.findUnique({ where: { id: 3 }, populate: { author: { select: { email: true } } } })
        expect(post?.author).toEqual({ email: "BOB@x.io" })
    })

    it("hides a soft-deleted parent", async () => {
        await t.db.insertInto("posts").values({ id: 5, user_id: 4, title: "By Dee" }).execute()
        expect((await posts.findUnique({ where: { id: 5 }, populate: { author: true } }))?.author).toBeNull()
    })
})

describe("populate options", () => {
    it("applies select, where and orderBy", async () => {
        const ada = await users.findUnique({
            where: { id: 1 },
            populate: { posts: { select: { title: true }, where: { stars: { gte: 1 } } as any, orderBy: { stars: "asc" } } },
        })
        expect(ada?.posts).toEqual([{ title: "Second" }, { title: "Hello World" }])
    })

    it("accepts an array orderBy", async () => {
        const ada = await users.findUnique({
            where: { id: 1 },
            populate: { posts: { select: { id: true }, orderBy: [{ stars: "desc" }] } },
        })
        expect(ada?.posts).toEqual([{ id: 1 }, { id: 2 }])
    })

    it("skips falsy and unknown keys", async () => {
        const ada: any = await users.findUnique({ where: { id: 1 }, populate: { posts: false, nope: true } as any })
        expect(ada).not.toHaveProperty("posts")
        expect(ada).not.toHaveProperty("nope")
    })

    it("combines with a top-level select", async () => {
        const ada = await users.findUnique({ where: { id: 1 }, select: { email: true }, populate: { profile: true } })
        expect(ada).toEqual({ email: "ada@x.io", profile: { id: 1, userId: 1, bio: "Mathematician" } })
    })
})

describe("nested populations", () => {
    it("loads relations of relations and filters soft-deleted rows at each level", async () => {
        const ada = await users.findUnique({
            where: { id: 1 },
            populate: { posts: { where: { id: 1 }, populate: { comments: true, author: { select: { name: true } } } } },
        })
        expect(ada?.posts[0]?.comments.map(c => c.body)).toEqual(["nice"])
        expect(ada?.posts[0]?.author).toEqual({ name: "Ada" })
    })

    it("camelCases keys at every level (current behaviour)", async () => {
        const ada: any = await users.findUnique({
            where: { id: 1 },
            populate: { posts: { where: { id: 1 }, populate: { comments: true } } },
        })
        expect(ada.posts[0].comments[0]).toEqual({ id: 1, postId: 1, body: "nice", deletedAt: null })
    })

    it("throws on a circular populate", async () => {
        const b = createRepoBuilder<DB>()
        const PostRepo: any = b
            .table("posts")
            .populate({ as: "author", ref: "users", localKey: "user_id", nestedPopulations: () => UserRepo.populations })
            .init
        const UserRepo: any = b
            .table("users")
            .populate({ as: "posts", ref: "posts", foreignKey: "user_id", nestedPopulations: () => PostRepo.populations })
            .init

        const repo = new UserRepo(t.db)
        await expect(
            repo.findMany({ populate: { posts: { populate: { author: { populate: { posts: true } } } } } }),
        ).rejects.toThrow("Circular populate detected: users -> posts -> users")
    })
})

describe("soft delete in populations", () => {
    it("resolves the column from the registry even when the related repo is built later", async () => {
        const b = createRepoBuilder<DB>()
        const UserRepo = b.table("users").populate({ as: "posts", ref: "posts", foreignKey: "user_id" }).init
        b.table("posts", { softDelete: "deleted_at" })
        const ada = await new UserRepo(t.db).findUnique({ where: { id: 1 }, populate: { posts: true } })
        expect(ada?.posts).toHaveLength(2)
    })

    it("includes deleted rows when the related table has no soft delete registered", async () => {
        const b = createRepoBuilder<DB>()
        const UserRepo = b.table("users").populate({ as: "posts", ref: "posts", foreignKey: "user_id" }).init
        const ada = await new UserRepo(t.db).findUnique({ where: { id: 1 }, populate: { posts: true } })
        expect(ada?.posts).toHaveLength(3)
    })

    it("includes deleted rows with softDelete: false on the populate", async () => {
        const b = createRepoBuilder<DB>()
        b.table("posts", { softDelete: "deleted_at" })
        const UserRepo = b.table("users").populate({ as: "posts", ref: "posts", foreignKey: "user_id", softDelete: false }).init
        const ada = await new UserRepo(t.db).findUnique({ where: { id: 1 }, populate: { posts: true } })
        expect(ada?.posts).toHaveLength(3)
    })

    it("uses an explicit softDelete column on the populate", async () => {
        const b = createRepoBuilder<DB>()
        const UserRepo = b
            .table("users")
            .populate({ as: "posts", ref: "posts", foreignKey: "user_id", softDelete: "published_at" })
            .init
        const ada = await new UserRepo(t.db).findUnique({ where: { id: 1 }, populate: { posts: { select: { id: true } } } })
        expect(ada?.posts.map(p => p.id).sort()).toEqual([2, 4])
    })

    it("includes deleted rows when the related table opted out with softDelete(false)", async () => {
        const b = createRepoBuilder<DB>()
        b.table("posts").softDelete(false)
        const UserRepo = b.table("users").populate({ as: "posts", ref: "posts", foreignKey: "user_id" }).init
        const ada = await new UserRepo(t.db).findUnique({ where: { id: 1 }, populate: { posts: true } })
        expect(ada?.posts).toHaveLength(3)
    })
})

describe("population defaults", () => {
    it("applies the builder select and where, and lets the query select win", async () => {
        const b = createRepoBuilder<DB>()
        const UserRepo = b
            .table("users")
            .populate({
                as: "posts",
                ref: "posts",
                foreignKey: "user_id",
                select: () => ({ title: true }),
                where: { stars: { gte: 2 } },
            })
            .init
        const repo = new UserRepo(t.db)
        expect((await repo.findUnique({ where: { id: 1 }, populate: { posts: true } }))?.posts.map(p => p.title).sort()).toEqual([
            "Hello World",
            "Old",
        ])
        expect((await repo.findUnique({ where: { id: 1 }, populate: { posts: { select: { id: true }, where: { stars: 9 } as any } } }))?.posts).toEqual([
            { id: 4 },
        ])
    })

    it("supports populations built with definePopulation", async () => {
        const UserRepo = createRepoBuilder<DB>()
            .table("users")
            .populate({
                as: "posts",
                ref: "posts",
                foreignKey: "user_id",
                nestedPopulations: () => ({
                    comments: definePopulation<DB, DB["comments"]>({ table: "comments", foreignKey: "post_id", softDeleteColumn: "deleted_at" }),
                }),
            })
            .init
        const ada = await new UserRepo(t.db).findUnique({
            where: { id: 1 },
            populate: { posts: { where: { id: 1 }, populate: { comments: true } } },
        })
        expect(ada?.posts[0]?.comments.map(c => c.body)).toEqual(["nice"])
    })
})
