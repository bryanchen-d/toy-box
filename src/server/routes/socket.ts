import { defineWebSocketHandler } from "nitro";
import { socketHooks } from "../socket";

export default defineWebSocketHandler(socketHooks);
