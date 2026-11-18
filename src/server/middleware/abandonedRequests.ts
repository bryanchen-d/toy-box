import { defineMiddleware } from "h3";
import { noteAbandonedRequest } from "../console";

export default defineMiddleware((event) => {
  noteAbandonedRequest(event.req.signal);
});
