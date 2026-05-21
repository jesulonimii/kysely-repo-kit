import {
    type ExpressionBuilder,
    type ExpressionWrapper,
    type Insertable,
    type Kysely,
    type Selectable,
    sql,
    type Transaction,
    type Updateable,
} from "kysely"
import { jsonArrayFrom, jsonObjectFrom } from "kysely/helpers/postgres"

type Primitive = string | number | boolean | Date | null | undefined

type JsonPathLeaves<T, Prefix extends string = ""> = T extends Primitive
    ? never
    : {
        [K in keyof T & string]: NonNullable<T[K]> extends Primitive
            ? `${Prefix}${K}`
            : `${Prefix}${K}` | JsonPathLeaves<NonNullable<T[K]>, `${Prefix}${K}.`>
    }[keyof T & string]

type ObjectColumnKeys<Row> = {
    [K in keyof Row & string]: NonNullable<Row[K]> extends object ? K : never
}[keyof Row & string]

export type JsonbFilterKey<Row> = {
    [K in ObjectColumnKeys<Row>]: NonNullable<Row[K]> extends object
        ? `${K}.${JsonPathLeaves<NonNullable<Row[K]>>}`
        : never
}[ObjectColumnKeys<Row>]

export type JsonbWhereFilter<Row> = {
    [K in JsonbFilterKey<Row>]?: StringFilter | NumberFilter | boolean | string | number | null
}

export type StringMode = "default" | "insensitive"

export interface StringFilter {
    equals?: string
    not?: string | null
    in?: string[]
    notIn?: string[]
    contains?: string
    startsWith?: string
    endsWith?: string
    mode?: StringMode
}

export interface NumberFilter {
    equals?: number
    not?: number | null
    in?: number[]
    notIn?: number[]
    gt?: number
    gte?: number
    lt?: number
    lte?: number
}

export interface DateFilter {
    equals?: Date
    not?: Date | null
    gt?: Date
    gte?: Date
    lt?: Date
    lte?: Date
}

export type InferTable<DB, TableName extends keyof DB & string> = DB[TableName] extends object
    ? DB[TableName]
    : never

export type FieldFilter<V> = V extends string
    ? V | StringFilter | null
    : V extends number
        ? V | NumberFilter | null
        : V extends Date
            ? V | DateFilter | null
            : V extends boolean
                ? V | null
                : V | null

export type WhereFilter<DB, TableName extends keyof DB & string, Row = InferTable<DB, TableName>> = {
    [K in keyof Selectable<Row>]?: FieldFilter<Selectable<Row>[K]>
} & {
    AND?: WhereFilter<DB, TableName, Row>[]
    OR?: WhereFilter<DB, TableName, Row>[]
    NOT?: WhereFilter<DB, TableName, Row>
    jsonb?: JsonbWhereFilter<Selectable<Row>>
    _raw?: (eb: ExpressionBuilder<DB, TableName>) => ExpressionWrapper<DB, TableName, unknown>
}

export interface PopulationDefinition<
    DB,
    TRelated,
    TRelatedPopulations extends PopulationMap<DB> = Record<never, never>,
> {
    table: keyof DB & string
    foreignKey: string
    localKey?: string
    justOne?: true
    softDeleteColumn?: string
    resolveSoftDeleteFromTable?: true
    defaultSelect?: Record<string, boolean>
    defaultWhere?: Record<string, any>
    readonly _type?: TRelated
    readonly _nestedPopulations?: () => TRelatedPopulations
}

export type PopulationMap<DB> = Record<string, PopulationDefinition<DB, any, any>>
export type SoftDeleteRegistry<DB> = Map<keyof DB & string, string | false>

type RelatedType<Def extends PopulationDefinition<any, any, any>> = NonNullable<Def["_type"]>

type RelatedPops<Def extends PopulationDefinition<any, any, any>> = NonNullable<
    ReturnType<NonNullable<Def["_nestedPopulations"]>>
>

type PopulateKeyOption<DB, Def extends PopulationDefinition<DB, any, any>> = [keyof RelatedPops<Def>] extends [never]
    ?
    | true
    | {
    select?: SelectInput<RelatedType<Def>>
    where?: WhereFilter<DB, Def["table"] & string>
    orderBy?: OrderByInput<RelatedType<Def>>
}
    :
    | true
    | {
    select?: SelectInput<RelatedType<Def>>
    where?: WhereFilter<DB, Def["table"] & string>
    orderBy?: OrderByInput<RelatedType<Def>>
    populate?: PopulateInput<DB, RelatedPops<Def>>
}

