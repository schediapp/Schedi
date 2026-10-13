import { handleRequest, type SchediContext, type SchediEnv } from "./handler";

export default {
  async fetch(request: Request, env: SchediEnv, ctx: SchediContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
