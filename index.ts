import { type CORSConfig, cors } from "@elysia/cors"
import { type ElysiaOpenAPIConfig, openapi } from "@elysia/openapi"
import colors from "colors"
import { format } from "date-fns"
import {
    type AfterHandler,
    type Context,
    Elysia,
    type ElysiaConfig,
    type EmptyRouteSchema,
    type ErrorHandler,
    type Handler,
    type SingletonBase,
    type TSchema,
    t
} from "elysia"
import type { ElysiaWS } from "elysia/ws"
import { HttpStatus } from "./http-status.js"
import "reflect-metadata"

//! TYPES
type IHttpException = { message: string; status: number }
type ClassLike = new (...args: any[]) => any
type ModuleProps = { controllers: ClassLike[] }
type fc = (...args: any[]) => any
type ElysiaSwaggerConfig<T extends string = string> = ElysiaOpenAPIConfig<true, T> & { version?: string }
type ElysiaCreateOptions<T extends string> = {
    cors?: boolean | CORSConfig
    swagger?: boolean | ElysiaSwaggerConfig<T extends string ? T : string>
    auth?: Handler
    response?: AfterHandler<EmptyRouteSchema, SingletonBase>
    error?: ErrorHandler<any, any>
    plugins?: ((app: Elysia) => Elysia)[]
    beforeStart?: fc[]
    config?: ElysiaConfig<T>
}
type HttpMethods = "get" | "post" | "put" | "delete" | "patch"
type HttpMethodMetadataSetterProps = {
    path: string
    method: HttpMethods
    handler: Handler
    controllerClass: ClassLike
}
type Metadata = {
    path: string
    method: HttpMethods
    handler: (...args: unknown[]) => unknown
    bodySchema?: { schema?: TSchema; index: number }
    querySchema?: { schema?: TSchema; index: number }
    headersSchema?: { schema?: TSchema; index: number }
    paramSlug?: { slug: string; schema?: TSchema; index: number }
    params?: { slug: "*"; index: number }
    rawContext?: { index: number }
    isPublic?: true
    customDecorators: { handler: Handler; index: number }[]
}
type WS = ElysiaWS

export { type GenerateContractOptions, generateContract } from "./codegen.js"
export type { AfterHandler, CORSConfig, Context, ElysiaOpenAPIConfig, ElysiaSwaggerConfig, ErrorHandler, Handler, TSchema, WS }

//! LOGGER SERVICE
function createLogger(serviceName = "ElysiaApplication") {
    function messageParser(message: unknown) {
        if (typeof message !== "string") return JSON.stringify(message)
        return message
    }

    function logToConsole(level: string, message: unknown) {
        let result = ""
        const time = format(new Date(), "yyyy-MM-dd HH:mm:ss")
        const parsedMessage = messageParser(message)

        switch (level) {
            case "log":
                result = `[${colors.green("LOG")}] ${colors.dim.yellow.bold.underline(
                    time
                )} [${colors.green(serviceName)}] ${parsedMessage}`
                break
            case "error":
                result = `[${colors.red("ERR")}] ${colors.dim.yellow.bold.underline(
                    time
                )} [${colors.red(serviceName)}] ${parsedMessage}`
                break
            case "info":
                result = `[${colors.yellow("INFO")}] ${colors.dim.yellow.bold.underline(
                    time
                )} [${colors.yellow(serviceName)}] ${parsedMessage}`
                break
        }
        console.log(result)
    }

    function log(message: unknown) {
        logToConsole("log", message)
    }
    function error(message: unknown) {
        logToConsole("error", message)
    }
    function debug(message: unknown) {
        logToConsole("info", message)
    }

    return { log, error, debug }
}

const singletonLogger = createLogger()

function LoggerService(serviceName?: string) {
    if (serviceName) {
        return createLogger(serviceName)
    }
    return singletonLogger
}

LoggerService.log = singletonLogger.log
LoggerService.error = singletonLogger.error
LoggerService.debug = singletonLogger.debug

//! CREATE DECORATOR
const createCustomParameterDecorator = (handler: Handler) => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        const customDecorators = Reflect.getMetadata("customDecorators", target[propertyKey]) || []
        customDecorators.push({ handler, index: parameterIndex })
        Reflect.defineMetadata("customDecorators", customDecorators, target[propertyKey])
    }
}

const Request = () => createCustomParameterDecorator(({ request }) => request)

