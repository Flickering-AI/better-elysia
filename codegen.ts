import { dirname, resolve } from "node:path"
import ts from "typescript"

const HTTP_DECORATORS = new Map([
    ["Get", "get"],
    ["Post", "post"],
    ["Put", "put"],
    ["Patch", "patch"],
    ["Delete", "delete"]
] as const)

type Route = {
    httpMethod: string
    path: string
    result: string
    body?: string
    query?: string
    headers?: string
    params: Map<string, string>
}

type Socket = {
    path: string
    body: string
}

export interface GenerateContractOptions {
    module: string
    out: string
    tsconfig?: string
}

export function generateContract(options: GenerateContractOptions) {
    const modulePath = resolve(options.module)
    const outPath = resolve(options.out)
    const configPath = options.tsconfig
        ? resolve(options.tsconfig)
        : ts.findConfigFile(dirname(modulePath), ts.sys.fileExists, "tsconfig.json")

    if (!configPath) throw new Error(`Cannot find tsconfig.json for ${modulePath}`)

    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error) throw diagnosticError(config.error)

    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath)
    if (parsed.errors.length) throw diagnosticError(parsed.errors[0])

    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
    const checker = program.getTypeChecker()
    const source = program.getSourceFile(modulePath)
    if (!source) throw new Error(`Module is not included by ${configPath}: ${modulePath}`)

    const moduleClass = source.statements.find(
        (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && decorator(node, "Module") !== undefined
    )
    if (!moduleClass) throw sourceError(source, source, "No @Module class found")

    const moduleDecorator = decorator(moduleClass, "Module")
    if (!moduleDecorator) throw sourceError(source, moduleClass, "No @Module class found")
    const controllers = moduleControllers(moduleDecorator, checker)
    const routes: Route[] = []
    const sockets: Socket[] = []

    for (const controller of controllers) {
        if (!controller.name) throw sourceError(controller.getSourceFile(), controller, "Controller must be named")

        const controllerDecorator = decorator(controller, "Controller")
        const websocketDecorator = decorator(controller, "Websocket")

        if (controllerDecorator) {
            const prefix = stringArgument(controllerDecorator.arguments[0], checker)
            for (const member of controller.members) {
                if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue
                const routeDecorator = decorators(member).map(asCall).find(isHttpDecorator)
                if (!routeDecorator) continue

                const httpMethod = HTTP_DECORATORS.get(decoratorName(routeDecorator) as HttpDecorator)
                if (!httpMethod) continue

                const route: Route = {
                    httpMethod,
                    path: joinPath(
                        prefix,
                        routeDecorator.arguments[0] ? stringArgument(routeDecorator.arguments[0], checker) : "/"
                    ),
                    result: returnType(member, checker),
                    params: new Map()
                }

                member.parameters.forEach((parameter) => {
                    for (const parameterDecorator of decorators(parameter).map(asCall).filter(Boolean) as ts.CallExpression[]) {
                        switch (decoratorName(parameterDecorator)) {
                            case "Body":
                                route.body = nodeType(parameter, checker)
                                break
                            case "Query":
                                route.query = nodeType(parameter, checker)
                                break
                            case "Headers":
                                route.headers = nodeType(parameter, checker)
                                break
                            case "Param":
                                route.params.set(
                                    stringArgument(parameterDecorator.arguments[0], checker),
                                    nodeType(parameter, checker)
                                )
                                break
                        }
                    }
                })
                routes.push(route)
            }
        } else if (websocketDecorator) {
            sockets.push({
                path: stringArgument(websocketDecorator.arguments[0], checker),
                body: nodeType(
                    controller.members.find(
                        (member): member is ts.MethodDeclaration =>
                            ts.isMethodDeclaration(member) && decorator(member, "Message") !== undefined
                    )?.parameters[1],
                    checker
                )
            })
        }
    }

    const output = renderContract(routes, sockets)
    ts.sys.createDirectory(dirname(outPath))
    ts.sys.writeFile(outPath, output)
    return { routes: routes.length, sockets: sockets.length, out: outPath }
}