type ResolvePopulatedKey<DB, Def extends PopulationDefinition<DB, any, any>, Opt> = Opt extends {
        populate: infer NestedP
    }
    ? NestedP extends PopulateInput<DB, RelatedPops<Def>>
        ? Def["justOne"] extends true
            ? WithPopulated<DB, RelatedType<Def>, RelatedPops<Def>, NestedP> | null
            : WithPopulated<DB, RelatedType<Def>, RelatedPops<Def>, NestedP>[]
        : never
    : Def["justOne"] extends true
        ? RelatedType<Def> | null
        : RelatedType<Def>[]

export type WithPopulated<
    DB,
    Row,
    Populations extends PopulationMap<DB>,
    P extends PopulateInput<DB, Populations>,
> = Selectable<Row> & {
    [K in keyof P & keyof Populations]: ResolvePopulatedKey<DB, Populations[K], P[K]>
}

export type SelectInput<Row> = { [K in keyof Row]?: boolean }

export type OrderByInput<Row> =
    | { [K in keyof Row]?: "asc" | "desc" }
    | { [K in keyof Row]?: "asc" | "desc" }[]

export type PopulateInput<DB, Populations extends PopulationMap<DB>> = {
    [K in keyof Populations]?: PopulateKeyOption<DB, Populations[K]>
}

function getSoftDeleteColumnFromRegistry<DB>(
    registry: SoftDeleteRegistry<DB> | undefined,
    table: keyof DB & string,
): string | undefined {
    if (!registry?.has(table)) return undefined

    const value = registry.get(table)
    return typeof value === "string" ? value : undefined
}

function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function camelCaseKeys(val: unknown): unknown {
    if (Array.isArray(val)) return val.map(camelCaseKeys)
    if (val !== null && typeof val === "object") {
        return Object.fromEntries(
            Object.entries(val as Record<string, unknown>).map(([k, v]) => [snakeToCamel(k), camelCaseKeys(v)]),
        )
    }
    return val
}

function fieldOps(col: string, f: Record<string, unknown>, insensitive: boolean): Array<[string, unknown, unknown]> {
    const ops: Array<[unknown, string, unknown]> = []
    const iCol = sql`lower(${sql.ref(col)})`

    if ("equals" in f) ops.push([col, "=", f.equals])
    if ("not" in f) ops.push(f.not === null ? [col, "is not", null] : [col, "!=", f.not])
    if ("in" in f) ops.push([col, "in", f.in])
    if ("notIn" in f) ops.push([col, "not in", f.notIn])
    if ("gt" in f) ops.push([col, ">", f.gt])
    if ("gte" in f) ops.push([col, ">=", f.gte])
    if ("lt" in f) ops.push([col, "<", f.lt])
    if ("lte" in f) ops.push([col, "<=", f.lte])

    if ("contains" in f) {
        const v = f.contains as string
        ops.push(insensitive ? [iCol, "like", `%${v.toLowerCase()}%`] : [col, "like", `%${v}%`])
    }

    if ("startsWith" in f) {
        const v = f.startsWith as string
        ops.push(insensitive ? [iCol, "like", `${v.toLowerCase()}%`] : [col, "like", `${v}%`])
    }

    if ("endsWith" in f) {
        const v = f.endsWith as string
        ops.push(insensitive ? [iCol, "like", `%${v.toLowerCase()}`] : [col, "like", `%${v}`])
    }

    return ops as any
}

function jsonbTextExpr(tableName: string, path: string) {
    const [column, ...jsonPath] = path.split(".")
    if (!column || jsonPath.length === 0) throw new Error(`Invalid jsonb path: ${path}`)

    const pgPath = `{${jsonPath.join(",")}}`
    return sql<string>`${sql.ref(`${tableName}.${column}`)} #>> ${pgPath}`
}

