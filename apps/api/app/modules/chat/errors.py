from app.errors import AppError, ConflictError


class ChatClosedError(ConflictError):
    """A message on a job whose chat is read-only: confirmed, paid out, refunded or cancelled."""

    code = "chat_closed"
    message = "This job's chat is closed."


class InvalidChatInputError(AppError):
    """What the schema cannot check alone: a message with nothing left after cleaning, a bad
    cursor. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidMessageError(AppError):
    """A read marker on a message that is not in the job's chat."""

    status_code = 422
    code = "invalid_message"
    message = "The message is not in this chat."
