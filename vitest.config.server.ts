import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: ['server/node/**/*.test.ts'],
        exclude: ['node_modules/**'],
    },
})