function buildExpr(eb: any, tableName: string, filter: Record<string, unknown>): any {
    const parts: any[] = []

    for (const [key, value] of Object.entries(filter)) {
        if (key === "AND") {
            parts.push(eb.and((value as any[]).map(sub => buildExpr(eb, tableName, sub))))
        } else if (key === "OR") {
            parts.push(eb.or((value as any[]).map(sub => buildExpr(eb, tableName, sub))))
        } else if (key === "NOT") {
            parts.push(eb.not(buildExpr(eb, tableName, value as any)))
        } else if (key === "jsonb") {
            for (const [path, rawValue] of Object.entries(value as Record<string, unknown>)) {
                const expr = jsonbTextExpr(tableName, path)

                if (rawValue === null) {
                    parts.push(sql<boolean>`${expr} is null`)
                } else if (typeof rawValue !== "object" || rawValue instanceof Date) {
                    parts.push(sql<boolean>`${expr} = ${String(rawValue)}`)
                } else {
                    const f = rawValue as Record<string, unknown>
                    const insensitive = f.mode === "insensitive"

                    if ("equals" in f) {
                        parts.push(
                            insensitive
                                ? sql<boolean>`lower(${expr}) = lower(${String(f.equals)})`
                                : sql<boolean>`${expr} = ${String(f.equals)}`,
                        )
                    }

                    if ("not" in f) {
                        parts.push(
                            f.not === null
                                ? sql<boolean>`${expr} is not null`
                                : insensitive
                                    ? sql<boolean>`lower(${expr}) != lower(${String(f.not)})`
                                    : sql<boolean>`${expr} != ${String(f.not)}`,
                        )
                    }

                    if ("contains" in f) {
                        const v = String(f.contains)
                        parts.push(
                            insensitive
                                ? sql<boolean>`lower(${expr}) like ${`%${v.toLowerCase()}%`}`
                                : sql<boolean>`${expr} like ${`%${v}%`}`,
                        )
                    }

                    if ("startsWith" in f) {
                        const v = String(f.startsWith)
                        parts.push(
                            insensitive
                                ? sql<boolean>`lower(${expr}) like ${`${v.toLowerCase()}%`}`
                                : sql<boolean>`${expr} like ${`${v}%`}`,
                        )
                    }

                    if ("endsWith" in f) {
                        const v = String(f.endsWith)
                        parts.push(
                            insensitive
                                ? sql<boolean>`lower(${expr}) like ${`%${v.toLowerCase()}`}`
                                : sql<boolean>`${expr} like ${`%${v}`}`,
                        )
                    }

                    if ("in" in f) parts.push(sql<boolean>`${expr} in ${sql.join((f.in as unknown[]).map(String))}`)
                    if ("notIn" in f) {
                        parts.push(sql<boolean>`${expr} not in ${sql.join((f.notIn as unknown[]).map(String))}`)
                    }
                }
            }
        } else if (key === "_raw") {
            parts.push((value as (eb: any) => any)(eb))
        } else {
            const col = `${tableName}.${key}`

            if (value === null) {
                parts.push(eb(col, "is", null))
            } else if (typeof value !== "object" || value instanceof Date) {
                parts.push(eb(col, "=", value))
            } else {
                const f = value as Record<string, unknown>
                for (const [c, op, val] of fieldOps(col, f, f.mode === "insensitive")) {
                    parts.push(eb(c, op, val))
                }
            }
        }
    }

    return parts.length === 1 ? parts[0] : eb.and(parts)
}

