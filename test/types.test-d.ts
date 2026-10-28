import type { Kysely, Selectable } from "kysely"
import { describe, expectTypeOf, it } from "vitest"
import type { Populated, WhereFilter, WithPopulations } from "../src/index.js"
import { buildRepos, type DB } from "./helpers/db.js"

declare const db: Kysely<DB>
const { UserRepo, PostRepo } = buildRepos()
const users = new UserRepo(db)
const posts = new PostRepo(db)

type User = Selectable<DB["users"]>
type Post = Selectable<DB["posts"]>
type Comment = Selectable<DB["comments"]>
type Profile = Selectable<DB["profiles"]>

describe("query results", () => {
    it("types plain reads as selectable rows", async () => {
        const many = await users.findMany()
        const first = await users.findFirst()
        const unique = await users.findUnique({ where: { id: 1 } })
        const [paged, total] = await users.findManyAndCount()

        expectTypeOf(many).toExtend<User[]>()
        expectTypeOf<User[]>().toExtend<typeof many>()
        expectTypeOf(first).toExtend<User | null>()
        expectTypeOf(unique).toExtend<User | null>()
        expectTypeOf<User | null>().toExtend<typeof unique>()
        expectTypeOf(paged).toExtend<User[]>()
        expectTypeOf(total).toEqualTypeOf<number>()
        expectTypeOf(await users.countMany({ where: { a: {}, b: {} } })).toEqualTypeOf<Record<"a" | "b", number>>()
    })

    it("types writes", async () => {
        expectTypeOf(await users.create({ data: { email: "x" } })).toEqualTypeOf<User>()
        expectTypeOf(await users.update({ where: { id: 1 }, data: {} })).toEqualTypeOf<User | null>()
        expectTypeOf(await users.updateMany({ where: { id: 1 }, data: {} })).toEqualTypeOf<User[]>()
        expectTypeOf(await users.deleteMany({ where: { id: 1 } })).toEqualTypeOf<number>()
    })

    it("adds populated keys as arrays or single rows", async () => {
        const u = await users.findFirst({ populate: { posts: true, profile: true } })
        expectTypeOf(u!.posts).toEqualTypeOf<Post[]>()
        expectTypeOf(u!.profile).toEqualTypeOf<Profile | null>()

        const p = await posts.findFirst({ populate: { author: true } })
        expectTypeOf(p!.author).toEqualTypeOf<User | null>()
    })

    it("types nested populations", async () => {
        const u = await users.findFirst({ populate: { posts: { populate: { comments: true } } } })
        expectTypeOf(u!.posts[0]!.comments).toEqualTypeOf<Comment[]>()
    })
})

describe("Populated and WithPopulations", () => {
    it("infers the populated row from a repo class or instance", () => {
        type FromClass = Populated<typeof UserRepo, { profile: true; posts: { populate: { comments: true } } }>
        expectTypeOf<FromClass["profile"]>().toEqualTypeOf<Profile | null>()
        expectTypeOf<FromClass["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>()
        expectTypeOf<Populated<typeof users, { posts: true }>["posts"]>().toEqualTypeOf<Post[]>()
    })

    it("declares populated keys by hand", () => {
        type Manual = WithPopulations<DB["users"], { posts: Post[] }>
        expectTypeOf<Manual["posts"]>().toEqualTypeOf<Post[]>()
        expectTypeOf<Manual["email"]>().toEqualTypeOf<string>()
    })
})

describe("WhereFilter", () => {
    type W = WhereFilter<DB, "users">

    it("accepts column filters, groups, jsonb paths and raw expressions", () => {
        expectTypeOf<{ email: { contains: "a"; mode: "insensitive" } }>().toExtend<W>()
        expectTypeOf<{ age: { gte: 1; lte: undefined } }>().toExtend<W>()
        expectTypeOf<{ created_at: { gte: Date } }>().toExtend<W>()
        expectTypeOf<{ OR: [{ age: null }, { NOT: { role: "admin" } }] }>().toExtend<W>()
        expectTypeOf<{ jsonb: { "meta.address.city": "Paris" } }>().toExtend<W>()
    })

    it("rejects unknown columns, wrong operators and unknown jsonb paths", () => {
        expectTypeOf<{ nope: 1 }>().not.toExtend<W>()
        expectTypeOf<{ age: { contains: "1" } }>().not.toExtend<W>()
        expectTypeOf<{ email: { gt: 1 } }>().not.toExtend<W>()
        expectTypeOf<{ jsonb: { "meta.nope": 1 } }>().not.toExtend<W>()
    })
})

describe("populate input", () => {
    it.todo("types populate where against the related table, so posts: { where: { stars: 1 } } compiles")
    it.todo("accepts a plain sql expression in _raw")

    it("rejects unknown populate keys and nested keys the relation does not define", () => {
        // @ts-expect-error unknown populate key
        void users.findMany({ populate: { nope: true } })
        // @ts-expect-error profile has no nested populations
        void users.findMany({ populate: { profile: { populate: { posts: true } } } })
    })
})
