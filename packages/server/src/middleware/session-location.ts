import { Instance } from "@opencode/core/instance/service"
import { Session } from "@opencode/core/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { LocationNotFoundError, InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
import { locationErrors, requestRef, sessionInfo, type LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError, LocationNotFoundError],
}) {}

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* Instance.Service
    const fs = yield* FSUtil.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const session = yield* sessionInfo(sessions, route.params.sessionID)
        const request = yield* HttpServerRequest.HttpServerRequest
        const query = new URL(request.url, "http://localhost").searchParams
        // Recover only an explicitly requested local placement. Workspace directories
        // need not exist on this server, and the process cwd is not a recovery choice.
        if (
          session.location.workspaceID === undefined &&
          (query.get("location[directory]") || request.headers["x-opencode-directory"]) &&
          !(yield* fs.isDir(session.location.directory))
        ) {
          const destination = requestRef(request)
          if (destination.directory !== session.location.directory && (yield* fs.isDir(destination.directory))) {
            yield* sessions.move({ sessionID: session.id, directory: destination.directory }).pipe(
              Effect.catchTags({
                "Session.NotFoundError": () => sessionInfo(sessions, route.params.sessionID).pipe(Effect.asVoid),
                "Session.DestinationNotFoundError": () => Effect.void,
                "Session.DestinationNotDirectoryError": () => Effect.void,
                "Session.DestinationUnavailableError": () => Effect.void,
              }),
            )
            const recovered = yield* sessionInfo(sessions, session.id)
            return yield* effect.pipe(instances.provide(recovered), locationErrors)
          }
        }
        return yield* effect.pipe(instances.provide(session), locationErrors)
      }),
    )
  }),
)