function applyWhere(q: any, tableName: string, filter: Record<string, unknown>): any {
    for (const [key, value] of Object.entries(filter)) {
        if (key === "AND") {
            for (const sub of value as any[]) q = q.where((eb: any) => buildExpr(eb, tableName, sub))
        } else if (key === "OR") {
            q = q.where((eb: any) => eb.or((value as any[]).map(sub => buildExpr(eb, tableName, sub))))
        } else if (key === "NOT") {
            q = q.where((eb: any) => eb.not(buildExpr(eb, tableName, value as any)))
        } else if (key === "jsonb") {
            for (const [path, rawValue] of Object.entries(value as Record<string, unknown>)) {
                const expr = jsonbTextExpr(tableName, path)

                if (rawValue === null) {
                    q = q.where(sql<boolean>`${expr} is null`)
                } else if (typeof rawValue !== "object" || rawValue instanceof Date) {
                    q = q.where(sql<boolean>`${expr} = ${String(rawValue)}`)
                } else {
                    const f = rawValue as Record<string, unknown>
                    const insensitive = f.mode === "insensitive"

                    if ("equals" in f) {
                        q = q.where(
                            insensitive
                                ? sql<boolean>`lower(${expr}) = lower(${String(f.equals)})`
                                : sql<boolean>`${expr} = ${String(f.equals)}`,
                        )
                    }

                    if ("not" in f) {
                        q =
                            f.not === null
                                ? q.where(sql<boolean>`${expr} is not null`)
                                : q.where(
                                    insensitive
                                        ? sql<boolean>`lower(${expr}) != lower(${String(f.not)})`
                                        : sql<boolean>`${expr} != ${String(f.not)}`,
                                )
                    }

                    if ("contains" in f) {
                        const v = String(f.contains)
                        q = q.where(
                            insensitive
                                ? sql<boolean>`lower(${expr}) like ${`%${v.toLowerCase()}%`}`
                                : sql<boolean>`${expr} like ${`%${v}%`}`,
                        )
                    }

                    if ("startsWith" in f) {
                        const v = String(f.startsWith)
                        q = q.where(
                            insensitive
                                ? sql<boolean>`lower(${expr}) like ${`${v.toLowerCase()}%`}`
                                : sql<boolean>`${expr} like ${`${v}%`}`,
                        )
                    }

                    if ("endsWith" in f) {
                        const v = String(f.endsWith)
                        q = q.where(
                            insensitive
                                ? sql<boolean>`lower(${expr}) like ${`%${v.toLowerCase()}`}`
                                : sql<boolean>`${expr} like ${`%${v}`}`,
                        )
                    }

                    if ("in" in f) q = q.where(expr, "in", (f.in as unknown[]).map(String))
                    if ("notIn" in f) q = q.where(expr, "not in", (f.notIn as unknown[]).map(String))
                }
            }
        } else if (key === "_raw") {
            q = q.where((eb: any) => (value as (eb: any) => any)(eb))
        } else {
            const col = `${tableName}.${key}`

            if (value === null) {
                q = q.where(col, "is", null)
            } else if (typeof value !== "object" || value instanceof Date) {
                q = q.where(col, "=", value)
            } else {
                const f = value as Record<string, unknown>
                for (const [c, op, val] of fieldOps(col, f, f.mode === "insensitive")) {
                    q = q.where(c, op, val)
                }
            }
        }
    }

    return q
}

export default class BaseRepository<
    DB,
    TableName extends keyof DB & string,
    Populations extends PopulationMap<DB> = Record<never, never>,
    Table extends object = InferTable<DB, TableName>,
