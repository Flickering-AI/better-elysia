---
name: better-elysia
description: Build or migrate Bun Elysia applications to the decorator-based @flickering/better-elysia architecture. Use when an agent initializes a Better Elysia project, configures TypeScript decorators, creates modules/controllers/services and validated routes, migrates native Elysia routes, or optionally adds authentication, public routes, plugins, Swagger, CORS, custom parameter decorators, streaming, or WebSockets.
---

# Better Elysia

Use Bun and `@flickering/better-elysia`. Treat this repository's `index.ts` as the source of truth for exported decorators and runtime behavior; inspect it before using an API not shown here.

## Workflow

1. Inspect the target project's `package.json`, `tsconfig.json`, entry point, routes, middleware, and tests before editing.
2. Choose the path:
   - For a new app, initialize the minimum files described below.
   - For a migration, inventory every existing route, method, path, schema, hook, dependency, and WebSocket before converting it.
3. Implement one vertical slice first: schema, service if needed, controller, module registration, then bootstrap.
4. Add auth, `@Public()`, Swagger, CORS, plugins, streaming, or WebSockets only when required.
5. Run the target project's existing checks. At minimum run `bunx tsc --noEmit` and exercise one representative route.

Preserve route paths, HTTP methods, validation, status behavior, middleware order, and response shapes during migrations. Do not mix native `app.get()` routes and decorator routes without a concrete interoperability reason.

## Initialize

Install the package and Bun types:

```bash
bun add @flickering/better-elysia
bun add -d typescript @types/bun
```

Merge these required compiler options into the existing `tsconfig.json`; do not replace unrelated project settings:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ESNext",
    "strict": true,
    "noEmit": true,
    "types": ["bun"]
  }
}
```

Use a thin entry point:

```ts
import { ElysiaFactory, LoggerService } from '@flickering/better-elysia'
import { AppModule } from './app.module'

const app = await ElysiaFactory.create(AppModule)
app.listen(3000, () => LoggerService.log('Listening on http://localhost:3000'))
```

## Build The Core

Define schemas beside their feature and derive types from the same schema:

```ts
import { t } from '@flickering/better-elysia'

export const CreateUserBody = t.Object({ name: t.String({ minLength: 1 }) })
export type CreateUserBody = typeof CreateUserBody.static
```

Use `@Service()` only for shared state or reusable business logic. Services are singletons and must carry `@Service()` before constructor injection into a controller.

```ts
import { Service } from '@flickering/better-elysia'

@Service()
export class UserService {
  create(input: { name: string }) {
    return { id: crypto.randomUUID(), ...input }
  }
}
```

Keep transport concerns in controllers:

```ts
import { ApiTag, Body, Controller, Get, Param, Post, Request } from '@flickering/better-elysia'
import { CreateUserBody, type CreateUserBody as CreateUserInput } from './user.schema'
import { UserService } from './user.service'

@ApiTag('Users')
@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/:id')
  find(@Param('id') id: string, @Request() request: globalThis.Request) {
    return { id }
  }

  @Post()
  create(@Body(CreateUserBody) body: CreateUserInput) {
    return this.users.create(body)
  }
}
```

Register every controller and optional WebSocket class in exactly one module:

```ts
import { Module } from '@flickering/better-elysia'
import { UserController } from './user/user.controller'

@Module({ controllers: [UserController] })
export class AppModule {}
```

Use `@Query(schema)`, `@Headers(schema?)`, `@Param(name, schema?)`, `@Params()`, `@Request()`, and `@RawContext()` for query, headers, named path parameters, wildcard path segments, the native request, and the full Elysia context. Pass a schema such as `@Param('id', t.Number())` when Elysia must validate and convert a path parameter. Because the decorator shadows the Web `Request` constructor when imported by name, use `new globalThis.Request(...)` in the same file or alias the decorator import. Use `Get`, `Post`, `Put`, `Patch`, and `Delete` for route methods.

## Optional Features

Configure cross-cutting behavior once in `ElysiaFactory.create`:

```ts
const app = await ElysiaFactory.create(AppModule, {
  cors: { origin: 'https://example.com' },
  swagger: true,
  auth: ({ headers, status }) =>
    headers.authorization ? undefined : status(401, 'Unauthorized'),
  plugins: [(app) => app.state('name', 'api')],
  beforeStart: [connectDatabase]
})
```

- Add `@Public()` only to routes that must bypass a configured `auth` handler.
- Add `response` or `error` hooks only for a project-wide response contract.
- Return an async generator from a controller method for streaming.
- Use `createCustomParameterDecorator(handler)` when several routes derive the same argument from context.
- Throw the exported HTTP exception classes only when the target error handler understands their `status` property.

Add WebSockets only when requested:

```ts
import { Message, Open, Websocket, t, type WS } from '@flickering/better-elysia'

const ChatMessage = t.Object({ text: t.String() })

@Websocket('/chat', { public: true })
export class ChatSocket {
  @Open()
  open(ws: WS) {
    ws.send('connected')
  }

  @Message(ChatMessage)
  message(ws: WS, message: typeof ChatMessage.static) {
    ws.send(message)
  }
}
```

Use `@Close()` only when disconnect cleanup is needed. Omit `{ public: true }` when the socket must use the configured auth handler.

## Migrate Native Elysia

Convert routes feature by feature:

1. Move inline validation to exported `t` schemas without changing constraints.
2. Move reusable handler logic into a `@Service()`; leave one-off logic in the controller.
3. Map context fields to parameter decorators. Use `@Request()` for the native request and `@RawContext()` when no narrower decorator preserves behavior.
4. Replace route hooks with factory-level hooks or auth only when their scope is truly global.
5. Register the controller in `@Module`, remove the migrated native route, and verify parity before continuing.

Do not invent NestJS APIs. This package has no providers array, guards, pipes, interceptors, or dependency-injection container beyond `@Service()` singletons.

## Verify

Run:

```bash
bunx tsc --noEmit
bun test
```

Confirm at least one valid request, one validation failure, and every migrated route's method and path. When auth is enabled, also confirm one protected route and one `@Public()` route. When WebSockets are enabled, confirm connection and one schema-valid message.
