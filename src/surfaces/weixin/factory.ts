import type { Logger } from "pino";

import type { ConversationUseCases } from "../../application/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import type { OperationUpdateDisplay } from "../types.js";
import { WeixinAudioStore } from "./audio-store.js";
import { createCredentialBackedWeixinClient } from "./credential-client.js";
import { createWeixinCredentialStore } from "./credential-store.js";
import { WeixinFileInput } from "./file-input.js";
import { WeixinImageStore } from "./image-store.js";
import type { WeixinInputFatalError } from "./input-adapter.js";
import { createWeixinReplyContextPersistence } from "./reply-context-persistence.js";
import {
  WeixinSurface,
  type WeixinStartupNotification,
} from "./surface.js";
import { FileWeixinUpdatesCursorStore } from "./updates-cursor-store.js";

export interface CreateWeixinSurfaceOptions {
  accountId: string;
  service: ConversationUseCases;
  access: SurfaceAccessPolicy;
  actorRegistry: ConversationActorRegistry;
  credentialDirectory: string;
  replyContextDirectory: string;
  cursorDirectory: string;
  uploadsDirectory: string;
  startupNotification: WeixinStartupNotification;
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  fetchImpl?: typeof fetch;
  logger: Logger;
  onFatal(error: WeixinInputFatalError): void;
}

export function createWeixinSurface(
  options: CreateWeixinSurfaceOptions,
): WeixinSurface {
  const credentialStore = createWeixinCredentialStore(
    options.credentialDirectory,
  );
  const client = createCredentialBackedWeixinClient({
    accountId: options.accountId,
    credentialStore,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return new WeixinSurface({
    accountId: options.accountId,
    client,
    lifecycleClient: client,
    fileSendClient: client,
    imageSendClient: client,
    typingClient: client,
    cursorStore: new FileWeixinUpdatesCursorStore(options.cursorDirectory),
    service: options.service,
    access: options.access,
    actorRegistry: options.actorRegistry,
    credentialStore,
    replyContextPersistence: createWeixinReplyContextPersistence(
      options.replyContextDirectory,
    ),
    images: new WeixinImageStore(
      options.uploadsDirectory,
      options.logger,
      options.fetchImpl,
    ),
    files: new WeixinFileInput(options.fetchImpl),
    audios: new WeixinAudioStore(
      options.uploadsDirectory,
      options.logger,
      options.fetchImpl,
    ),
    startupNotification: options.startupNotification,
    ...(options.operationUpdateDisplay === undefined
      ? {}
      : { operationUpdateDisplay: options.operationUpdateDisplay }),
    ...(options.planUpdatesEnabled === undefined
      ? {}
      : { planUpdatesEnabled: options.planUpdatesEnabled }),
    logger: options.logger,
    onFatal: (error) => options.onFatal(error),
  });
}