//! Elysia Factory
const ElysiaFactory = {
    create: async <T extends string>(module: ClassLike, options?: ElysiaCreateOptions<T>): Promise<Elysia<T>> => {
        const app = new Elysia({ ...(options?.config || {}) })
        const logger = LoggerService("ElysiaFactory")
        logger.log("Starting elysia application")

        if (options?.beforeStart) {
            for (const eachBeforeStart of options.beforeStart) await eachBeforeStart()
        }

        // CORS SETTING
        if (options?.cors) {
            app.use(cors(typeof options.cors === "object" ? options.cors : {}))
        }

        if (options?.plugins) for (const plugin of options.plugins) app.use(plugin)

        // OPENAPI SETTING
        if (options?.swagger) {
            if (typeof options.swagger === "object") {
                const { version, ...config } = options.swagger
                if (version) {
                    if (config.provider === "swagger-ui") config.swagger = { ...config.swagger, version }
                    else config.scalar = { ...config.scalar, version }
                }
                app.use(openapi(config))
            } else {
                app.use(openapi())
            }
        }

        if (options?.error) {
            app.onError(options.error)
        }

        const controllers: ClassLike[] | undefined = Reflect.getMetadata("controllers", module)
        if (!controllers) {
            console.error("Invalid class module")
            process.exit(-1)
        }

        let injectedAppWithControllers = app
        for (const eachControllerClass of controllers) {
            const initializeController = Reflect.getMetadata("initialize", eachControllerClass)
            if (!initializeController) {
                console.error("Invalid class module")
                process.exit(-1)
            }

            injectedAppWithControllers = await initializeController(app, {
                auth: options?.auth,
                response: options?.response
            })
        }

        return injectedAppWithControllers
    }
}

//! DECORATORS
const ServicesMap = new Map<string, any>()
const nextTick = () => new Promise((resolve) => process.nextTick(resolve))
const httpMethodMetadataSetter = (props: HttpMethodMetadataSetterProps) => {
    const bodySchema = Reflect.getMetadata("body", props.handler)
    const paramSlug = Reflect.getMetadata("param", props.handler)
    const params = Reflect.getMetadata("params", props.handler)
    const querySchema = Reflect.getMetadata("query", props.handler)
    const headersSchema = Reflect.getMetadata("headers", props.handler)
    const rawContext = Reflect.getMetadata("rawContext", props.handler)
    const customDecorators = Reflect.getMetadata("customDecorators", props.handler) || []
    const isPublic = Reflect.getMetadata("public", props.handler)

    const { method, handler, controllerClass } = props
    const metadata: Metadata[] = Reflect.getMetadata("metadata", controllerClass) || []
    const path = props.path.startsWith("/") ? props.path : `/${props.path}`
    metadata.push({
        path,
        method,
        bodySchema,
        paramSlug,
        params,
        querySchema,
        headersSchema,
        customDecorators,
        rawContext,
        isPublic,
        handler: handler as any
    })
    Reflect.defineMetadata("metadata", metadata, controllerClass)
}

