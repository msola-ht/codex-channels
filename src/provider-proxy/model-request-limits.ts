/** DeepSeek accepts 48 MiB inline Responses requests; Cline accepted the same size in a bounded probe. */
export const maximumModelRequestBytes = 48 * 1024 * 1024;
/** Four maximum-sized requests may prepare concurrently; small requests reserve their declared length. */
export const maximumRetainedModelRequestBytes = 4 * maximumModelRequestBytes;
export const maximumBufferedModelRequests = 4;
export const maximumModelWebSocketQueueBytes = 2 * maximumModelRequestBytes;

/** The Gateway already limits every inbound image to this size before provider selection. */
export const maximumProviderImageUploadBytes = 10 * 1024 * 1024;