function renderContract(routes: Route[], sockets: Socket[]) {
    const lines = [
        "// Generated by better-elysia. Do not edit.",
        'import { Elysia, type TSchema } from "elysia"',
        "",
        "type Schema<T> = TSchema & { static: T }",
        "const schema = <T>() => null as unknown as Schema<T>",
        "",
        "export const contract = new Elysia()"
    ]

    for (const route of routes) {
        const options: string[] = []
        if (route.body) options.push(`body: schema<${route.body}>()`)
        if (route.query) options.push(`query: schema<${route.query}>()`)
        if (route.headers) options.push(`headers: schema<${route.headers}>()`)

        const pathParams = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1])
        if (pathParams.length || route.path.includes("*")) {
            const properties = pathParams.map((name) => {
                return `${JSON.stringify(name)}: ${route.params.get(name) ?? "string"}`
            })
            if (route.path.includes("*")) {
                properties.push(`${JSON.stringify("*")}: string`)
            }
            options.push(`params: schema<{ ${properties.join("; ")} }>()`)
        }

        lines.push(
            `    .${route.httpMethod}(${JSON.stringify(route.path)}, () => null as unknown as Awaited<${route.result}>${
                options.length ? `, { ${options.join(", ")} }` : ""
            })`
        )
    }

    for (const socket of sockets) {
        lines.push(`    .ws(${JSON.stringify(socket.path)}, { body: schema<${socket.body}>() })`)
    }

    lines.push("", "export type App = typeof contract", "")
    return lines.join("\n")
}

function nodeType(node: ts.Node | undefined, checker: ts.TypeChecker) {
    if (!node) return "unknown"
    return formatType(checker.typeToString(checker.getTypeAtLocation(node), node, typeFormatFlags))
}

function returnType(method: ts.MethodDeclaration, checker: ts.TypeChecker) {
    const signature = checker.getSignatureFromDeclaration(method)
    return signature
        ? formatType(checker.typeToString(checker.getReturnTypeOfSignature(signature), method, typeFormatFlags))
        : "unknown"
}

const typeFormatFlags =
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.InTypeAlias

function formatType(value: string) {
    return value.replace(/import\("[^"]*\/node_modules\/elysia\/dist\/[^"/]+"\)/g, 'import("elysia")')
}

function moduleControllers(call: ts.CallExpression, checker: ts.TypeChecker) {
    const argument = call.arguments[0]
    if (!argument || !ts.isObjectLiteralExpression(argument))
        throw sourceError(call.getSourceFile(), call, "@Module requires an object literal")
    const property = argument.properties.find(
        (item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText() === "controllers"
    )
    if (!property || !ts.isArrayLiteralExpression(property.initializer)) {
        throw sourceError(call.getSourceFile(), call, "@Module controllers must be an array literal")
    }
    return property.initializer.elements.map((element) => classDeclaration(element, checker))
}

function classDeclaration(node: ts.Expression, checker: ts.TypeChecker) {
    let symbol = checker.getSymbolAtLocation(node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    const declaration = symbol?.declarations?.find(ts.isClassDeclaration)
    if (!declaration) throw sourceError(node.getSourceFile(), node, "Controller must resolve to a class")
    return declaration
}

function stringArgument(node: ts.Expression | undefined, checker: ts.TypeChecker): string {
    if (!node) throw new Error("Missing decorator argument")
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
        const declaration = symbol?.valueDeclaration
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
            return stringArgument(declaration.initializer, checker)
        }
    }
    throw sourceError(node.getSourceFile(), node, "Decorator path must be a string literal or a resolvable const")
}

function decorators(node: ts.Node) {
    return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []
}

function decorator(node: ts.Node, name: string) {
    return decorators(node)
        .map(asCall)
        .find((call) => call && decoratorName(call) === name)
}

function asCall(node: ts.Decorator) {
    return ts.isCallExpression(node.expression) ? node.expression : undefined
}

function decoratorName(call: ts.CallExpression) {
    return ts.isIdentifier(call.expression) ? call.expression.text : ""
}

type HttpDecorator = typeof HTTP_DECORATORS extends Map<infer K, string> ? K : never

function isHttpDecorator(call: ts.CallExpression | undefined): call is ts.CallExpression {
    return !!call && HTTP_DECORATORS.has(decoratorName(call) as HttpDecorator)
}

function joinPath(prefix: string, path: string) {
    const normalizedPrefix = prefix === "/" ? "" : prefix.replace(/\/$/, "")
    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    return normalizedPrefix + normalizedPath
}

function sourceError(source: ts.SourceFile, node: ts.Node, message: string) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    return new Error(`${source.fileName}:${line + 1}:${character + 1} ${message}`)
}

function diagnosticError(diagnostic: ts.Diagnostic) {
    return new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
}
