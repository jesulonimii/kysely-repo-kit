import {
    type ExpressionBuilder,
    type ExpressionWrapper,
    type Insertable,
    type Kysely,
    type RawBuilder,
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
    defaultSelect?: LazySelectInput<TRelated>
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
    select?: LazySelectInput<RelatedType<Def>>
    where?: WhereFilter<DB, Def["table"] & string>
    orderBy?: OrderByInput<RelatedType<Def>>
}
    :
    | true
    | {
    select?: LazySelectInput<RelatedType<Def>>
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

// Manual shape: selectable row columns plus the populated keys you declare in P.
export type WithPopulations<Row, P extends Record<string, unknown>> = Omit<Selectable<Row>, keyof P> & P

type RepoInstanceOf<Repo> = Repo extends abstract new (...args: any[]) => infer I ? I : Repo

// Inferred shape: takes a repo class or instance and the same populate input you pass to findMany.
export type Populated<Repo, P = Record<never, never>> =
    RepoInstanceOf<Repo> extends BaseRepository<infer DB, any, infer Populations, infer Table>
        ? P extends PopulateInput<DB, Populations>
            ? WithPopulated<DB, Table, Populations, P>
            : never
        : never

export type SelectInput<Row> = { [K in keyof Row]?: boolean }
export type LazySelectInput<Row> = SelectInput<Row> | (() => SelectInput<Row>)

function resolveSelectInput<Row>(input?: LazySelectInput<Row>): SelectInput<Row> | undefined {
    return typeof input === "function" ? (input as () => SelectInput<Row>)() : input
}

type ResolvedSelect = { mode: "include" | "exclude" | "all"; columns: string[] }

function computeResolvedSelect(
    defaultSelect: Record<string, boolean> | undefined,
    querySelect: Record<string, boolean> | undefined,
): ResolvedSelect {
    const hasDefault = !!defaultSelect && Object.keys(defaultSelect).length > 0
    const defaultIsWhitelist = hasDefault && Object.values(defaultSelect!).some(v => v === true)
    const queryHasTrue = Object.values(querySelect ?? {}).some(v => v === true)

    // Whitelist mode when the default itself is a whitelist, or (to preserve today's
    // single-object behavior) there's no default at all and the query uses `true`.
    const isWhitelistMode = defaultIsWhitelist || (!hasDefault && queryHasTrue)

    // Per-key: query wins over default for the same key.
    const merged: Record<string, boolean> = { ...defaultSelect, ...querySelect }
    const forced = Object.entries(merged).filter(([, v]) => v === true).map(([k]) => k)
    const hidden = Object.entries(merged).filter(([, v]) => v === false).map(([k]) => k)

    if (isWhitelistMode) {
        return forced.length ? { mode: "include", columns: forced } : { mode: "all", columns: [] }
    }

    // Default (if any) was exclude-style or absent -> blacklist mode; `forced` just
    // un-hides columns, it never switches the whole query into include-only.
    return hidden.length
        ? { mode: "exclude", columns: hidden.filter(c => !forced.includes(c)) }
        : { mode: "all", columns: [] }
}

function omitColumns<T extends Record<string, any>>(row: T, columns: string[]): T {
    const copy = { ...row }
    for (const col of columns) delete (copy as any)[col]
    return copy
}

export type OrderByInput<Row> =
    | { [K in keyof Row]?: "asc" | "desc" }
    | { [K in keyof Row]?: "asc" | "desc" }[]

export type PopulateInput<DB, Populations extends PopulationMap<DB>> = {
    [K in keyof Populations]?: PopulateKeyOption<DB, Populations[K]>
}

export type FindManyArgs<
    DB,
    TableName extends keyof DB & string,
    Populations extends PopulationMap<DB>,
    Table extends object = InferTable<DB, TableName>,
    P extends PopulateInput<DB, Populations> = Record<never, never>,
> = {
    where?: WhereFilter<DB, TableName, Table>
    select?: SelectInput<Table>
    populate?: P
    skip?: number
    take?: number
    orderBy?: OrderByInput<Table>
    lock?: "update" | "share"
    includeDeleted?: boolean
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

// Empty IN lists are invalid SQL, so empty in/notIn compile to these constant predicates instead.
const ALWAYS_FALSE = sql<boolean>`1 = 0`
const ALWAYS_TRUE = sql<boolean>`1 = 1`

function isEmptyList(v: unknown): boolean {
    return Array.isArray(v) && v.length === 0
}

// An undefined identity operator (equals, not, in, notIn) matches nothing; an undefined range or text operator is skipped.
function fieldOps(col: string, f: Record<string, unknown>, insensitive: boolean): Array<[string, unknown, unknown]> {
    const ops: Array<[unknown, string, unknown]> = []
    const iCol = sql`lower(${sql.ref(col)})`
    const never: [unknown, string, unknown] = [sql`1`, "=", sql`0`]

    if ("equals" in f) ops.push([col, "=", f.equals])
    if ("not" in f) ops.push(f.not === null ? [col, "is not", null] : [col, "!=", f.not])
    if ("in" in f) ops.push(f.in === undefined || isEmptyList(f.in) ? never : [col, "in", f.in])
    if ("notIn" in f) {
        ops.push(f.notIn === undefined ? never : isEmptyList(f.notIn) ? [sql`1`, "=", sql`1`] : [col, "not in", f.notIn])
    }
    if (f.gt !== undefined) ops.push([col, ">", f.gt])
    if (f.gte !== undefined) ops.push([col, ">=", f.gte])
    if (f.lt !== undefined) ops.push([col, "<", f.lt])
    if (f.lte !== undefined) ops.push([col, "<=", f.lte])

    if (f.contains !== undefined) {
        const v = f.contains as string
        ops.push(insensitive ? [iCol, "like", `%${v.toLowerCase()}%`] : [col, "like", `%${v}%`])
    }

    if (f.startsWith !== undefined) {
        const v = f.startsWith as string
        ops.push(insensitive ? [iCol, "like", `${v.toLowerCase()}%`] : [col, "like", `${v}%`])
    }

    if (f.endsWith !== undefined) {
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

// Follows the fieldOps undefined rules, so an undefined path value or identity operator matches nothing.
function jsonbConditions(tableName: string, jsonb: Record<string, unknown>): RawBuilder<boolean>[] {
    const conds: RawBuilder<boolean>[] = []

    for (const [path, rawValue] of Object.entries(jsonb)) {
        const expr = jsonbTextExpr(tableName, path)

        if (rawValue === undefined) {
            conds.push(ALWAYS_FALSE)
        } else if (rawValue === null) {
            conds.push(sql<boolean>`${expr} is null`)
        } else if (typeof rawValue !== "object" || rawValue instanceof Date) {
            conds.push(sql<boolean>`${expr} = ${String(rawValue)}`)
        } else {
            const f = rawValue as Record<string, unknown>
            const insensitive = f.mode === "insensitive"

            if ("equals" in f) {
                conds.push(
                    f.equals === undefined
                        ? ALWAYS_FALSE
                        : insensitive
                            ? sql<boolean>`lower(${expr}) = lower(${String(f.equals)})`
                            : sql<boolean>`${expr} = ${String(f.equals)}`,
                )
            }

            if ("not" in f) {
                conds.push(
                    f.not === undefined
                        ? ALWAYS_FALSE
                        : f.not === null
                            ? sql<boolean>`${expr} is not null`
                            : insensitive
                                ? sql<boolean>`lower(${expr}) != lower(${String(f.not)})`
                                : sql<boolean>`${expr} != ${String(f.not)}`,
                )
            }

            if (f.contains !== undefined) {
                const v = String(f.contains)
                conds.push(
                    insensitive
                        ? sql<boolean>`lower(${expr}) like ${`%${v.toLowerCase()}%`}`
                        : sql<boolean>`${expr} like ${`%${v}%`}`,
                )
            }

            if (f.startsWith !== undefined) {
                const v = String(f.startsWith)
                conds.push(
                    insensitive
                        ? sql<boolean>`lower(${expr}) like ${`${v.toLowerCase()}%`}`
                        : sql<boolean>`${expr} like ${`${v}%`}`,
                )
            }

            if (f.endsWith !== undefined) {
                const v = String(f.endsWith)
                conds.push(
                    insensitive
                        ? sql<boolean>`lower(${expr}) like ${`%${v.toLowerCase()}`}`
                        : sql<boolean>`${expr} like ${`%${v}`}`,
                )
            }

            if ("in" in f) {
                conds.push(
                    f.in === undefined || isEmptyList(f.in)
                        ? ALWAYS_FALSE
                        : sql<boolean>`${expr} in (${sql.join((f.in as unknown[]).map(String))})`,
                )
            }

            if ("notIn" in f) {
                conds.push(
                    f.notIn === undefined
                        ? ALWAYS_FALSE
                        : isEmptyList(f.notIn)
                            ? ALWAYS_TRUE
                            : sql<boolean>`${expr} not in (${sql.join((f.notIn as unknown[]).map(String))})`,
                )
            }
        }
    }

    return conds
}

// Mirrors applyWhere: returns false when the filter compiles to no condition and so matches every row.
function restricts(tableName: string, filter: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
        if (key === "AND") {
            if ((value as Record<string, unknown>[]).some(sub => restricts(tableName, sub))) return true
        } else if (key === "OR") {
            const subs = value as Record<string, unknown>[]
            if (subs.length === 0 || subs.every(sub => restricts(tableName, sub))) return true
        } else if (key === "jsonb") {
            if (jsonbConditions(tableName, value as Record<string, unknown>).length > 0) return true
        } else if (key === "NOT" || key === "_raw") {
            return true
        } else if (value === null || typeof value !== "object" || value instanceof Date) {
            return true
        } else if (fieldOps(`${tableName}.${key}`, value as Record<string, unknown>, false).length > 0) {
            return true
        }
    }

    return false
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
            parts.push(...jsonbConditions(tableName, value as Record<string, unknown>))
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
            for (const cond of jsonbConditions(tableName, value as Record<string, unknown>)) q = q.where(cond)
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
    readonly populations: Populations
    protected readonly softDeleteColumn?: keyof Table & string
    protected readonly softDeleteRegistry?: SoftDeleteRegistry<DB>
    protected readonly defaultSelect?: SelectInput<Table>

    constructor({
                    db,
                    tableName,
                    transaction,
                    populations,
                    softDeleteColumn,
                    softDeleteRegistry,
                    defaultSelect,
                }: {
        db: Kysely<DB>
        tableName: TableName
        transaction?: Transaction<DB>
        populations?: Populations
        softDeleteColumn?: keyof Table & string
        softDeleteRegistry?: SoftDeleteRegistry<DB>
        defaultSelect?: SelectInput<Table>
    }) {
        this.db = db
        this.tableName = tableName
        this.transaction = transaction
        this.populations = (populations ?? {}) as Populations
        this.softDeleteColumn = softDeleteColumn
        this.softDeleteRegistry = softDeleteRegistry
        this.defaultSelect = defaultSelect
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
                                                                                    }: FindManyArgs<DB, TableName, Populations, Table, P> = {}): Promise<WithPopulated<DB, Table, Populations, P>[]> {
        let q: any = this.executor.selectFrom(this.tableName)
        q = applyWhere(q, this.tableName, this.withSoftDeleteFilter(where as any, includeDeleted))
        q = q.offset(skip).limit(take)
        if (orderBy) q = this.applyOrderBy(q, orderBy)
        q = this.applySelect(q, select)
        if (populate) q = this.applyPopulate(q, populate)
        if (lock === "update") q = q.forUpdate()
        else if (lock === "share") q = q.forShare()
        const rows = this.applyExclusion(await q.execute(), select)
        return this.fixPopulatedKeys(rows, populate) as any
    }

    async findManyAndCount<P extends PopulateInput<DB, Populations> = Record<never, never>>(
        args: FindManyArgs<DB, TableName, Populations, Table, P> = {},
    ): Promise<[WithPopulated<DB, Table, Populations, P>[], number]> {
        const {
            where = {} as WhereFilter<DB, TableName, Table>,
            includeDeleted = false,
        } = args

        return Promise.all([
            this.findMany<P>(args),
            this.count({ where, includeDeleted }),
        ])
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

        const [stripped] = this.applyExclusion([row], select)
        const [result] = this.fixPopulatedKeys([stripped], populate)
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

        const [stripped] = this.applyExclusion([row], select)
        const [result] = this.fixPopulatedKeys([stripped], populate)
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
        this.assertWhereRestricts(where, "update")
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
                         select,
                     }: {
        where: WhereFilter<DB, TableName, Table>
        data: Updateable<DB[TableName]>
        select?: SelectInput<Table>
    }): Promise<Selectable<Table>[]> {
        this.assertWhereRestricts(where, "updateMany")
        let q: any = (this.executor.updateTable(this.tableName) as any).set(data as any)
        q = applyWhere(q, this.tableName, where as any)

        // Return only ids by default to keep the payload small; defaultSelect does not apply here.
        if (!select) {
            return (await q.returning([`${this.tableName}.id`]).execute()) as Selectable<Table>[]
        }

        const resolved = this.resolveSelect(select)
        if (resolved.mode === "include") {
            return (await q.returning(resolved.columns.map(k => `${this.tableName}.${k}`)).execute()) as Selectable<Table>[]
        }

        const rows = (await q.returningAll().execute()) as Selectable<Table>[]
        return this.applyExclusion(rows, select)
    }

    async upsert({
                     where,
                     create,
                     update,
                 }: {
        where: WhereFilter<DB, TableName, Table>
        create: Insertable<DB[TableName]>
        update: Updateable<DB[TableName]>
    }): Promise<Selectable<Table>> {
        const processedCreate = await this.beforeCreate(create)
        const processedUpdate = await this.beforeUpdate(update, where)
        const conflictColumns = Object.keys(where) as any
        const values = { ...where, ...processedCreate } as any

        if (Object.keys(processedUpdate).length > 0) {
            return (await this.executor
                .insertInto(this.tableName)
                .values(values)
                .onConflict(oc => oc.columns(conflictColumns).doUpdateSet(processedUpdate as any))
                .returningAll()
                .executeTakeFirstOrThrow()) as unknown as Selectable<Table>
        }

        const execute = async (): Promise<Selectable<Table> | undefined> => {
            let existing: any = (this.executor.selectFrom(this.tableName) as any).selectAll()
            existing = applyWhere(existing, this.tableName, where as any)

            return (await (this.executor as any)
                .with("inserted", (db: any) =>
                    db
                        .insertInto(this.tableName)
                        .values(values)
                        .onConflict((oc: any) => oc.columns(conflictColumns).doNothing())
                        .returningAll(),
                )
                .selectFrom("inserted")
                .selectAll()
                .unionAll(existing)
                .executeTakeFirst()) as Selectable<Table> | undefined
        }

        const row = await execute()
        if (row) return row

        const retriedRow = await execute()
        if (retriedRow) return retriedRow

        throw new Error(`Upsert could not resolve a row for table ${this.tableName}`)
    }

    async upsertMany({
                         data,
                     }: {
        data: {
            where: WhereFilter<DB, TableName, Table>
            create: Insertable<DB[TableName]>
            update: Updateable<DB[TableName]>
        }[]
    }): Promise<Selectable<Table>[]> {
        const rows: Selectable<Table>[] = []
        for (const item of data) {
            rows.push(await this.upsert(item))
        }
        return rows
    }

    async hardDelete({ where }: { where: WhereFilter<DB, TableName, Table> }): Promise<Selectable<Table> | null> {
        this.assertWhereRestricts(where, "hardDelete")
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

        this.assertWhereRestricts(where, "softDelete")
        await this.beforeDelete(where)

        const q = this.liveRowsOnly(applyWhere(this.executor.updateTable(this.tableName) as any, this.tableName, where as any)).set({
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
        this.assertWhereRestricts(where, "deleteMany")
        if (this.isSoftDeletableTable()) {
            const soft = this.liveRowsOnly(applyWhere(this.executor.updateTable(this.tableName) as any, this.tableName, where as any)).set({
                [this.softDeleteColumn as string]: new Date(),
            } as any)
            return Number((await soft.executeTakeFirst()).numUpdatedRows)
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

    async countMany<K extends string>({
        where,
        includeDeleted = false,
    }: {
        where: Record<K, WhereFilter<DB, TableName, Table>>
        includeDeleted?: boolean
    }): Promise<Record<K, number>> {
        const keys = Object.keys(where) as K[]
        if (keys.length === 0) return {} as Record<K, number>

        const row: any = await (this.executor as Kysely<DB>)
            .selectNoFrom(eb =>
                keys.map(key => {
                    let sub: any = eb.selectFrom(this.tableName)
                    sub = applyWhere(sub, this.tableName, this.withSoftDeleteFilter(where[key] as any, includeDeleted))
                    return sub.select(sql<string>`count(*)`.as("count")).as(key)
                }),
            )
            .executeTakeFirstOrThrow()

        const result = {} as Record<K, number>
        for (const key of keys) {
            result[key] = parseInt(row[key] ?? "0", 10)
        }
        return result
    }

    async exists(args: { where?: WhereFilter<DB, TableName, Table>; includeDeleted?: boolean } = {}): Promise<boolean> {
        return (await this.count(args)) > 0
    }

    protected resolveSelect(select?: SelectInput<Table>): ResolvedSelect {
        return computeResolvedSelect(
            this.defaultSelect as Record<string, boolean> | undefined,
            select as Record<string, boolean> | undefined,
        )
    }

    protected applyExclusion<T>(rows: T[], select?: SelectInput<Table>): T[] {
        const resolved = this.resolveSelect(select)
        if (resolved.mode !== "exclude") return rows
        return rows.map(row => (row ? omitColumns(row as any, resolved.columns) : row)) as T[]
    }

    protected async returning(q: any, select?: SelectInput<Table>, orThrow = false): Promise<Selectable<Table> | null> {
        const resolved = this.resolveSelect(select)
        let built: any

        if (resolved.mode === "include") {
            built = q.returning(resolved.columns.map(k => `${this.tableName}.${k}`))
        } else {
            built = q.returningAll()
        }

        const row = orThrow ? await built.executeTakeFirstOrThrow() : await built.executeTakeFirst()
        if (!row) return null

        return (resolved.mode === "exclude" ? omitColumns(row, resolved.columns) : row) as Selectable<Table>
    }

    protected applySelect(q: any, select?: SelectInput<Table>): any {
        const resolved = this.resolveSelect(select)
        if (resolved.mode === "include") {
            return q.select(resolved.columns.map(k => `${this.tableName}.${k}`))
        }
        return q.selectAll(this.tableName)
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

    // A non-empty where that compiles to no condition is almost always an undefined id, so refuse it.
    protected assertWhereRestricts(where: WhereFilter<DB, TableName, Table>, method: string): void {
        const filter = (where ?? {}) as Record<string, unknown>
        if (Object.keys(filter).length > 0 && !restricts(this.tableName, filter)) {
            throw new Error(
                `${method} on ${this.tableName} refused: every where condition is undefined, so it would touch every row. Pass where: {} to target every row on purpose.`,
            )
        }
    }

    // Soft deletes skip rows that are already deleted, so the first deleted_at stays and counts stay right.
    protected liveRowsOnly(q: any): any {
        return q.where(`${this.tableName}.${this.softDeleteColumn}`, "is", null)
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

        const q = this.liveRowsOnly(applyWhere(this.executor.updateTable(this.tableName) as any, this.tableName, where as any)).set({
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

            const resolvedSelect = resolveSelectInput(
                (typeof popOptions === "object" && popOptions.select)
                    ? popOptions.select
                    : defaultSelect,
            ) as Record<string, boolean> | undefined

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