> {
    protected readonly db: Kysely<DB>
    protected readonly tableName: TableName
    protected readonly transaction?: Transaction<DB>
    protected readonly populations: Populations
    protected readonly softDeleteColumn?: keyof Table & string
    protected readonly softDeleteRegistry?: SoftDeleteRegistry<DB>

    constructor({
                    db,
                    tableName,
                    transaction,
                    populations,
                    softDeleteColumn,
                    softDeleteRegistry,
                }: {
        db: Kysely<DB>
        tableName: TableName
        transaction?: Transaction<DB>
        populations?: Populations
        softDeleteColumn?: keyof Table & string
        softDeleteRegistry?: SoftDeleteRegistry<DB>
    }) {
        this.db = db
        this.tableName = tableName
        this.transaction = transaction
        this.populations = (populations ?? {}) as Populations
        this.softDeleteColumn = softDeleteColumn
        this.softDeleteRegistry = softDeleteRegistry
    }

    protected get executor() {
        const exec = this.transaction || this.db
        if (!exec) throw new Error(`Executor not found for table ${this.tableName}. Check if db is initialized.`)
        return exec
    }

    withSession(transaction: Transaction<DB>): this {
        const clone = Object.create(Object.getPrototypeOf(this))
        Object.assign(clone, this, { transaction })
        return clone
    }

    applyWhere = applyWhere

    protected async beforeCreate(data: Insertable<DB[TableName]>): Promise<Insertable<DB[TableName]>> {
        return data
    }

    protected async afterCreate(row: Selectable<Table>): Promise<Selectable<Table>> {
        return row
    }

    protected async beforeUpdate(
        data: Updateable<DB[TableName]>,
        where: WhereFilter<DB, TableName, Table>,
    ): Promise<Updateable<DB[TableName]>> {
        return data
    }

    protected async afterUpdate(row: Selectable<Table> | null): Promise<Selectable<Table> | null> {
        return row
    }

    protected async beforeDelete(_where: WhereFilter<DB, TableName, Table>): Promise<void> {}

    protected async afterDelete(row: Selectable<Table> | null): Promise<Selectable<Table> | null> {
        return row
    }

    async findMany<P extends PopulateInput<DB, Populations> = Record<never, never>>({
                                                                                        where = {} as WhereFilter<DB, TableName, Table>,
                                                                                        select,
                                                                                        populate,
                                                                                        skip = 0,
                                                                                        take = 200,
                                                                                        orderBy,
                                                                                        lock,
                                                                                        includeDeleted = false,
                                                                                    }: {
        where?: WhereFilter<DB, TableName, Table>
        select?: SelectInput<Table>
        populate?: P
        skip?: number
        take?: number
        orderBy?: OrderByInput<Table>
        lock?: "update" | "share"
        includeDeleted?: boolean
    } = {}): Promise<WithPopulated<DB, Table, Populations, P>[]> {
        let q: any = this.executor.selectFrom(this.tableName)
        q = applyWhere(q, this.tableName, this.withSoftDeleteFilter(where as any, includeDeleted))
        q = q.offset(skip).limit(take)
        if (orderBy) q = this.applyOrderBy(q, orderBy)
        q = this.applySelect(q, select)
        if (populate) q = this.applyPopulate(q, populate)
        if (lock === "update") q = q.forUpdate()
        else if (lock === "share") q = q.forShare()
        return this.fixPopulatedKeys(await q.execute(), populate) as any
    }

    async findFirst<P extends PopulateInput<DB, Populations> = Record<never, never>>({
                                                                                         where = {} as WhereFilter<DB, TableName, Table>,
                                                                                         select,
                                                                                         populate,
                                                                                         lock,
                                                                                         includeDeleted = false,
                                                                                     }: {
        where?: WhereFilter<DB, TableName, Table>
        select?: SelectInput<Table>
        populate?: P
        lock?: "update" | "share"
        includeDeleted?: boolean
    } = {}): Promise<WithPopulated<DB, Table, Populations, P> | null> {
        let q: any = this.executor.selectFrom(this.tableName)
        q = applyWhere(q, this.tableName, this.withSoftDeleteFilter(where as any, includeDeleted))
        q = this.applySelect(q, select)
        if (populate) q = this.applyPopulate(q, populate)
        if (lock === "update") q = q.forUpdate()
        else if (lock === "share") q = q.forShare()

        const row = await q.executeTakeFirst()
        if (!row) return null

        const [result] = this.fixPopulatedKeys([row], populate)
        return result ?? null
    }

    async findUnique<P extends PopulateInput<DB, Populations> = Record<never, never>>({
                                                                                          where,
                                                                                          select,
                                                                                          populate,
                                                                                          includeDeleted = false,
                                                                                      }: {
        where: { id: string | number } & Partial<WhereFilter<DB, TableName, Table>>
        select?: SelectInput<Table>
        populate?: P
        includeDeleted?: boolean
    }): Promise<WithPopulated<DB, Table, Populations, P> | null> {
        let q: any = (this.executor.selectFrom(this.tableName) as any).where(`${this.tableName}.id`, "=", where.id)

        if (this.isSoftDeletableTable() && !includeDeleted) {
            q = q.where(`${this.tableName}.${this.softDeleteColumn}`, "is", null)
        }

        q = this.applySelect(q, select)
        if (populate) q = this.applyPopulate(q, populate)

        const row = await q.executeTakeFirst()
        if (!row) return null

        const [result] = this.fixPopulatedKeys([row], populate)
        return result ?? null
    }

    async create({
                     data,
                     select,
                 }: {
        data: Insertable<DB[TableName]>
        select?: SelectInput<Table>
    }): Promise<Selectable<Table>> {
        const processedData = await this.beforeCreate(data)
        const q = this.executor.insertInto(this.tableName).values(processedData as any)
        const row = (await this.returning(q, select, true)) as Selectable<Table>
        return this.afterCreate(row)
    }

    async createMany({ data }: { data: Insertable<DB[TableName]>[] }): Promise<Selectable<Table>[]> {
        const processedData = await Promise.all(data.map(item => this.beforeCreate(item)))

        return (await this.executor
            .insertInto(this.tableName)
            .values(processedData as any)
            .returningAll()
            .execute()) as unknown as Selectable<Table>[]
    }

    async update({
                     where,
                     data,
                     select,
                 }: {
        where: WhereFilter<DB, TableName, Table>
        data: Updateable<DB[TableName]>
        select?: SelectInput<Table>
    }): Promise<Selectable<Table> | null> {
        const processedData = await this.beforeUpdate(data, where)
        let q: any = (this.executor.updateTable(this.tableName) as any).set(processedData as any)
        q = applyWhere(q, this.tableName, where as any)
        const row = await this.returning(q, select)
        return this.afterUpdate(row)
    }

    async updateUnique({
                           where,
                           data,
                           select,
                       }: {
        where: { id: string | number }
        data: Updateable<DB[TableName]>
        select?: SelectInput<Table>
    }): Promise<Selectable<Table> | null> {
        const processedData = await this.beforeUpdate(data, { id: where.id } as any)

        const q: any = (this.executor.updateTable(this.tableName) as any)
            .set(processedData as any)
            .where(`${this.tableName}.id`, "=", where.id)

        const row = await this.returning(q, select)
        return this.afterUpdate(row)
    }

    async updateMany({
                         where,
                         data,
                     }: {
        where: WhereFilter<DB, TableName, Table>
        data: Updateable<DB[TableName]>
    }): Promise<number> {
        let q: any = (this.executor.updateTable(this.tableName) as any).set(data as any)
        q = applyWhere(q, this.tableName, where as any)
        return Number((await q.executeTakeFirst()).numUpdatedRows)
    }

    async upsert({
                     where,
                     create,
                     update,
                 }: {
        where: WhereFilter<DB, TableName, Table>
        create: Insertable<DB[TableName]>
        update: Updateable<DB[TableName]>
    }): Promise<Selectable<Table>[]> {
        const processedCreate = await this.beforeCreate(create)
        const processedUpdate = await this.beforeUpdate(update, where)

        return (await this.executor
            .insertInto(this.tableName)
            .values({ ...where, ...processedCreate } as any)
            .onConflict(oc => oc.columns(Object.keys(where) as any).doUpdateSet(processedUpdate as any))
            .returningAll()
            .execute()) as unknown as Selectable<Table>[]
    }

    async hardDelete({ where }: { where: WhereFilter<DB, TableName, Table> }): Promise<Selectable<Table> | null> {
        await this.beforeDelete(where)
        const q = applyWhere(this.executor.deleteFrom(this.tableName) as any, this.tableName, where as any)
        const row = ((await q.returningAll().executeTakeFirst()) as Selectable<Table>) ?? null
        return this.afterDelete(row)
    }

    async delete(args: { where: WhereFilter<DB, TableName, Table> }): Promise<Selectable<Table> | null> {
        if (this.isSoftDeletableTable()) return this.softDelete(args)
        return this.hardDelete(args)
    }

    async softDelete({
                         where,
                         deletedAt = new Date(),
                     }: {
        where: WhereFilter<DB, TableName, Table>
        deletedAt?: Date
    }): Promise<Selectable<Table> | null> {
        if (!this.softDeleteColumn) {
            throw new Error(`Soft delete is not enabled for table ${this.tableName}`)
        }

        await this.beforeDelete(where)

        const q = applyWhere(this.executor.updateTable(this.tableName) as any, this.tableName, where as any).set({
            [this.softDeleteColumn]: deletedAt,
        } as any)

        const row = ((await q.returningAll().executeTakeFirst()) as Selectable<Table>) ?? null
        return this.afterDelete(row)
    }

    async deleteUnique({ where }: { where: { id: string | number } }): Promise<Selectable<Table> | null> {
        await this.beforeDelete({ id: where.id } as any)

        let row: Selectable<Table> | null

        if (this.isSoftDeletableTable()) {
            row = await this.softDeleteRaw({ where: { id: where.id } as any })
        } else {
            row =
                ((await (this.executor.deleteFrom(this.tableName) as any)
                    .where(`${this.tableName}.id`, "=", where.id)
                    .returningAll()
                    .executeTakeFirst()) as Selectable<Table>) ?? null
        }

        return this.afterDelete(row)
    }

    async deleteMany({ where }: { where: WhereFilter<DB, TableName, Table> }): Promise<number> {
        if (this.isSoftDeletableTable()) {
            return this.updateMany({
                where,
                data: {
                    [this.softDeleteColumn as string]: new Date(),
                } as any,
            })
        }

        const q = applyWhere(this.executor.deleteFrom(this.tableName) as any, this.tableName, where as any)
        return Number((await q.executeTakeFirst()).numDeletedRows)
    }

    async count({
                    where = {} as WhereFilter<DB, TableName, Table>,
                    includeDeleted = false,
                }: {
        where?: WhereFilter<DB, TableName, Table>
        includeDeleted?: boolean
    } = {}): Promise<number> {
        let q: any = this.executor.selectFrom(this.tableName)
        q = applyWhere(q, this.tableName, this.withSoftDeleteFilter(where as any, includeDeleted))
        const result = await q.select(sql<string>`count(*)`.as("count")).executeTakeFirst()
        return parseInt(result?.count ?? "0", 10)
    }

    async exists(args: { where?: WhereFilter<DB, TableName, Table>; includeDeleted?: boolean } = {}): Promise<boolean> {
        return (await this.count(args)) > 0
    }

    protected async returning(q: any, select?: SelectInput<Table>, orThrow = false): Promise<Selectable<Table> | null> {
        let built: any

        if (select) {
            const cols = Object.entries(select)
                .filter(([, v]) => v)
                .map(([k]) => `${this.tableName}.${k}`)
            built = q.returning(cols)
        } else {
            built = q.returningAll()
        }

        const row = orThrow ? await built.executeTakeFirstOrThrow() : await built.executeTakeFirst()
        return (row as Selectable<Table>) ?? null
    }

    protected applySelect(q: any, select?: SelectInput<Table>): any {
        if (!select) return q.selectAll(this.tableName)

        const cols = Object.entries(select)
            .filter(([, v]) => v)
            .map(([k]) => `${this.tableName}.${k}`)

        return cols.length ? q.select(cols) : q.selectAll(this.tableName)
    }

    protected applyOrderBy(q: any, orderBy: OrderByInput<Table>): any {
        const entries = Array.isArray(orderBy) ? orderBy : [orderBy]

        for (const obj of entries) {
            for (const [col, dir] of Object.entries(obj)) {
                q = q.orderBy(`${this.tableName}.${col}`, dir)
            }
        }

        return q
    }

    protected withSoftDeleteFilter(where: Record<string, any>, includeDeleted: boolean): Record<string, any> {
        if (!this.softDeleteColumn || includeDeleted) return where

        if (!where || Object.keys(where).length === 0) {
            return { [this.softDeleteColumn]: null }
        }

        return {
            AND: [where, { [this.softDeleteColumn]: null }],
        }
    }

    protected isSoftDeletableTable() {
        return Boolean(this.softDeleteColumn)
    }

    private async softDeleteRaw({
                                    where,
                                    deletedAt = new Date(),
                                }: {
        where: WhereFilter<DB, TableName, Table>
        deletedAt?: Date
    }): Promise<Selectable<Table> | null> {
        if (!this.softDeleteColumn) {
            throw new Error(`Soft delete is not enabled for table ${this.tableName}`)
        }

        const q = applyWhere(this.executor.updateTable(this.tableName) as any, this.tableName, where as any).set({
            [this.softDeleteColumn]: deletedAt,
        } as any)

        return ((await q.returningAll().executeTakeFirst()) as Selectable<Table>) ?? null
    }

    protected applyPopulate<P extends PopulateInput<DB, Populations>>(q: any, populate: P): any {
        return applyPopulateInner<DB>(
            q,
            this.tableName,
            this.populations,
            populate as any,
            0,
            [this.tableName],
            this.softDeleteRegistry,
        )
    }

    protected fixPopulatedKeys<P extends PopulateInput<DB, Populations>>(rows: any[], populate?: P): any[] {
        if (!populate || !rows.length) return rows

        const keys = (Object.keys(populate) as string[]).filter(k => (populate as any)[k])
        if (!keys.length) return rows

        return rows.map(row => {
            if (!row) return row

            const result = { ...row }

            for (const key of keys) {
                if (result[key] != null) result[key] = camelCaseKeys(result[key])
            }

            return result
        })
    }
}

