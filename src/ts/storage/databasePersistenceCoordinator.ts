export class DatabasePersistenceCoordinator {
    private tail: Promise<void> = Promise.resolve()
    private generation = 0

    captureGeneration() { return this.generation }

    private async withLease<T>(operation: () => T | Promise<T>): Promise<T> {
        let release!: () => void
        const previous = this.tail
        this.tail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try { return await operation() } finally { release() }
    }

    runNormalWrite<T>(expectedGeneration: number, write: () => T | Promise<T>) {
        return this.withLease(async () => {
            if (expectedGeneration !== this.generation) return { executed: false as const }
            return { executed: true as const, value: await write() }
        })
    }

    runExclusiveMutation<T>(mutation: () => T | Promise<T>) {
        return this.withLease(async () => {
            this.generation += 1
            try { return await mutation() } finally { this.generation += 1 }
        })
    }
}

export const databasePersistenceCoordinator = new DatabasePersistenceCoordinator()
