"""Versioned public API. Include each domain router (app/modules/<domain>/router.py) here."""

from fastapi import APIRouter

from app.errors import ErrorResponse
from app.modules.addresses.router import router as addresses_router
from app.modules.auth.router import router as auth_router
from app.modules.cancellations.router import customer_router as cancel_customer_router
from app.modules.cancellations.router import pro_router as cancel_pro_router
from app.modules.categories.router import router as categories_router
from app.modules.chat.router import flags_router as chat_flags_router
from app.modules.chat.router import router as chat_router
from app.modules.chat.router import staff_router as staff_chat_router
from app.modules.devices.router import router as devices_router
from app.modules.dispatch.router import router as opportunities_router
from app.modules.disputes.router import customer_router as dispute_customer_router
from app.modules.disputes.router import pro_router as dispute_pro_router
from app.modules.disputes.router import staff_router as staff_disputes_router
from app.modules.earnings.router import router as earnings_router
from app.modules.geo.router import router as geo_router
from app.modules.interest.router import router as interest_router
from app.modules.jobs.router import customer_router as customer_jobs_router
from app.modules.jobs.router import location_router as job_location_router
from app.modules.jobs.router import route_router as job_route_router
from app.modules.jobs.router import router as jobs_router
from app.modules.metrics.router import staff_router as staff_metrics_router
from app.modules.notifications.router import router as notification_preferences_router
from app.modules.ops.router import followups_router as staff_followups_router
from app.modules.ops.router import staff_members_router
from app.modules.ops.router import staff_router as staff_ops_router
from app.modules.payment_methods.router import router as payment_methods_router
from app.modules.payments.router import router as payments_router
from app.modules.payments.router import staff_router as staff_transfers_router
from app.modules.payouts.router import pages_router as payout_pages_router
from app.modules.payouts.router import router as payouts_router
from app.modules.pros.router import router as pros_router
from app.modules.pros.router import staff_router as staff_pros_router
from app.modules.quotes.router import customer_router as customer_quotes_router
from app.modules.quotes.router import router as quotes_router
from app.modules.receipts.router import router as receipts_router
from app.modules.requests.router import router as requests_router
from app.modules.reviews.router import public_pro_router
from app.modules.reviews.router import rating_router as my_rating_router
from app.modules.reviews.router import router as reviews_router
from app.modules.service_areas.router import router as service_areas_router
from app.modules.support.router import router as support_router
from app.modules.support.router import staff_router as staff_support_router
from app.modules.tips.router import router as tips_router
from app.modules.uploads.router import router as uploads_router
from app.modules.waitlist.router import router as waitlist_router
from app.modules.webhooks.router import router as webhooks_router

# Documents the real 422 body (the error contract) instead of FastAPI's default schema.
v1_router = APIRouter(
    prefix="/v1",
    responses={422: {"model": ErrorResponse, "description": "The request is invalid."}},
)
v1_router.include_router(auth_router)
v1_router.include_router(uploads_router)
v1_router.include_router(requests_router)
v1_router.include_router(categories_router)
v1_router.include_router(service_areas_router)
v1_router.include_router(geo_router)
v1_router.include_router(pros_router)
v1_router.include_router(staff_pros_router)
v1_router.include_router(payouts_router)
v1_router.include_router(payout_pages_router)
v1_router.include_router(opportunities_router)
v1_router.include_router(quotes_router)
v1_router.include_router(customer_quotes_router)
v1_router.include_router(payments_router)
v1_router.include_router(staff_transfers_router)
v1_router.include_router(payment_methods_router)
v1_router.include_router(customer_jobs_router)
v1_router.include_router(jobs_router)
v1_router.include_router(job_location_router)
v1_router.include_router(job_route_router)
v1_router.include_router(chat_router)
v1_router.include_router(staff_chat_router)
v1_router.include_router(chat_flags_router)
v1_router.include_router(devices_router)
v1_router.include_router(waitlist_router)
v1_router.include_router(interest_router)
v1_router.include_router(webhooks_router)
v1_router.include_router(addresses_router)
v1_router.include_router(notification_preferences_router)
v1_router.include_router(support_router)
v1_router.include_router(staff_support_router)
v1_router.include_router(staff_ops_router)
v1_router.include_router(staff_followups_router)
v1_router.include_router(staff_members_router)
v1_router.include_router(reviews_router)
v1_router.include_router(dispute_customer_router)
v1_router.include_router(cancel_customer_router)
v1_router.include_router(cancel_pro_router)
v1_router.include_router(dispute_pro_router)
v1_router.include_router(earnings_router)
v1_router.include_router(staff_disputes_router)
v1_router.include_router(staff_metrics_router)
v1_router.include_router(my_rating_router)
v1_router.include_router(tips_router)
v1_router.include_router(receipts_router)
# After pros_router: /v1/pros/me is matched before /v1/pros/{pro_id} (#78).
v1_router.include_router(public_pro_router)
