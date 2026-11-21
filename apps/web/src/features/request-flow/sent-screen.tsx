"use client";

import { fill, PRIMARY, TEXT_BUTTON } from "./fields";
import { Actions, type Heading, StepFrame } from "./step-parts";
import type { RequestFlowText, StoreLinks } from "./types";

/**
 * After the send: the request's number and who gets in touch, with no time promised (#86 spec
 * §1). A web request is a lead for the BDC: the visitor is invited to make their account in the
 * app, where the team helps them go on with it. The store links show only once they are set
 * (config.ts `storeLinks`); until then a link to the app's page. The number lives in the page
 * only.
 */
export function SentScreen({
  text,
  heading,
  code,
  storeLinks,
  appHref,
  homeHref,
}: {
  text: RequestFlowText;
  heading: Heading;
  /** Null when nothing was sent (the honeypot): no number is made up. */
  code: string | null;
  storeLinks: StoreLinks | null;
  appHref: string;
  homeHref: string;
}) {
  const words = text.sent;
  // The number is set apart in the sentence, wherever the language puts it.
  const [before = "", after = ""] = words.code.split("{{code}}");
  return (
    <StepFrame heading={heading} progress={null} title={words.title} support={null}>
      {code ? (
        <p className="text-lg text-navy-900">
          {before}
          <strong className="font-extrabold tracking-wide">{code}</strong>
          {after}
        </p>
      ) : null}
      <p className="text-base text-navy-900">{words.next}</p>
      <div className="flex flex-col gap-2 rounded-lg bg-gray-50 p-4">
        <p className="text-base text-navy-900">{words.invite}</p>
        <p className="flex flex-wrap gap-x-6 gap-y-2">
          {storeLinks ? (
            <>
              <a href={storeLinks.appStore} className={TEXT_BUTTON}>
                {words.appStore}
              </a>
              <a href={storeLinks.playStore} className={TEXT_BUTTON}>
                {words.playStore}
              </a>
            </>
          ) : (
            <a href={appHref} className={TEXT_BUTTON}>
              {words.seeApp}
            </a>
          )}
        </p>
      </div>
      <Actions>
        <a href={homeHref} className={PRIMARY}>
          {words.home}
        </a>
      </Actions>
    </StepFrame>
  );
}

/**
 * A send refused because the ZIP is no longer served: no request was made, and the API put the
 * contact on the ZIP's waitlist (`409 out_of_area`).
 */
export function WaitlistedScreen({
  text,
  heading,
  zip,
  homeHref,
}: {
  text: RequestFlowText;
  heading: Heading;
  zip: string;
  homeHref: string;
}) {
  const words = text.waitlist;
  return (
    <StepFrame
      heading={heading}
      progress={null}
      title={words.joinedTitle}
      support={fill(words.outOfArea, { zip })}
    >
      <Actions>
        <a href={homeHref} className={PRIMARY}>
          {words.home}
        </a>
      </Actions>
    </StepFrame>
  );
}
