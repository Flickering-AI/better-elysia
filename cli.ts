#!/usr/bin/env node
import { parseArgs } from "node:util"
import { generateContract } from "./codegen.js"

const { values } = parseArgs({
    options: {
        module: { type: "string", short: "m" },
        out: { type: "string", short: "o" },
        tsconfig: { type: "string", short: "p" }
    }
})

if (!values.module || !values.out) {
    console.error("Usage: better-elysia --module <app.module.ts> --out <eden.generated.ts> [--tsconfig <tsconfig.json>]")
    process.exit(1)
}

try {
    const result = generateContract({ module: values.module, out: values.out, tsconfig: values.tsconfig })
    console.log(`Generated ${result.routes} routes and ${result.sockets} sockets at ${result.out}`)
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
}
