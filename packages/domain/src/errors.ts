export type ErrorOptions = {
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
};

export class AppError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;
  public readonly retryable: boolean;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: string,
    safeMessage: string,
    retryable: boolean,
    options: ErrorOptions = {},
  ) {
    super(
      safeMessage,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = retryable;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class ValidationError extends AppError {
  public constructor(
    message = "Input validation failed",
    options?: ErrorOptions,
  ) {
    super("VALIDATION_FAILED", message, false, options);
  }
}

export class AuthenticationError extends AppError {
  public constructor(
    message = "Authentication failed",
    options?: ErrorOptions,
  ) {
    super("AUTHENTICATION_FAILED", message, false, options);
  }
}

export class AuthorizationError extends AppError {
  public constructor(
    message = "Action is not authorized",
    options?: ErrorOptions,
  ) {
    super("AUTHORIZATION_FAILED", message, false, options);
  }
}

export class DuplicateEventError extends AppError {
  public constructor(message = "Event already exists", options?: ErrorOptions) {
    super("DUPLICATE_EVENT", message, false, options);
  }
}

export class RetryableProcessingError extends AppError {
  public constructor(
    code = "RETRYABLE_PROCESSING_ERROR",
    message = "Processing failed temporarily",
    options?: ErrorOptions,
  ) {
    super(code, message, true, options);
  }
}

export class PermanentProcessingError extends AppError {
  public constructor(
    code = "PERMANENT_PROCESSING_ERROR",
    message = "Processing cannot continue",
    options?: ErrorOptions,
  ) {
    super(code, message, false, options);
  }
}

export class ExternalProviderError extends AppError {
  public constructor(
    message = "External provider request failed",
    retryable = true,
    options?: ErrorOptions,
  ) {
    super("EXTERNAL_PROVIDER_ERROR", message, retryable, options);
  }
}

export class ConfigurationError extends AppError {
  public constructor(
    message = "Application configuration is invalid",
    options?: ErrorOptions,
  ) {
    super("CONFIGURATION_ERROR", message, false, options);
  }
}

export class ConsistencyError extends AppError {
  public constructor(
    code = "CONSISTENCY_ERROR",
    message = "Internal data consistency check failed",
    options?: ErrorOptions,
  ) {
    super(code, message, false, options);
  }
}

export const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  return new RetryableProcessingError(
    "UNEXPECTED_PROCESSING_ERROR",
    "Unexpected processing error",
    { cause: error },
  );
};
