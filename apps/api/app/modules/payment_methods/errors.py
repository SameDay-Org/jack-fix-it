from app.errors import AppError


class PaymentMethodNotFoundError(AppError):
    """No saved card of the caller with this id (#253). One body for an id Stripe does not
    have, a card of another customer, a card detached already and a PaymentMethod that is not a
    card: the answer never tells whether the id exists."""

    status_code = 404
    code = "payment_method_not_found"
    message = "Payment method not found."