type EnsureSelectable<T> = T extends any[] ? T : Selectable<T>

const POPULATE_MAX_DEPTH = 3

function applyPopulateInner<DB>(
    q: any,
    parentTableName: string,
    populations: PopulationMap<DB>,
    populate: Record<string, any>,
    depth: number,
    visitedPath: string[],
    softDeleteRegistry?: SoftDeleteRegistry<DB>,
): any {
    if (depth > POPULATE_MAX_DEPTH) return q

    for (const key of Object.keys(populate).filter(k => populate[k])) {
        const def = populations[key]
        if (!def) continue

        const popOptions = populate[key]
        const {
            table,
            foreignKey,
            localKey = "id",
            justOne,
            _nestedPopulations,
            softDeleteColumn,
            resolveSoftDeleteFromTable,
            defaultSelect,
            defaultWhere,
        } = def
        const tableStr = String(table)
        const resolvedSoftDeleteColumn =
            softDeleteColumn ??
            (resolveSoftDeleteFromTable
                ? getSoftDeleteColumnFromRegistry(softDeleteRegistry, table)
                : undefined)

        q = q.select((eb: any) => {
            let inner: any = eb.selectFrom(tableStr)

            const resolvedSelect =
                (typeof popOptions === "object" && popOptions.select)
                    ? (popOptions.select as Record<string, boolean>)
                    : defaultSelect

            if (resolvedSelect) {
                const cols = Object.entries(resolvedSelect)
                    .filter(([, v]) => v)
                    .map(([col]) => `${tableStr}.${col}`)
                inner = inner.select(cols)
            } else {
                inner = inner.selectAll(tableStr)
            }

            inner = inner.whereRef(`${tableStr}.${foreignKey}`, "=", `${parentTableName}.${localKey}`)

            if (resolvedSoftDeleteColumn && resolvedSoftDeleteColumn !== "false") {
                inner = inner.where(`${tableStr}.${resolvedSoftDeleteColumn}`, "is", null)
            }

            if (defaultWhere) {
                inner = applyWhere(inner, tableStr, defaultWhere)
            }
            if (typeof popOptions === "object" && popOptions.where) {
                inner = applyWhere(inner, tableStr, popOptions.where)
            }

            if (typeof popOptions === "object" && popOptions.orderBy) {
                const entries = Array.isArray(popOptions.orderBy) ? popOptions.orderBy : [popOptions.orderBy]
                for (const obj of entries) {
                    for (const [col, dir] of Object.entries(obj as Record<string, string>)) {
                        inner = inner.orderBy(`${tableStr}.${col}`, dir)
                    }
                }
            }

            if (typeof popOptions === "object" && popOptions.populate && _nestedPopulations) {
                if (visitedPath.includes(tableStr)) {
                    throw new Error(`Circular populate detected: ${[...visitedPath, tableStr].join(" -> ")}`)
                }

                const nestedPops = _nestedPopulations()

                if (Object.keys(nestedPops).length > 0) {
                    inner = applyPopulateInner<DB>(inner, tableStr, nestedPops, popOptions.populate, depth + 1, [
                        ...visitedPath,
                        tableStr,
                    ], softDeleteRegistry)
                }
            }

            return (justOne ? jsonObjectFrom(inner) : jsonArrayFrom(inner)).as(key)
        })
    }

    return q
}

