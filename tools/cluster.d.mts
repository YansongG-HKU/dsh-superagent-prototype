/** Declarations for the pure helpers exported by tools/cluster.mjs (used by tests/cluster.spec.ts). */
export declare function renderTemplate(template: string, values: Record<string, unknown>): string
export declare function normalizeRepository(value: unknown): string
export declare function deriveInstance(repository: string, existing?: readonly { name: string }[]): { name: string; profile: string }
export declare function nextPort(base: number, instances?: readonly { port?: number }[]): number
export declare function prepareCommand(clone: string): string
export declare function findWebUrl(log: string): string | undefined
export declare function originOf(url: string): string | undefined
export declare function renderProfilePatch(template: string, input: { port: number; stateDir: string; platform?: string }): string
export declare function expandPath(value: string | undefined, cwd?: string): string | undefined
export declare function cleanEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
