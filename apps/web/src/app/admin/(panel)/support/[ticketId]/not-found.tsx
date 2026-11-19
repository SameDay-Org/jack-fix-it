import { MissingRecord } from "../../missing-record";
import { SUPPORT_PATH } from "../tickets";

/** A ticket that does not exist, or an id that is not one (#494): a 404 with its own heading. */
export default function TicketNotFound() {
  return (
    <MissingRecord
      href={SUPPORT_PATH}
      keys={{ back: "admin.support.detail.back", message: "admin.support.detail.notFound" }}
    />
  );
}
