import { MissingRecord } from "../../missing-record";
import { QUEUE_PATH } from "../../queue/queue";

/** A request that does not exist, or an id that is not one (#494): a 404 with its own heading. */
export default function RequestNotFound() {
  return (
    <MissingRecord
      href={QUEUE_PATH}
      keys={{ back: "admin.requests.back", message: "admin.requests.notFound" }}
    />
  );
}
