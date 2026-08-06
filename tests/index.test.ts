import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { HttpStatus } from "@flickering/http-status"
import { t } from "elysia"
import ts from "typescript"
import {
    ApiTag,
    BadRequestException,
    Body,
    Close,
    type Context,
    Controller,
    createCustomParameterDecorator,
    Delete,
    ElysiaFactory,
    ForbiddenException,
    Get,
    generateContract,
    Headers,
    HttpException,
    LoggerService,
    Message,
    MethodNotAllowedException,
    Module,
    NotFoundException,
    Open,
    Param,
    Params,
    Patch,
    Post,
    Public,
    Put,
    Query,
    RawContext,
    Request,
    Service,
    UnauthorizedException,
    Websocket,
    type WS
} from "../index"

const request = (path: string, init?: RequestInit) => new globalThis.Request(`http://localhost${path}`, init)

const Header = createCustomParameterDecorator(({ request }) => request.headers.get("x-test"))

const Payload = t.Object({ value: t.String({ minLength: 1 }) })
const Search = t.Object({ page: t.Numeric({ minimum: 1 }) })
const RequestHeaders = t.Object({ "x-api-key": t.String({ minLength: 1 }) })

@Service()
class TestService {
    format(value: string) {
        return `service:${value}`
    }
}

@ApiTag("Test")
@Controller("/api")
class TestController {
    constructor(private readonly service: TestService) {}

    @Get("/get")
    get() {
        return "get"
    }

    @Post("/body")
    post(@Body(Payload) body: typeof Payload.static) {
        return { value: this.service.format(body.value) }
    }

    @Put("/put")
    put() {
        return "put"
    }

    @Patch("/patch")
    patch() {
        return "patch"
    }

    @Delete("/delete")
    delete() {
        return "delete"
    }

    @Get("/lookup/:id/*")
    lookup(@Param("id", t.Number()) id: number, @Params() rest: string[], @Query(Search) query: typeof Search.static) {
        return { id, rest, page: query.page }
    }

    @Get("/context")
    context(@RawContext() context: Context, @Header header: string | null) {
        return { path: new URL(context.request.url).pathname, header }
    }

    @Get("/stream")
    async *stream() {
        yield "first"
        yield "second"
    }

    @Get("/headers")
    headers(@Headers(RequestHeaders) headers: typeof RequestHeaders.static) {
        return headers["x-api-key"]
    }

    @Get("/request")
    request(@Request() request: globalThis.Request) {
        return { method: request.method, path: new URL(request.url).pathname }
    }
}

@Controller("/auth")
class AuthController {
    @Get("/protected")
    protected() {
        return "protected"
    }

    @Public()
    @Get("/public")
    public() {
        return "public"
    }
}

@Websocket("/socket", { public: true })
class TestSocket {
    @Open()
    open(_ws: WS) {}

    @Message(Payload)
    message(_ws: WS, _message: typeof Payload.static) {}

    @Close()
    close(_ws: WS) {}
}

@Module({ controllers: [TestController, TestSocket] })
class TestModule {}

@Module({ controllers: [AuthController] })
class AuthModule {}

@Module({ controllers: [TestSocket] })
class SocketModule {}

const app = await ElysiaFactory.create(TestModule)
const authApp = await ElysiaFactory.create(AuthModule, {
    auth: ({ headers }) => (headers.authorization ? undefined : new globalThis.Response("Unauthorized", { status: 401 }))
})

describe("HTTP decorators", () => {
    test.each([
        ["GET", "/api/get", "get"],
        ["PUT", "/api/put", "put"],
        ["PATCH", "/api/patch", "patch"],
        ["DELETE", "/api/delete", "delete"]
    ])("%s registers %s", async (method, path, expected) => {
        const response = await app.handle(request(path, { method }))

        expect(response.status).toBe(200)
        expect(await response.text()).toBe(expected)
    })

    test("injects validated body and singleton service", async () => {
        const response = await app.handle(
            request("/api/body", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ value: "ok" })
            })
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ value: "service:ok" })
    })

    test("rejects an invalid body", async () => {
        const response = await app.handle(
            request("/api/body", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ value: "" })
            })
        )

        expect(response.status).toBe(422)
    })

    test("injects param, wildcard params, and validated query", async () => {
        const response = await app.handle(request("/api/lookup/42/a/b?page=2"))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ id: 42, rest: ["a", "b"], page: 2 })
    })

    test("rejects an invalid path parameter", async () => {
        const response = await app.handle(request("/api/lookup/not-a-number/a?page=2"))

        expect(response.status).toBe(422)
    })

    test("injects raw context and a custom parameter", async () => {
        const response = await app.handle(request("/api/context", { headers: { "x-test": "custom" } }))

        expect(await response.json()).toEqual({ path: "/api/context", header: "custom" })
    })

    test("injects and validates headers", async () => {
        const valid = await app.handle(request("/api/headers", { headers: { "x-api-key": "secret" } }))
        const invalid = await app.handle(request("/api/headers"))

        expect(await valid.text()).toBe("secret")
        expect(invalid.status).toBe(422)
    })

    test("injects the native request", async () => {
        const response = await app.handle(request("/api/request"))

        expect(await response.json()).toEqual({ method: "GET", path: "/api/request" })
    })

    test("streams values from an async generator", async () => {
        const response = await app.handle(request("/api/stream"))
        const body = await response.text()

        expect(response.status).toBe(200)
        expect(body).toContain("first")
        expect(body).toContain("second")
    })
})