const Module = ({ controllers }: ModuleProps) => {
    return (target: ClassLike) => {
        Reflect.defineMetadata("controllers", controllers, target)
    }
}
const Controller = (prefix: string) => {
    if (prefix && !prefix.startsWith("/")) prefix = `/${prefix}`

    return (target: ClassLike) => {
        async function initializeController(
            app: Elysia,
            options?: {
                auth?: Handler
                response?: AfterHandler<EmptyRouteSchema, SingletonBase>
            }
        ): Promise<Elysia> {
            LoggerService("RoutesResolver").log(`${target.name} {${prefix}}`)

            await nextTick()
            const tag: string = Reflect.getMetadata("tag", target) ?? "default"
            const beforeHandle = options?.auth || ((_: Context) => {})
            const afterHandle = options?.response || ((_: Context) => {})

            const services = (Reflect.getMetadata("design:paramtypes", target) || []).map((EachService: ClassLike) => {
                const instance = ServicesMap.get(EachService.name)
                if (!instance) {
                    console.error(`Injected service is undefined in ${target.name}`)
                    console.error("Make sure injected service has @Service decorator")
                    process.exit(-1)
                }
                return instance
            })

            const controller = new target(...services)
            const metadata: Metadata[] = Reflect.getMetadata("metadata", target) || []
            for (const eachMetadata of metadata) {
                const getParameters = async (c: Context): Promise<any[]> => {
                    const parameters = [] as any
                    if (eachMetadata.rawContext) {
                        parameters[eachMetadata.rawContext.index] = c
                    }
                    if (eachMetadata.bodySchema) {
                        parameters[eachMetadata.bodySchema.index] = c.body
                    }
                    if (eachMetadata.querySchema) {
                        parameters[eachMetadata.querySchema.index] = c.query
                    }
                    if (eachMetadata.headersSchema) {
                        parameters[eachMetadata.headersSchema.index] = c.headers
                    }
                    if (eachMetadata.paramSlug) {
                        parameters[eachMetadata.paramSlug.index] = c.params?.[eachMetadata.paramSlug.slug]
                    }
                    if (eachMetadata.params) {
                        parameters[eachMetadata.params.index] = c.params?.[eachMetadata.params.slug]?.split("/")
                    }

                    if (eachMetadata.customDecorators) {
                        for (const eachCustomDecorator of eachMetadata.customDecorators) {
                            parameters[eachCustomDecorator.index] = await eachCustomDecorator.handler(c)
                        }
                    }

                    return parameters
                }
                const bondedHandler = eachMetadata.handler.bind(controller)
                const isGenerator = bondedHandler.constructor.name.includes("GeneratorFunction")
                const getHandler = () => {
                    if (isGenerator) {
                        return async function* (c: Context) {
                            try {
                                for await (const eachValue of bondedHandler(...(await getParameters(c))) as any[])
                                    yield eachValue
                            } catch (error: any) {
                                yield error
                            }
                        }
                    }
                    return async (c: Context) => bondedHandler(...(await getParameters(c)))
                }

                app.route(eachMetadata.method, prefix + eachMetadata.path, getHandler(), {
                    afterHandle: isGenerator ? undefined : (afterHandle as any),
                    beforeHandle: eachMetadata.isPublic ? undefined : beforeHandle,
                    config: {},
                    tags: [tag],
                    body: eachMetadata.bodySchema?.schema,
                    params: eachMetadata.paramSlug?.schema
                        ? t.Object(
                              { [eachMetadata.paramSlug.slug]: eachMetadata.paramSlug.schema },
                              { additionalProperties: true }
                          )
                        : undefined,
                    query: eachMetadata.querySchema?.schema as any,
                    headers: eachMetadata.headersSchema?.schema,
                    detail: !options?.auth || eachMetadata.isPublic ? { security: [] } : { security: [{ BearerAuth: [] }] }
                })

                LoggerService("RouterExplorer").log(
                    `Mapped {${
                        (Bun.env.ROUTE_PREFIX ?? "") + prefix + eachMetadata.path
                    }, ${eachMetadata.method.toUpperCase()}} route`
                )
            }

            return app
        }

        Reflect.defineMetadata("initialize", initializeController, target)
    }
}
const Websocket = (path: string, options?: { public?: boolean }) => {
    return (target: ClassLike) => {
        const isPublic = !!options?.public
        async function initializeController(
            app: Elysia,
            options?: { auth?: Handler; response?: AfterHandler }
        ): Promise<Elysia> {
            LoggerService("WebsocketResolver").log(`${target.name} {${path}}`)
            await nextTick()
            const services = (Reflect.getMetadata("design:paramtypes", target) || []).map((EachService: ClassLike) => {
                const instance = ServicesMap.get(EachService.name)
                if (!instance) {
                    console.error(`Injected service is undefined in ${target.name}`)
                    console.error("Make sure injected service has @Service decorator")
                    process.exit(-1)
                }
                return instance
            })

            const metadata = Reflect.getMetadata("metadata", target) || {}
            const controller = new target(...services)
            const open = metadata.open ? metadata.open.bind(controller) : undefined
            const close = metadata.close ? metadata.close.bind(controller) : undefined
            const message = metadata.message ? metadata.message.bind(controller) : undefined

            app.ws(path, {
                beforeHandle: !isPublic && (options?.auth as any),
                open,
                close,
                message,
                body: metadata.body
            })

            return app
        }

        Reflect.defineMetadata("initialize", initializeController, target)
    }
}

const Open = (): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        const metadata = Reflect.getMetadata("metadata", target.constructor) ?? {}
        metadata.open = desc.value
        Reflect.defineMetadata("metadata", metadata, target.constructor)
    }
}

const Close = (): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        const metadata = Reflect.getMetadata("metadata", target.constructor) ?? {}
        metadata.close = desc.value
        Reflect.defineMetadata("metadata", metadata, target.constructor)
    }
}

