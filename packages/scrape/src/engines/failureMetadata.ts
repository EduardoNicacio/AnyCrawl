import { classifyFailure, type FailureClass } from "@anycrawl/libs";

export interface FailureMetadata {
    failure_class: FailureClass;
    /** The underlying error message when the failure came with an Error. */
    cause?: string;
}

/**
 * Metadata recorded on a failed request. `data` may be the thrown Error: spreading
 * an Error yields {}, so without lifting its message here the real cause of a
 * failure behind a 2xx/4xx response is lost to the generic status text.
 */
export function failureMetadata(input: {
    statusCode: number;
    message: string;
    data?: unknown;
    challengeDetected: boolean;
}): FailureMetadata {
    const { statusCode, message, data, challengeDetected } = input;
    const cause = data instanceof Error && data.message ? data.message.slice(0, 300) : undefined;
    return {
        failure_class: classifyFailure({ statusCode, message: cause ?? message, challengeDetected }),
        ...(cause ? { cause } : {}),
    };
}
