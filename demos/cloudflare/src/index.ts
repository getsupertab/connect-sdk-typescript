import { SupertabConnect, Env } from "@getsupertab/supertab-connect-sdk";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return SupertabConnect.cloudflareHandleRequests(request, env, ctx);
	},
};
