#!/usr/bin/env node
// 发布链路的四个判据步骤，与 .github/workflows/publish.yml 的四个 job 一一对应：
//
//   preflight      → verify job 前半：tag 与包版本对账、tag 提交必须在 origin/main 上
//   verify         → verify job 后半：打包一次，算出每个 tarball 的 sha256/sha512，写清单
//   publish-check  → publish job 前半：工具链下限 + 与 registry 逐字节对账
//   registry-check → publish job 后半：registry 侧完整性、provenance、npm audit signatures
//
// 判据与 agentfacade-extensions 的同名脚本一致：
//   - 只打一次包，发布的就是校验过的那份字节，publish 阶段绝不重新构建；
//   - 「版本已存在且字节相同」→ 跳过；「版本已存在但字节不同」→ 直接失败，
//     避免用同版本号覆盖别人已经拿到的内容；
//   - 不使用任何长期凭据，认证只走 OIDC（trusted publishing）。
//
//   node scripts/release.mjs preflight --tag v0.1.2
//   node scripts/release.mjs verify --tag v0.1.2
//
// 测试见 scripts/release.test.mjs（本地起假 registry，覆盖跳过/失败两支）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
// npm trusted publishing 要求 npm >= 11.5.1；Node 22.14.0 是随该 npm 一起发布的下限。
const MIN_NODE = "22.14.0";
const MIN_NPM = "11.5.1";

// 面向使用者的失败：只打印一行，不打栈。
export class ReleaseError extends Error {}

function fail(message) {
	throw new ReleaseError(message);
}

function parseSemver(text) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

// 返回 -1 / 0 / 1。预发布版本小于同版本号的正式版。
export function compareVersions(a, b) {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) fail(`无法比较版本：${a} vs ${b}`);
	for (const key of ["major", "minor", "patch"]) {
		if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
	}
	if (pa.pre === pb.pre) return 0;
	if (pa.pre === null) return 1;
	if (pb.pre === null) return -1;
	return pa.pre < pb.pre ? -1 : 1;
}

// 工具链下限。允许注入版本号，测试才能在不换 Node 的前提下验证判据。
export function assertToolchain({ node = process.versions.node, npm } = {}) {
	if (compareVersions(node, MIN_NODE) < 0) {
		fail(`Node ${node} 低于下限 ${MIN_NODE}：trusted publishing 的 OIDC 与 provenance 需要它`);
	}
	if (npm === undefined) fail("assertToolchain 需要 npm 版本");
	if (compareVersions(npm, MIN_NPM) < 0) {
		fail(`npm ${npm} 低于下限 ${MIN_NPM}：trusted publishing 需要它`);
	}
	return { node, npm };
}

// packages/*/package.json 里 private !== true 的就是发布目标。
export function publishTargets(root = ROOT) {
	const packagesDir = path.join(root, "packages");
	const targets = [];
	for (const entry of readdirSync(packagesDir).sort()) {
		const manifestPath = path.join(packagesDir, entry, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.private === true) continue;
		targets.push({
			name: manifest.name,
			version: manifest.version,
			dir: path.join(packagesDir, entry),
			relative: path.join("packages", entry),
		});
	}
	if (targets.length === 0) fail("packages/ 下没有可发布的包");
	return targets;
}

// tag 必须形如 v<版本>，且所有发布目标同版本、与 tag 一致。
export function resolveTag(tag, targets) {
	const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
	if (!m) fail(`tag 必须是 v<版本> 形式（例如 v0.1.2），收到 ${JSON.stringify(tag)}`);
	const versions = [...new Set(targets.map((t) => t.version))];
	if (versions.length !== 1) {
		fail(`各包版本不一致，无法用单个 tag 发布：${targets.map((t) => `${t.name}@${t.version}`).join(", ")}`);
	}
	if (versions[0] !== m[1]) fail(`tag ${tag} 与包版本 ${versions[0]} 不一致：请先改 package.json 版本再打 tag`);
	return m[1];
}