export function definePopulation<DB, TRelated>(
    def: Omit<PopulationDefinition<DB, EnsureSelectable<TRelated>>, "_type" | "_nestedPopulations"> & {
        justOne: true
    },
): PopulationDefinition<DB, EnsureSelectable<TRelated>> & { justOne: true }

export function definePopulation<DB, TRelated>(
    def: Omit<PopulationDefinition<DB, EnsureSelectable<TRelated>>, "_type" | "_nestedPopulations"> & {
        justOne?: never
    },
): PopulationDefinition<DB, EnsureSelectable<TRelated>> & { justOne?: never }

export function definePopulation<
    DB,
    TRelated,
    TRelatedPops extends PopulationMap<DB>,
>(
    def: Omit<
        PopulationDefinition<DB, EnsureSelectable<TRelated>, TRelatedPops>,
        "_type" | "_nestedPopulations"
    > & {
        justOne: true
        nestedPopulations: () => TRelatedPops
    },
): PopulationDefinition<DB, EnsureSelectable<TRelated>, TRelatedPops> & { justOne: true }

export function definePopulation<
    DB,
    TRelated,
    TRelatedPops extends PopulationMap<DB>,
>(
    def: Omit<
        PopulationDefinition<DB, EnsureSelectable<TRelated>, TRelatedPops>,
        "_type" | "_nestedPopulations"
    > & {
        justOne?: never
        nestedPopulations: () => TRelatedPops
    },
): PopulationDefinition<DB, EnsureSelectable<TRelated>, TRelatedPops> & { justOne?: never }

export function definePopulation<DB, TRelated>(def: any) {
    const { nestedPopulations, ...rest } = def

    return {
        ...rest,
        _type: undefined as unknown as EnsureSelectable<TRelated>,
        ...(nestedPopulations ? { _nestedPopulations: nestedPopulations } : {}),
    }
}