describe("factory options", () => {
    test("runs beforeStart and attaches plugins", async () => {
        let started = false
        const factoryApp = await ElysiaFactory.create(TestModule, {
            beforeStart: [
                () => {
                    started = true
                }
            ],
            plugins: [
                (app) => {
                    app.get("/plugin", () => "plugin")
                    return app
                }
            ]
        })

        expect(started).toBe(true)
        expect(await (await factoryApp.handle(request("/plugin"))).text()).toBe("plugin")
    })

    test("enables CORS and OpenAPI documentation", async () => {
        const factoryApp = await ElysiaFactory.create(TestModule, {
            cors: { origin: "https://example.com" },
            swagger: { provider: "scalar", version: "latest" }
        })
        const corsResponse = await factoryApp.handle(request("/api/get", { headers: { origin: "https://example.com" } }))
        const openapiResponse = await factoryApp.handle(request("/openapi/json"))

        expect(corsResponse.headers.get("access-control-allow-origin")).toBe("https://example.com")
        expect(openapiResponse.status).toBe(200)
        expect((await openapiResponse.json()).paths["/api/get"]).toBeDefined()
    })

    test("protects routes and lets Public bypass auth", async () => {
        const denied = await authApp.handle(request("/auth/protected"))
        const allowed = await authApp.handle(request("/auth/protected", { headers: { authorization: "Bearer test" } }))
        const publicResponse = await authApp.handle(request("/auth/public"))

        expect(denied.status).toBe(401)
        expect(await allowed.text()).toBe("protected")
        expect(await publicResponse.text()).toBe("public")
    })

    test("registers WebSocket metadata and schema", async () => {
        const socketApp = await ElysiaFactory.create(SocketModule)
        const route = socketApp.routes.find(({ path }) => path === "/socket")
        const metadata = Reflect.getMetadata("metadata", TestSocket)

        expect(route?.method).toBe("WS")
        expect(metadata.body).toBe(Payload)
    })
})

describe("HTTP errors", () => {
    test.each([
        ["HttpException", new HttpException("Failure", 500), "Failure", 500],
        ["BadRequestException", new BadRequestException(), "Bad Request", HttpStatus.BAD_REQUEST],
        ["UnauthorizedException", new UnauthorizedException(), "Unauthorized", HttpStatus.UNAUTHORIZED],
        ["ForbiddenException", new ForbiddenException(), "Forbidden", HttpStatus.FORBIDDEN],
        ["NotFoundException", new NotFoundException(), "Not Found", HttpStatus.NOT_FOUND],
        ["MethodNotAllowedException", new MethodNotAllowedException(), "Method Not Allowed", HttpStatus.METHOD_NOT_ALLOWED]
    ])("%s exposes its message and status", (_name, error, message, status) => {
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe(message)
        expect(error.status).toBe(status)
    })
})

describe("LoggerService", () => {
    test("logs all public levels with the service name", () => {
        const output: string[] = []
        const consoleSpy = spyOn(console, "log").mockImplementation((message) => {
            output.push(String(message))
        })

        try {
            const logger = LoggerService("TestLogger")
            logger.log("ready")
            logger.error("failed")
            logger.debug("details")
        } finally {
            consoleSpy.mockRestore()
        }

        expect(output).toHaveLength(3)
        expect(output.every((line) => line.includes("TestLogger"))).toBe(true)
        expect(output.join(" ")).toContain("ready")
        expect(output.join(" ")).toContain("failed")
        expect(output.join(" ")).toContain("details")
    })
})

describe("Eden contract codegen", () => {
    test("generates typed HTTP and WebSocket routes", async () => {
        const directory = await mkdtemp(join(import.meta.dir, ".generated-"))
        const out = join(directory, "eden.generated.ts")

        try {
            const result = generateContract({
                module: import.meta.path,
                out,
                tsconfig: join(import.meta.dir, "../tsconfig.json")
            })
            const generated = await readFile(out, "utf8")

            expect(result.routes).toBe(10)
            expect(result.sockets).toBe(1)
            expect(generated).toContain('.post("/api/body"')
            expect(generated).toContain("body: schema<{ value: string; }>()")
            expect(generated).toContain('.ws("/socket"')
            expect(generated).toContain("export type App = typeof contract")

            const typeTest = join(directory, "eden.type-test.ts")
            await writeFile(
                typeTest,
                [
                    'import { treaty } from "@elysia/eden"',
                    'import type { App } from "./eden.generated"',
                    'const api = treaty<App>("http://localhost")',
                    'api.api.body.post({ value: "ok" })',
                    "// @ts-expect-error value must be a string",
                    "api.api.body.post({ value: 1 })",
                    'api.api.lookup({ id: 1 })["*"].get({ query: { page: 1 } })',
                    "api.socket.subscribe()"
                ].join("\n")
            )
            const config = ts.readConfigFile(join(import.meta.dir, "../tsconfig.json"), ts.sys.readFile)
            const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(import.meta.dir, ".."))
            const diagnostics = ts.getPreEmitDiagnostics(
                ts.createProgram({ rootNames: [out, typeTest], options: parsed.options })
            )

            expect(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([])
        } finally {
            await rm(directory, { recursive: true })
        }
    })
})