// scoped 包在 tarball 文件名里会去掉 @ 并把 / 换成 -。
export function tarballPath(artifactDir, name, version) {
	return path.join(artifactDir, `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`);
}

export function fileDigests(file) {
	const bytes = readFileSync(file);
	return {
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		// registry 的 dist.integrity 就是 "sha512-" + base64，两边可直接比较。
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
}

function tarballManifest(file) {
	const raw = execFileSync("tar", ["xzOf", file, "package/package.json"], { encoding: "utf8" });
	const manifest = JSON.parse(raw);
	return { manifest, name: manifest.name, version: manifest.version, private: manifest.private === true };
}

function tarballEntries(file) {
	return execFileSync("tar", ["tzf", file], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.startsWith("package/"))
		.map((line) => line.slice("package/".length));
}

async function fetchMetadata(name, registry) {
	const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`;
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (res.status === 404) return null;
	if (!res.ok) fail(`读取 ${name} 的 registry 元数据失败：HTTP ${res.status}（${url}）`);
	return res.json();
}

// 「已发布同版本」时只认字节：相同即幂等跳过，不同即失败。
async function classifyAgainstRegistry({ name, version, integrity, registry = DEFAULT_REGISTRY }) {
	const meta = await fetchMetadata(name, registry);
	const published = meta?.versions?.[version];
	if (!published) return { state: "absent" };
	const publishedIntegrity = published.dist?.integrity;
	if (publishedIntegrity === integrity) return { state: "identical", publishedIntegrity };
	return { state: "conflict", publishedIntegrity, localIntegrity: integrity };
}

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setOutput(key, value) {
	const sink = process.env.GITHUB_OUTPUT;
	if (!sink) return;
	writeFileSync(sink, `${key}=${value}\n`, { flag: "a" });
}

function git(args, root = ROOT) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function assertOnMain(sha, root = ROOT) {
	let base;
	try {
		base = git(["rev-parse", "--verify", "origin/main"], root);
	} catch {
		fail("拿不到 origin/main：CI 里需 `git fetch origin main` 后再校验，本地可加 --no-ancestry");
	}
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, base], { cwd: root });
	} catch {
		fail(`提交 ${sha.slice(0, 12)} 不在 origin/main 上：只能从主分支打 tag 发布`);
	}
	return base;
}

// ---- 步骤 1：preflight -------------------------------------------------------
export async function preflight({ tag, root = ROOT, ancestry = true, sha } = {}) {
	const targets = publishTargets(root);
	const version = resolveTag(tag, targets);
	const commit = sha ?? git(["rev-parse", "HEAD"], root);
	if (ancestry) assertOnMain(commit, root);
	console.log(`preflight: tag ${tag} → 版本 ${version}，提交 ${commit.slice(0, 12)}`);
	for (const target of targets) console.log(`  · ${target.name}@${target.version} (${target.relative})`);
	setOutput("version", version);
	setOutput("targets", targets.map((t) => t.name).join(","));
	return { version, commit, targets };
}

// ---- 步骤 2：verify ----------------------------------------------------------
// 只打一次包；identity.json / manifest.json / SHA256SUMS 描述的就是这批字节。
export async function verify({ tag, artifactDir = path.join(ROOT, ".build"), root = ROOT, sha } = {}) {
	const targets = publishTargets(root);
	const version = resolveTag(tag, targets);
	const commit = sha ?? git(["rev-parse", "HEAD"], root);

	rmSync(artifactDir, { recursive: true, force: true });
	mkdirSync(artifactDir, { recursive: true });

	const packages = [];
	for (const target of targets) {
		// prepack 会在打包前把 README/LICENSE 从仓库根复制进来，所以必须在包目录里 pack。
		console.log(`verify: 打包 ${target.name}@${target.version}（${target.relative}）`);
		execFileSync("npm", ["pack", "--pack-destination", artifactDir, "--silent"], {
			cwd: target.dir,
			stdio: "inherit",
		});

		const file = tarballPath(artifactDir, target.name, target.version);
		if (!existsSync(file)) fail(`打包产物缺失：${path.basename(file)}`);
		// 包里那份 package.json 才是要发出去的身份，不能只信仓库里那份。
		const { manifest, name, version: insideVersion, private: isPrivate } = tarballManifest(file);
		if (name !== target.name) fail(`${path.basename(file)} 内的包名是 ${name}，期望 ${target.name}`);
		if (insideVersion !== target.version) fail(`${path.basename(file)} 内的版本是 ${insideVersion}，期望 ${target.version}`);
		if (isPrivate) fail(`${path.basename(file)} 内的 package.json 标记了 private，不能发布`);

		// pi 扩展的入口必须真的在包里，否则装上去是个空包。
		const entries = tarballEntries(file);
		const entryPoints = manifest.pi?.extensions ?? [];
		for (const entryPoint of entryPoints) {
			if (!entries.includes(entryPoint)) {
				fail(`${path.basename(file)} 里没有 pi.extensions 声明的入口 ${entryPoint}`);
			}
		}
		// prepack 复制失败时最典型的后果就是包里没有 README。
		if (!entries.includes("README.md")) fail(`${path.basename(file)} 里没有 README.md：prepack 没跑成？`);

		const digests = fileDigests(file);
		packages.push({ name: target.name, version: target.version, file: path.basename(file), ...digests });
		console.log(`  · ${target.name}@${target.version} ${path.basename(file)} ${digests.sha256.slice(0, 16)}…`);
	}

	const manifest = { tag, version, commit, node: process.versions.node, packages };
	writeJson(path.join(artifactDir, "manifest.json"), manifest);
	writeJson(path.join(artifactDir, "identity.json"), {
		tag,
		commit,
		packages: packages.map((p) => ({ name: p.name, version: p.version, file: p.file, sha256: p.sha256, integrity: p.integrity, size: p.size })),
	});
	writeFileSync(
		path.join(artifactDir, "SHA256SUMS"),
		`${packages.map((p) => `${p.sha256}  ${p.file}`).join("\n")}\n`,
	);
	setOutput("version", version);
	setOutput("tarballs", packages.map((p) => p.file).join(","));
	return manifest;
}

// ---- 步骤 3：publish-check ---------------------------------------------------
// 任何一个包「同版本不同字节」都整体失败：宁可停在这里，也不要覆盖已发布的内容。
export async function publishCheck({ tag, artifactDir = path.join(ROOT, ".build"), registry = DEFAULT_REGISTRY, root = ROOT, toolchain } = {}) {
	const targets = publishTargets(root);
	const version = resolveTag(tag, targets);
	const npmVersion = toolchain?.npm ?? execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
	const chain = assertToolchain({ node: toolchain?.node ?? process.versions.node, npm: npmVersion });
	console.log(`publish-check: node ${chain.node} / npm ${chain.npm} 满足下限（>= ${MIN_NODE} / >= ${MIN_NPM}）`);

	const decisions = [];
	const conflicts = [];
	for (const target of targets) {
		const file = tarballPath(artifactDir, target.name, target.version);
		if (!existsSync(file)) fail(`缺少 ${path.relative(root, file)}：publish 阶段不允许重新打包`);
		const { integrity } = fileDigests(file);
		const verdict = await classifyAgainstRegistry({ name: target.name, version, integrity, registry });
		if (verdict.state === "conflict") {
			conflicts.push(`${target.name}@${version}\n    本地 ${verdict.localIntegrity}\n    线上 ${verdict.publishedIntegrity}`);
			continue;
		}
		const publish = verdict.state === "absent";
		decisions.push({ name: target.name, file: path.basename(file), publish, state: verdict.state });
		console.log(`  · ${target.name}@${version} → ${publish ? "发布" : "跳过（同版本、同字节）"}`);
	}
	if (conflicts.length > 0) {
		fail(
			`${conflicts.length} 个包的版本已在 registry 上但字节不同，拒绝覆盖：\n  ${conflicts.join("\n  ")}\n` +
				"  处理方式：提升版本号后重新打 tag，不要复用一个已发布的版本。",
		);
	}

	// 全部跳过时也要让下游明确「没有要发的」，避免空跑一次 attest/release。
	setOutput("publish", decisions.some((d) => d.publish) ? "true" : "false");
	setOutput("publish-list", decisions.filter((d) => d.publish).map((d) => d.file).join(","));
	setOutput("tarballs", targets.map((t) => path.basename(tarballPath(artifactDir, t.name, t.version))).join(","));
	return { version, decisions };
}

// ---- 步骤 4：registry-check --------------------------------------------------
// 发布之后才有的证据：完整性、provenance 存在性、npm 侧签名。
export async function registryCheck({ tag, artifactDir = path.join(ROOT, ".build"), registry = DEFAULT_REGISTRY, root = ROOT, audit = true } = {}) {
	const targets = publishTargets(root);
	const version = resolveTag(tag, targets);
	const results = [];
	for (const target of targets) {
		const file = tarballPath(artifactDir, target.name, target.version);
		if (!existsSync(file)) fail(`缺少 ${target.name} 的 tarball，无法核对 registry`);
		const { integrity } = fileDigests(file);
		const meta = await fetchMetadata(target.name, registry);
		const published = meta?.versions?.[version];
		if (!published) fail(`${target.name}@${version} 不在 registry 上：发布没有生效`);
		if (published.dist?.integrity !== integrity) {
			fail(`${target.name}@${version} 的 registry 字节与本地不一致：\n    本地 ${integrity}\n    线上 ${published.dist?.integrity}`);
		}
		const provenance = published.dist?.attestations?.provenance;
		if (!provenance) fail(`${target.name}@${version} 缺少 provenance 证明：确认是用 OIDC 发布且跑了 --provenance`);
		results.push({ name: target.name, version, integrity, provenanceUrl: provenance.url ?? null });
		console.log(`  · ${target.name}@${version} 完整性一致，provenance 存在`);
	}

	if (audit) {
		for (const target of targets) {
			const dir = mkdtempSync(path.join(os.tmpdir(), "pi-wake-audit-"));
			try {
				writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "audit-probe", private: true }, null, 2));
				execFileSync("npm", ["install", `${target.name}@${version}`, "--registry", registry, "--no-audit", "--no-fund", "--loglevel", "error"], {
					cwd: dir,
					stdio: "inherit",
				});
				execFileSync("npm", ["audit", "signatures"], { cwd: dir, stdio: "inherit" });
				console.log(`  · ${target.name}@${version} npm audit signatures 通过`);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}
	return { version, results };
}

// ---- CLI --------------------------------------------------------------------
function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith("--")) fail(`无法识别的参数：${arg}`);
		const key = arg.slice(2);
		if (key === "no-ancestry" || key === "no-audit") {
			flags[key === "no-ancestry" ? "ancestry" : "audit"] = false;
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) fail(`--${key} 需要一个值`);
		flags[key] = value;
		i += 1;
	}
	return flags;
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const flags = parseArgs(rest);
	const registry = flags.registry ?? DEFAULT_REGISTRY;
	const artifactDir = flags["artifact-dir"] ? path.resolve(flags["artifact-dir"]) : path.join(ROOT, ".build");

	switch (command) {
		case "preflight":
			await preflight({ tag: flags.tag, ancestry: flags.ancestry !== false, sha: flags.sha });
			break;
		case "verify":
			await verify({ tag: flags.tag, artifactDir, sha: flags.sha });
			break;
		case "publish-check":
			await publishCheck({ tag: flags.tag, artifactDir, registry });
			break;
		case "registry-check":
			await registryCheck({ tag: flags.tag, artifactDir, registry, audit: flags.audit !== false });
			break;
		default:
			fail(`用法：node scripts/release.mjs <preflight|verify|publish-check|registry-check> --tag v<版本>`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		if (error instanceof ReleaseError) {
			console.error(`✗ ${error.message}`);
			process.exit(1);
		}
		throw error;
	});
}
