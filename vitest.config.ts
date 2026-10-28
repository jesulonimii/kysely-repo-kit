import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        testTimeout: 20_000,
        hookTimeout: 30_000,
        typecheck: {
            enabled: true,
            include: ["test/**/*.test-d.ts"],
            tsconfig: "test/tsconfig.json",
        },
    },
})