const Message = (schema?: TSchema): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        const metadata = Reflect.getMetadata("metadata", target.constructor) ?? {}
        metadata.message = desc.value
        metadata.body = schema
        Reflect.defineMetadata("metadata", metadata, target.constructor)
    }
}

const ApiTag = (tag: string) => {
    return (target: ClassLike) => {
        Reflect.defineMetadata("tag", tag, target)
    }
}
const Get = (path = "/"): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        process.nextTick(() =>
            httpMethodMetadataSetter({
                controllerClass: target.constructor as ClassLike,
                path,
                method: "get",
                handler: desc.value
            })
        )
    }
}
const Post = (path = "/"): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        process.nextTick(() =>
            httpMethodMetadataSetter({
                controllerClass: target.constructor as ClassLike,
                path,
                method: "post",
                handler: desc.value
            })
        )
    }
}
const Put = (path = "/"): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        process.nextTick(() =>
            httpMethodMetadataSetter({
                controllerClass: target.constructor as ClassLike,
                path,
                method: "put",
                handler: desc.value
            })
        )
    }
}
const Delete = (path = "/"): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        process.nextTick(() =>
            httpMethodMetadataSetter({
                controllerClass: target.constructor as ClassLike,
                path,
                method: "delete",
                handler: desc.value
            })
        )
    }
}
const Patch = (path = "/"): MethodDecorator => {
    return (target, _, desc: PropertyDescriptor) => {
        process.nextTick(() =>
            httpMethodMetadataSetter({
                controllerClass: target.constructor as ClassLike,
                path,
                method: "patch",
                handler: desc.value
            })
        )
    }
}

const Public = (): MethodDecorator => {
    return (_, __, desc: PropertyDescriptor) => {
        Reflect.defineMetadata("public", true, desc.value)
    }
}

const RawContext = () => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        Reflect.defineMetadata("rawContext", { index: parameterIndex }, target[propertyKey])
    }
}

const Body = (schema?: TSchema) => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        Reflect.defineMetadata("body", { schema, index: parameterIndex }, target[propertyKey])
    }
}

const Param = (slug: string, schema?: TSchema) => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        Reflect.defineMetadata("param", { slug, schema, index: parameterIndex }, target[propertyKey])
    }
}

const Params = () => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        Reflect.defineMetadata("params", { slug: "*", index: parameterIndex }, target[propertyKey])
    }
}

const Query = (schema?: TSchema) => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        Reflect.defineMetadata("query", { schema, index: parameterIndex }, target[propertyKey])
    }
}

const Headers = (schema?: TSchema) => {
    return (target: any, propertyKey: string, parameterIndex: number) => {
        Reflect.defineMetadata("headers", { schema, index: parameterIndex }, target[propertyKey])
    }
}

const Service = () => {
    return (target: ClassLike) => {
        const classname = target.name
        if (ServicesMap.has(classname)) {
            console.error(`Service ${classname} already exists`)
            process.exit(-1)
        }
        ServicesMap.set(classname, new target())
    }
}

export class HttpException extends Error implements IHttpException {
    status: number
    constructor(message: string, status: number) {
        super(message)
        this.name = this.constructor.name
        this.status = status || HttpStatus.INTERNAL_SERVER_ERROR
        Error.captureStackTrace(this, this.constructor)
    }
}

export class ForbiddenException extends HttpException {
    constructor(message: string = HttpStatus.FORBIDDEN_MESSAGE) {
        super(message, HttpStatus.FORBIDDEN)
    }
}

export class BadRequestException extends HttpException {
    constructor(message: string = HttpStatus.BAD_REQUEST_MESSAGE) {
        super(message, HttpStatus.BAD_REQUEST)
    }
}

export class UnauthorizedException extends HttpException {
    constructor(message: string = HttpStatus.UNAUTHORIZED_MESSAGE) {
        super(message, HttpStatus.UNAUTHORIZED)
    }
}

export class NotFoundException extends HttpException {
    constructor(message: string = HttpStatus.NOT_FOUND_MESSAGE) {
        super(message, HttpStatus.NOT_FOUND)
    }
}

export class MethodNotAllowedException extends HttpException {
    constructor(message: string = HttpStatus.METHOD_NOT_ALLOWED_MESSAGE) {
        super(message, HttpStatus.METHOD_NOT_ALLOWED)
    }
}

export {
    ApiTag,
    Body,
    Close,
    Controller,
    createCustomParameterDecorator,
    Delete,
    ElysiaFactory,
    Get,
    Headers,
    HttpStatus,
    LoggerService,
    Message,
    Module,
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
    Websocket
}
