import { MissingRecord } from "../../missing-record";
import { PROS_PATH } from "../pros";

/** A pro that does not exist, or an id that is not one (#494): a 404 with its own heading. */
export default function ProNotFound() {
  return (
    <MissingRecord
      href={PROS_PATH}
      keys={{ back: "admin.pros.detail.back", message: "admin.pros.detail.notFound" }}
    />
  );
}
