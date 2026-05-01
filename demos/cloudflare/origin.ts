/**
 * Publisher-website origin for the Cloudflare demo.
 *
 * Stands in for a real origin server during local validation. Serves HTML
 * pages so a browser visit to the Worker (which forwards pass-through
 * traffic here) feels like visiting a real site.
 *
 * Run standalone:
 *   npx tsx demos/cloudflare/origin.ts
 *
 * Or import `startOrigin()` from a harness — that's what
 * `tests/e2e/cloudflare-e2e.ts` does (owns lifecycle in-process).
 *
 * Default port 8789. The Worker forwards ALLOW/OBSERVE pass-through here
 * via `originUrl: env.ORIGIN_URL` in `cloudflareHandleRequests`.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";

export interface OriginHandle {
	port: number;
	close(): Promise<void>;
}

const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Example Publisher — Local Demo</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; }
  header { border-bottom: 1px solid #8884; padding-bottom: 1rem; margin-bottom: 2rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  .meta { color: #888; font-size: .9rem; }
  ul { padding-left: 1.2rem; }
  code { background: #8881; padding: .1rem .35rem; border-radius: 3px; }
  footer { margin-top: 3rem; color: #888; font-size: .85rem; }
</style>
</head>
<body>
<header>
  <h1>Example Publisher</h1>
  <div class="meta">Local origin · sits behind the Supertab Connect Worker</div>
</header>

<p>This page is served by the local origin on port 8789. The Cloudflare
Worker on <code>:8788</code> applies CAP enforcement (bot detection +
license verification) and forwards pass-through traffic here.</p>

<p>Try:</p>
<ul>
  <li><a href="/articles/welcome">/articles/welcome</a> — pass-through GET</li>
  <li><a href="/license.xml">/license.xml</a> — RSL license, proxied to local backend</li>
  <li><code>curl -H 'User-Agent: GPTBot/1.0' http://127.0.0.1:8788/articles/welcome</code> — bot UA, OBSERVE</li>
</ul>

<footer>Local validation only. Not for deployment.</footer>
</body>
</html>
`;

const ARTICLE_HTML = (title: string, slug: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${title} — Example Publisher</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem}a{color:inherit}</style>
</head><body>
<p><a href="/">&larr; Home</a></p>
<h1>${title}</h1>
<p>Article body for <code>${slug}</code>. Served from the local origin
at port 8789. If you reached this through <code>http://127.0.0.1:8788${slug}</code>
the Worker classified the request as ALLOW/OBSERVE and forwarded it here.</p>
</body></html>
`;

function handle(req: IncomingMessage, res: ServerResponse): void {
	const url = req.url ?? "/";
	res.setHeader("X-Origin", "demo-publisher");

	if (url === "/" || url === "/index.html") {
		res.statusCode = 200;
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.end(HOME_HTML);
		return;
	}

	if (url.startsWith("/articles/")) {
		const slug = url.split("?")[0];
		const title = slug.replace("/articles/", "").replace(/[-_]/g, " ");
		res.statusCode = 200;
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.end(ARTICLE_HTML(title || "Untitled", slug));
		return;
	}

	// Default text response — covers harness paths like /phase2-e2e-<id>/...
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.end(`origin OK — ${req.method} ${url}\n`);
}

export function startOrigin(port = 8789, host = "127.0.0.1"): Promise<OriginHandle> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer(handle);
		server.once("error", reject);
		server.listen(port, host, () => {
			resolve({
				port,
				close: () =>
					new Promise<void>((r, j) => {
						server.close((err) => (err ? j(err) : r()));
					}),
			});
		});
	});
}

const isMain =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith("/demos/cloudflare/origin.ts");

if (isMain) {
	const port = Number(process.env.PORT ?? 8789);
	const host = process.env.HOST ?? "127.0.0.1";
	startOrigin(port, host)
		.then((h) => {
			console.log(`publisher origin listening on http://${host}:${h.port}`);
			console.log("Ctrl-C to stop.");
		})
		.catch((err) => {
			console.error("failed to start origin:", err);
			process.exit(1);
		});
}
