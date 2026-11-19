import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { TFunction } from "i18next";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { ApiError, apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";

import { LocalTime } from "../../local-time";
import { isUuid } from "../../support/tickets";
import { decidePro, reviewDocument } from "../actions";
import { DecisionControl, type DecisionControlText } from "../decision-control";
import {
  categoryName,
  DECISIONS,
  fileHref,
  formatDay,
  isExpired,
  PHOTO_FILE,
  type Pro,
  type ProDocument,
  PROS_PATH,
  REASON_MAX_LENGTH,
} from "../pros";
import { StatusBadge } from "../status-badge";

const FILE_LINK =
  "inline-flex items-center gap-1 self-start rounded-pill text-sm font-semibold text-navy-900 underline outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";

/** The pro, or why there is none to show. */
async function loadPro(auth: RequestInit, proId: string): Promise<Pro | "not_found" | "error"> {
  try {
    return await apiGet("/v1/admin/pros/{pro_id}", { ...auth, params: { pro_id: proId } });
  } catch (failure) {
    return failure instanceof ApiError && failure.status === 404 ? "not_found" : "error";
  }
}

function controlText(t: TFunction): Omit<DecisionControlText, "label" | "approve" | "reject"> {
  return {
    approveQuestion: t("admin.pros.detail.decision.approveQuestion"),
    confirmApprove: t("admin.pros.detail.decision.confirmApprove"),
    confirmReject: t("admin.pros.detail.decision.confirmReject"),
    cancel: t("admin.pros.detail.decision.cancel"),
    reasonLabel: t("admin.pros.detail.decision.reasonLabel"),
    reasonHint: t("admin.pros.detail.decision.reasonHint", { max: REASON_MAX_LENGTH }),
    saving: t("admin.pros.detail.decision.saving"),
    saved: t("admin.pros.detail.decision.saved"),
    decided: {
      approved: t("admin.pros.detail.decision.decided.approved"),
      rejected: t("admin.pros.detail.decision.decided.rejected"),
    },
    errors: {
      reason_required: t("admin.pros.detail.errors.reason_required", { max: REASON_MAX_LENGTH }),
      not_found: t("admin.pros.detail.errors.not_found"),
      already_reviewed: t("admin.pros.detail.errors.already_reviewed"),
      not_approvable: t("admin.pros.detail.errors.not_approvable"),
      forbidden: t("admin.pros.detail.errors.forbidden"),
      unavailable: t("admin.pros.detail.errors.unavailable"),
    },
  };
}

/**
 * One document: its type, status and dates, a link that opens the file in a new tab, and the
 * review buttons while it is pending. The link is a short-lived URL the API signed for this
 * page view: it opens without a referrer, and neither the page nor the API answer is cached.
 */
/** The pro's name, the heading that takes the focus after a decision on the pro (#463). */
const PRO_HEADING = "pro-name";

/** A current document's heading: it takes the focus after a decision on the document (#463). */
function documentHeadingId(documentId: string): string {
  return `document-${documentId}`;
}

function DocumentRow({
  pro,
  document,
  now,
  locale,
  t,
  reviewable,
}: {
  pro: Pro;
  document: ProDocument;
  now: Date;
  locale: string;
  t: TFunction;
  /** A current document (its decision control and focusable heading); earlier ones are not. */
  reviewable: boolean;
}) {
  const type = t(`admin.pros.documentType.${document.doc_type}`);
  return (
    <li className="flex flex-col gap-3 rounded-md border border-gray-500/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {reviewable ? (
          <h3
            id={documentHeadingId(document.id)}
            tabIndex={-1}
            className="rounded-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-green-700"
          >
            {type}
          </h3>
        ) : (
          <span className="font-semibold">{type}</span>
        )}
        <StatusBadge status={document.status}>
          {t(`admin.pros.documentStatus.${document.status}`)}
        </StatusBadge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
        <dt className="text-gray-500">{t("admin.pros.detail.submitted")}</dt>
        <dd>
          <LocalTime iso={document.created_at} locale={locale} />
        </dd>
        <dt className="text-gray-500">{t("admin.pros.detail.expires")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {document.expires_on
            ? formatDay(document.expires_on, locale)
            : t("admin.pros.detail.noExpiry")}
          {isExpired(document.expires_on, now) ? (
            <Badge variant="warning">{t("admin.pros.detail.expired")}</Badge>
          ) : null}
        </dd>
        {document.reviewed_at ? (
          <>
            <dt className="text-gray-500">{t("admin.pros.detail.reviewed")}</dt>
            <dd>
              <LocalTime iso={document.reviewed_at} locale={locale} />
            </dd>
          </>
        ) : null}
        {document.rejection_reason ? (
          <>
            <dt className="text-gray-500">{t("admin.pros.detail.reason")}</dt>
            <dd className="break-words whitespace-pre-wrap">{document.rejection_reason}</dd>
          </>
        ) : null}
      </dl>
      <a
        href={fileHref(pro.id, document.id)}
        target="_blank"
        rel="noopener noreferrer"
        className={FILE_LINK}
      >
        {t("admin.pros.detail.viewFile", { type })}
        <ExternalLink aria-hidden className="size-4" />
      </a>
      {/* Mounted once decided too: it keeps announcing the decision and hands the focus to the
          document's heading (#463). */}
      {reviewable ? (
        <DecisionControl
          action={reviewDocument.bind(null, pro.id, document.id)}
          offered={document.status === "pending" ? DECISIONS : []}
          focusAfter={documentHeadingId(document.id)}
          text={{
            ...controlText(t),
            label: t("admin.pros.detail.reviewLabel", { type }),
            approve: t("admin.pros.detail.approveDocument"),
            reject: t("admin.pros.detail.rejectDocument"),
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * One pro for review (D7.4, #41): the profile with the legal name, the documents with a preview link each and
 * their approve and reject buttons, then the decision on the pro, with what an approval still
 * needs. Reading this page is recorded by the API (it shows ID documents). An id that is not a
 * UUID never reaches the API.
 */
export default async function ProPage({ params }: { params: Promise<{ proId: string }> }) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const { proId } = await params;
  const pro = isUuid(proId) ? await loadPro(await staffAuth(), proId) : "not_found";
  // A pro that does not exist answers 404, with its own heading (not-found.tsx, #494).
  if (pro === "not_found") notFound();
  const now = new Date();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link
        href={PROS_PATH}
        className="inline-flex items-center gap-2 self-start rounded-pill text-sm font-semibold text-navy-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t("admin.pros.detail.back")}
      </Link>
      {pro === "error" ? (
        <Card role="alert">
          <p className="font-semibold text-danger">{t("admin.pros.detail.loadError")}</p>
        </Card>
      ) : (
        <>
          <Card className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1
                id={PRO_HEADING}
                tabIndex={-1}
                className="rounded-sm text-2xl font-bold break-words outline-none focus-visible:ring-2 focus-visible:ring-green-700"
              >
                {pro.legal_name ?? pro.name ?? t("admin.pros.noName")}
              </h1>
              <StatusBadge status={pro.verification_status}>
                {t(`admin.pros.status.${pro.verification_status}`)}
              </StatusBadge>
            </div>
            {/* The name as on the account: staff match it to the name on the ID document. */}
            <p className="-mt-4 text-sm text-gray-500">
              {pro.legal_name
                ? t("admin.pros.detail.legalNameHint")
                : t("admin.pros.detail.legalNameMissing")}
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
              <dt className="text-gray-500">{t("admin.pros.detail.payouts")}</dt>
              <dd>
                {pro.payouts_enabled
                  ? t("admin.pros.detail.payoutsEnabled")
                  : t("admin.pros.detail.payoutsMissing")}
              </dd>
              <dt className="text-gray-500">{t("admin.pros.detail.experience")}</dt>
              <dd>{pro.years_of_experience ?? t("admin.pros.detail.notGiven")}</dd>
              <dt className="text-gray-500">{t("admin.pros.detail.categories")}</dt>
              <dd className="break-words">
                {pro.categories.length > 0
                  ? pro.categories.map((category) => categoryName(category, locale)).join(", ")
                  : t("admin.pros.noCategories")}
              </dd>
              <dt className="text-gray-500">{t("admin.pros.detail.areas")}</dt>
              <dd className="flex flex-wrap gap-1">
                {pro.service_areas.length > 0
                  ? pro.service_areas.map((area) => (
                      <Badge key={area.id} variant="muted">
                        {area.zip_code} {area.city}
                      </Badge>
                    ))
                  : t("admin.pros.detail.noAreas")}
              </dd>
              <dt className="text-gray-500">{t("admin.pros.detail.joined")}</dt>
              <dd>
                <LocalTime iso={pro.created_at} locale={locale} />
              </dd>
              {pro.reviewed_at ? (
                <>
                  <dt className="text-gray-500">{t("admin.pros.detail.decided")}</dt>
                  <dd>
                    <LocalTime iso={pro.reviewed_at} locale={locale} />
                  </dd>
                </>
              ) : null}
              {pro.rejection_reason ? (
                <>
                  <dt className="text-gray-500">{t("admin.pros.detail.reason")}</dt>
                  <dd className="break-words whitespace-pre-wrap">{pro.rejection_reason}</dd>
                </>
              ) : null}
            </dl>
            {pro.bio ? (
              <section aria-labelledby="pro-bio" className="flex flex-col gap-2">
                <h2 id="pro-bio" className="text-sm font-semibold text-gray-500">
                  {t("admin.pros.detail.bio")}
                </h2>
                <p className="rounded-md bg-gray-50 p-4 break-words whitespace-pre-wrap">
                  {pro.bio}
                </p>
              </section>
            ) : null}
            {pro.photo ? (
              <a
                href={fileHref(pro.id, PHOTO_FILE)}
                target="_blank"
                rel="noopener noreferrer"
                className={FILE_LINK}
              >
                {t("admin.pros.detail.viewPhoto")}
                <ExternalLink aria-hidden className="size-4" />
              </a>
            ) : null}
          </Card>
          <Card className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>{t("admin.pros.detail.documents")}</CardTitle>
              <CardDescription>{t("admin.pros.detail.filesNote")}</CardDescription>
            </div>
            <p className="text-sm">
              <span className="text-gray-500">{t("admin.pros.detail.required")}: </span>
              {pro.required_types.map((type) => t(`admin.pros.documentType.${type}`)).join(", ")}
            </p>
            {pro.missing_types.length > 0 ? (
              <p className="text-sm font-semibold">
                {t("admin.pros.detail.notSubmitted")}:{" "}
                {pro.missing_types.map((type) => t(`admin.pros.documentType.${type}`)).join(", ")}
              </p>
            ) : null}
            {pro.documents.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {pro.documents.map((document) => (
                  <DocumentRow
                    key={document.id}
                    pro={pro}
                    document={document}
                    now={now}
                    locale={locale}
                    t={t}
                    reviewable
                  />
                ))}
              </ul>
            ) : (
              <CardDescription>{t("admin.pros.noDocuments")}</CardDescription>
            )}
            {pro.history.length > 0 ? (
              <section aria-labelledby="pro-history" className="flex flex-col gap-3">
                <h3 id="pro-history" className="text-sm font-semibold text-gray-500">
                  {t("admin.pros.detail.history")}
                </h3>
                <ul className="flex flex-col gap-3">
                  {pro.history.map((document) => (
                    <DocumentRow
                      key={document.id}
                      pro={pro}
                      document={document}
                      now={now}
                      locale={locale}
                      t={t}
                      reviewable={false}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </Card>
          <Card className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>{t("admin.pros.detail.decision.title")}</CardTitle>
              <CardDescription>{t("admin.pros.detail.decision.hint")}</CardDescription>
            </div>
            {pro.approval_blockers.length > 0 ? (
              <section aria-labelledby="pro-blockers" className="flex flex-col gap-2">
                <h3 id="pro-blockers" className="text-sm font-semibold">
                  {t("admin.pros.detail.blockers.title")}
                </h3>
                <ul className="list-disc pl-5 text-sm">
                  {pro.approval_blockers.map((blocker) => (
                    <li key={`${blocker.kind}:${blocker.doc_type ?? ""}`}>
                      {t(`admin.pros.detail.blockers.${blocker.kind}`, {
                        type: blocker.doc_type
                          ? t(`admin.pros.documentType.${blocker.doc_type}`)
                          : "",
                      })}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <DecisionControl
              action={decidePro.bind(null, pro.id)}
              offered={DECISIONS.filter((decision) => decision !== pro.verification_status)}
              focusAfter={PRO_HEADING}
              confirmApproval
              text={{
                ...controlText(t),
                label: t("admin.pros.detail.decision.title"),
                approve: t("admin.pros.detail.decision.approve"),
                reject: t("admin.pros.detail.decision.reject"),
              }}
            />
          </Card>
        </>
      )}
    </div>
  );
}
