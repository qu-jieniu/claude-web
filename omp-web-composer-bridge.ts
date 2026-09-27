import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const TYPE = "omp-web-composer";
const LIMIT = 1024 * 1024;
const ACCEPT_TIMEOUT = 15000;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
type Reply = { accepted?: true; requestId?: string; error?: string; ambiguous?: boolean };
type Submission = { fingerprint: string; reply?: Reply; finish: (reply: Reply) => void; promise: Promise<Reply> };

/** Opt-in, per-process IPC. Never writes to the editor or synthesizes terminal input. */
export default function composerBridge(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let server: net.Server | undefined;
	let metadataPath: string | undefined;
	let endpoint: string | undefined;
	let pending = 0;
	let transitioning = false;
	const requests = new Map<string, Submission>();
	const token = randomBytes(32).toString("hex");
	const instance = randomBytes(12).toString("hex");
	const paneId = process.env.TMUX_PANE;
	const tmuxSocket = process.env.TMUX?.split(",").slice(0, -2).join(",") || process.env.OMP_TMUX_SOCKET;

	function pane() {
		if (!paneId || !tmuxSocket) throw new Error("OMP is not running in a tmux pane.");
		const format = "#{pid}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_in_mode}\t#{pane_active}";
		const output = execFileSync("tmux", ["-S", tmuxSocket, "display-message", "-p", "-t", paneId, format], {
			encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "pipe"],
		}).trim().split("\t");
		if (output.length !== 6 || output[2] !== paneId) throw new Error("The OMP pane no longer exists.");
		return { serverPid: output[0], windowId: `tmux-${output[1].slice(1)}`, paneId: output[2], dead: output[3], mode: output[4], active: output[5] };
	}

	function snapshot() {
		const current = pane();
		let reason: string | undefined;
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) reason = "OMP interactive session is not ready.";
		else if (current.dead !== "0") reason = "The selected pane has exited.";
		else if (current.mode !== "0") reason = "Exit tmux copy mode before sending.";
		else if (current.active !== "1") reason = "The OMP pane is no longer active.";
		else if (transitioning) reason = "OMP has not confirmed its session transition. Complete a session switch before composing.";
		else {
			// A suspended OMP behind a foreground shell must never receive a prompt.
			const stat = fs.readFileSync("/proc/self/stat", "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (!process.stdin.isTTY || Number(fields[2]) <= 0 || fields[2] !== fields[5]) reason = "OMP is not the foreground program in this pane.";
			else if (!ctx.isIdle() || ctx.hasPendingMessages() || pending) reason = "Wait for OMP to finish its current turn before sending.";
			else if (ctx.ui.getEditorText().length) reason = "The terminal editor has a draft; submit or clear it there first.";
		}
		return { available: !reason, ...(reason ? { reason } : {}), ...current, sessionId: ctx?.sessionManager.getSessionId(), pid: process.pid };
	}

	function accepted(id: string) {
		const record = requests.get(id);
		if (record) record.finish({ accepted: true, requestId: id });
	}

	async function dispatch(request: Record<string, unknown>): Promise<object> {
		const presented = typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
		const expected = Buffer.from(token);
		if (request.v !== 1 || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { error: "Bridge authentication failed." };
		if (request.op === "snapshot") return snapshot();
		if (request.op !== "send") return { error: "Unsupported bridge operation." };
		const { requestId, text, sessionId, windowId, serverPid } = request;
		if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) || typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 262144 || text.includes("\0")) return { error: "Invalid composer request." };
		const fingerprint = createHash("sha256").update(JSON.stringify([windowId, request.paneId, sessionId, text])).digest("hex");
		const existing = requests.get(requestId);
		if (existing) return existing.fingerprint === fingerprint ? existing.promise : { error: "This request ID was already used for another prompt." };
		const current = snapshot();
		if (current.sessionId !== sessionId || current.windowId !== windowId || current.paneId !== request.paneId || current.serverPid !== serverPid) return { error: "The target session or active pane changed. Check the target again." };
		if (!current.available) return { error: current.reason };
		if (requests.size >= 10000) return { error: "This bridge has reached its request limit. Start a new OMP process before sending more." };
		let resolve!: (reply: Reply) => void;
		const promise = new Promise<Reply>(done => { resolve = done; });
		let timer: NodeJS.Timeout | undefined;
		const record: Submission = {
			fingerprint, promise,
			finish(reply) {
				if (record.reply) return;
				record.reply = reply;
				clearTimeout(timer);
				pending--;
				resolve(reply);
			},
		};
		requests.set(requestId, record);
		pending++;
		timer = setTimeout(() => record.finish({ error: "OMP did not confirm submission. Check the conversation before sending again.", ambiguous: true }), ACCEPT_TIMEOUT);
		try {
			// The public extension send API returns void. A matching message_end is
			// the acknowledgement; merely calling the API is not acceptance.
			pi.sendMessage({ customType: TYPE, content: text, display: true, attribution: "user", details: { requestId } }, { triggerTurn: true });
		} catch {
			record.finish({ error: "OMP could not confirm submission. Check the conversation before sending again.", ambiguous: true });
		}
		return promise;
	}

	async function start(context: ExtensionContext) {
		ctx = context;
		if (server || context.mode !== "tui" || !context.hasUI || context.agent.kind !== "main" || !paneId || !tmuxSocket) return;
		const dir = process.env.OMP_COMPOSER_DIR || path.join(os.homedir(), ".omp", "run", "web-composer");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const dirStat = fs.lstatSync(dir);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o077)) throw new Error("Composer bridge requires an owner-private runtime directory.");
		endpoint = path.join(dir, `${instance}.sock`);
		if (Buffer.byteLength(endpoint) >= 104) throw new Error("OMP_COMPOSER_DIR is too long for a Unix socket; choose a shorter private path.");
		metadataPath = path.join(dir, `${instance}.json`);
		server = net.createServer(socket => {
			let buffer = Buffer.alloc(0);
			let handled = false;
			socket.setTimeout(20000, () => socket.destroy());
			socket.on("error", () => socket.destroy());
			socket.on("data", chunk => {
				if (handled) return;
				if (buffer.length + chunk.length > LIMIT) { socket.destroy(); return; }
				buffer = Buffer.concat([buffer, chunk]);
				const newline = buffer.indexOf(10);
				if (newline < 0) return;
				handled = true;
				void (async () => {
					let reply: object;
					try {
						const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
						if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid request");
						reply = await dispatch(request);
					} catch { reply = { error: "OMP bridge is unavailable; check the selected pane." }; }
					socket.end(`${JSON.stringify(reply)}\n`);
				})();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(endpoint!, resolve);
		});
		fs.chmodSync(endpoint, 0o600);
		fs.writeFileSync(metadataPath, JSON.stringify({ v: 1, token, endpoint, paneId, serverPid: pane().serverPid }), { mode: 0o600, flag: "wx" });
		server.unref();
	}

	pi.on("session_start", async (_event, context) => { await start(context); });
	const afterTransition = (_event: unknown, context: ExtensionContext) => {
		ctx = context;
		transitioning = false;
	};
	const beforeTransition = () => {
		if (pending) return { cancel: true };
		// The public context has no transition-state getter. Fail closed until
		// OMP emits completion, including when another extension cancels a switch.
		transitioning = true;
	};
	pi.on("session_switch", afterTransition);
	pi.on("session_branch", afterTransition);
	pi.on("session_tree", afterTransition);
	// Do not let a pre-dispatch await migrate an in-flight prompt to another session.
	pi.on("session_before_switch", beforeTransition);
	pi.on("session_before_branch", beforeTransition);
	pi.on("session_before_tree", beforeTransition);
	pi.on("session_before_compact", () => pending ? { cancel: true } : undefined);
	pi.on("message_end", event => {
		const message = event.message;
		if (message.role === "custom" && message.customType === TYPE && message.details && typeof message.details === "object" && "requestId" in message.details && typeof message.details.requestId === "string") accepted(message.details.requestId);
	});
	pi.on("session_shutdown", () => {
		ctx = undefined;
		for (const record of requests.values()) record.finish({ error: "OMP stopped before confirming submission. Check the conversation before sending again.", ambiguous: true });
		server?.close();
		for (const file of [metadataPath, endpoint]) if (file) { try { fs.unlinkSync(file); } catch {} }
	});
}
