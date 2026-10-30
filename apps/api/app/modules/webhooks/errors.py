from app.errors import AppError


class WebhookNotConfiguredError(AppError):
    """STRIPE_WEBHOOK_SECRET is not set: nothing can be verified. Stripe retries a 503."""

    status_code = 503
    code = "not_configured"
    message = "This feature is not configured yet."


class InvalidSignatureError(AppError):
    status_code = 400
    code = "invalid_signature"
    message = "The signature does not match the body."


class InvalidPayloadError(AppError):
    status_code = 400
    code = "invalid_payload"
    message = "The body is not a Stripe event."


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "payload_too_large"
    message = "The body is too large."


class EnqueueFailedError(AppError):
    """The event is stored but could not be queued: a 500, so Stripe delivers it again and the
    redelivery queues the pending row."""

    status_code = 500
    code = "internal_error"
    message = "Internal server error."
