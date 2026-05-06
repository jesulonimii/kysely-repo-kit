// repo-builder.ts
import type { Kysely, Selectable, Transaction } from "kysely"
import BaseRepository, {
    definePopulation,
    type InferTable,
    type PopulateInput,
    type PopulationMap,
    type SoftDeleteRegistry,
} from "./base"

type EmptyPopulations = Record<never, never>


type InferSelectableRow<DB, TableName extends keyof DB & string> =
    DB[TableName] extends object
        ? Selectable<DB[TableName]>
        : never

type InferRow<DB, TableName extends keyof DB & string> =
    DB[TableName] extends object
        ? Selectable<DB[TableName]>
        : never

export type RepoInstance<
    DB,
    TableName extends keyof DB & string,
    Populations extends PopulationMap<DB>,
> = BaseRepository<DB, TableName, Populations> & {
    opts<P extends PopulateInput<DB, Populations> = EmptyPopulations>(): {
        populate?: P
    }
}

export type RepoConstructor<
    DB,
    TableName extends keyof DB & string,
    Populations extends PopulationMap<DB>,
> = {
    new (
        db: Kysely<DB>,
        transaction?: Transaction<DB>,
    ): RepoInstance<DB, TableName, Populations>

    readonly tableName: TableName
    readonly populations: Populations
}

type PopulateConfig<
    DB,
    Name extends string,
    Ref extends keyof DB & string,
    NestedPopulations extends PopulationMap<DB> = Record<never, never>,
> = {
    as: Name
    ref: Ref
    foreignKey?: keyof InferSelectableRow<DB, Ref> & string
    localKey?: string
    justOne?: true
    softDelete?: (keyof InferSelectableRow<DB, Ref> & string) | false
    nestedPopulations?: () => NestedPopulations
}

type TableBuilderConfig<
    DB,
    TableName extends keyof DB & string,
> = {
    softDelete?: (keyof InferSelectableRow<DB, TableName> & string) | false
}

class RepoBuilder<
    DB,
    TableName extends keyof DB & string,
    Populations extends PopulationMap<DB> = EmptyPopulations,
    Table extends object = InferTable<DB, TableName>,
> {
    constructor(
        private readonly currentTableName: TableName,
        private readonly currentPopulations: Populations = {} as Populations,
        private readonly currentSoftDeleteColumn?: keyof Selectable<Table> & string,
        private readonly softDeleteRegistry?: SoftDeleteRegistry<DB>,
    ) {}

    softDelete<Column extends keyof Selectable<Table> & string>(column: Column | false) {
        this.softDeleteRegistry?.set(this.currentTableName, column === false ? false : column)

        return new RepoBuilder<DB, TableName, Populations, Table>(
            this.currentTableName,
            this.currentPopulations,
            (column === false ? undefined : column),
            this.softDeleteRegistry,
        )
    }

    populate<
        Name extends string,
        Ref extends keyof DB & string,
        NestedPopulations extends PopulationMap<DB> = Record<never, never>,
    >(def: PopulateConfig<DB, Name, Ref, NestedPopulations>) {
        const isSingle = Boolean(def.localKey || def.justOne)
        const population = definePopulation<DB, InferRow<DB, Ref>, NestedPopulations>({
            table: def.ref,
            foreignKey: def.foreignKey ?? "id",
            localKey: def.localKey,
            ...(isSingle ? { justOne: true } : {}),
            ...(def.softDelete === false ? {} : def.softDelete ? { softDeleteColumn: def.softDelete } : {
                resolveSoftDeleteFromTable: true,
            }),
            ...(def.nestedPopulations ? { nestedPopulations: def.nestedPopulations } : {}),
        } as any)

        return new RepoBuilder<
            DB,
            TableName,
            Populations & Record<Name, typeof population>,
            Table
        >(
            this.currentTableName,
            {
                ...this.currentPopulations,
                [def.as]: population,
            } as Populations & Record<Name, typeof population>,
            this.currentSoftDeleteColumn,
            this.softDeleteRegistry,
        )
    }

    get init(): RepoConstructor<DB, TableName, Populations> {
        const tableName = this.currentTableName
        const populations = this.currentPopulations
        const softDeleteColumn = this.currentSoftDeleteColumn
        const softDeleteRegistry = this.softDeleteRegistry

        class GeneratedRepository extends BaseRepository<
            DB,
            TableName,
            Populations
        > {
            static readonly tableName = tableName
            static readonly populations = populations

            constructor(db: Kysely<DB>, transaction?: Transaction<DB>) {
                super({
                    db,
                    transaction,
                    tableName,
                    populations,
                    softDeleteColumn: softDeleteColumn as any,
                    softDeleteRegistry,
                })
            }

            opts<P extends PopulateInput<DB, Populations> = EmptyPopulations>() {
                return {} as { populate?: P }
            }
        }

        return GeneratedRepository as RepoConstructor<DB, TableName, Populations>
    }
}

export function createRepoBuilder<DB>() {
    const softDeleteRegistry: SoftDeleteRegistry<DB> = new Map()

    return {
        table<TableName extends keyof DB & string>(
            tableName: TableName,
            tableConfig: TableBuilderConfig<DB, TableName> = {},
        ) {
            const inheritedSoftDelete = softDeleteRegistry.get(tableName)
            const softDeleteColumn =
                tableConfig.softDelete === false
                    ? undefined
                    : tableConfig.softDelete ?? (typeof inheritedSoftDelete === "string" ? inheritedSoftDelete : undefined)

            if (tableConfig.softDelete === false) {
                softDeleteRegistry.set(tableName, false)
            } else if (softDeleteColumn) {
                softDeleteRegistry.set(tableName, softDeleteColumn)
            }

            return new RepoBuilder<DB, TableName>(
                tableName,
                {} as EmptyPopulations,
                softDeleteColumn as any,
                softDeleteRegistry,
            )
        },
    }
}
