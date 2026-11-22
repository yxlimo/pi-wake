#!/usr/bin/env node
// release.mjs 的判据测试。不依赖外网：假 registry 是本进程内的 http 服务。
// 覆盖：工具链下限、tag 对账、字节幂等三支，以及打包后必须留在包里的东西
// （pi.extensions 入口、README）——后两条是这个包里 prepack 特有的失败面。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertToolchain,
	compareVersions,
	fileDigests,
	publishCheck,
	ReleaseError,
	resolveTag,
	verify,
} from "./release.mjs";

// ---- 工具链下限 ---------------------------------------------------------------
test("Node/npm 低于下限时报错，等于或高于则通过", () => {
	assert.throws(() => assertToolchain({ node: "22.13.9", npm: "11.5.1" }), /Node 22\.13\.9 低于下限/);
	assert.throws(() => assertToolchain({ node: "22.14.0", npm: "11.5.0" }), /npm 11\.5\.0 低于下限/);
	// 下限本身必须通过：把边界写成 > 而不是 >= 的话这里会红。
	assert.deepEqual(assertToolchain({ node: "22.14.0", npm: "11.5.1" }), { node: "22.14.0", npm: "11.5.1" });
	assert.deepEqual(assertToolchain({ node: "24.1.0", npm: "11.6.2" }), { node: "24.1.0", npm: "11.6.2" });
});

test("版本比较把预发布排在正式版之前", () => {
	assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
	assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
	assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
	assert.equal(compareVersions("1.2.3", "1.10.0"), -1);
});

// ---- tag 与包版本对账 ---------------------------------------------------------
test("tag 与包版本不一致时拒绝发布", () => {
	const targets = [{ name: "@yxlimo/pi-wake", version: "0.1.1" }];
	assert.equal(resolveTag("v0.1.1", targets), "0.1.1");
	assert.throws(() => resolveTag("v0.1.2", targets), /tag v0\.1\.2 与包版本 0\.1\.1 不一致/);
	assert.throws(() => resolveTag("0.1.1", targets), /tag 必须是 v<版本> 形式/);
});

// ---- 假 registry -------------------------------------------------------------
function startRegistry(payloadFor) {
	const server = createServer((req, res) => {
		const name = decodeURIComponent((req.url ?? "/").replace(/^\//, ""));
		const payload = payloadFor(name);
		if (!payload) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
		});
	});
}

function metadataFor(name, version, integrity) {
	return { name, "dist-tags": { latest: version }, versions: { [version]: { name, version, dist: { integrity } } } };
}

// 造一个假仓库根：packages/fixture 一个可发布的包。
// options 用来故意漏掉入口文件或 README，验证打包后的检查确实会拦。
function makeFixture({ entryFile = "src/index.ts", withReadme = true, writeEntry = true } = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-wake-release-"));
	const pkgDir = path.join(root, "packages", "fixture");
	mkdirSync(path.join(pkgDir, "src"), { recursive: true });
	writeFileSync(
		path.join(pkgDir, "package.json"),
		`${JSON.stringify(
			{ name: "fixture-pkg", version: "1.2.3", type: "module", files: ["src"], pi: { extensions: [entryFile] } },
			null,
			2,
		)}\n`,
	);
	if (writeEntry) writeFileSync(path.join(pkgDir, entryFile), "export const ok = true;\n");
	if (withReadme) writeFileSync(path.join(pkgDir, "README.md"), "# fixture\n");
	return { root, pkgDir, artifactDir: path.join(root, ".build") };
}

test("verify 把包打出来并记下字节指纹", async () => {
	const fixture = makeFixture();
	try {
		const manifest = await verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" });
		assert.equal(manifest.packages.length, 1);
		assert.equal(manifest.packages[0].name, "fixture-pkg");
		assert.equal(manifest.packages[0].file, "fixture-pkg-1.2.3.tgz");
		// 清单里的指纹必须和真实文件一致，否则后面的幂等比较就是拿假数据在比。
		assert.equal(manifest.packages[0].integrity, fileDigests(path.join(fixture.artifactDir, "fixture-pkg-1.2.3.tgz")).integrity);
		assert.match(readFileSync(path.join(fixture.artifactDir, "SHA256SUMS"), "utf8"), /fixture-pkg-1\.2\.3\.tgz/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("pi.extensions 声明的入口没进包 → 打包阶段就失败", async () => {
	const fixture = makeFixture({ writeEntry: false });
	try {
		await assert.rejects(
			() => verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" }),
			/没有 pi\.extensions 声明的入口 src\/index\.ts/,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("包里没有 README → 失败（prepack 复制失败会被抓住）", async () => {
	const fixture = makeFixture({ withReadme: false });
	try {
		await assert.rejects(
			() => verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" }),
			/没有 README\.md/,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("同版本已存在且字节相同 → 跳过，不重复发布", async () => {
	const fixture = makeFixture();
	let registry;
	try {
		const manifest = await verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" });
		registry = await startRegistry(() => metadataFor("fixture-pkg", "1.2.3", manifest.packages[0].integrity));
		const result = await publishCheck({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, registry: registry.url });
		assert.deepEqual(result.decisions, [{ name: "fixture-pkg", file: "fixture-pkg-1.2.3.tgz", publish: false, state: "identical" }]);
	} finally {
		registry?.close();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("同版本已存在但字节不同 → 失败并给出两份指纹", async () => {
	const fixture = makeFixture();
	let registry;
	try {
		await verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" });
		registry = await startRegistry(() => metadataFor("fixture-pkg", "1.2.3", "sha512-differentBytesOnTheRegistry=="));
		await assert.rejects(
			() => publishCheck({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, registry: registry.url }),
			(error) => {
				assert.ok(error instanceof ReleaseError, "必须是面向使用者的失败，而不是崩溃");
				assert.match(error.message, /1 个包的版本已在 registry 上但字节不同/);
				assert.match(error.message, /sha512-differentBytesOnTheRegistry==/);
				assert.match(error.message, /提升版本号/);
				return true;
			},
		);
	} finally {
		registry?.close();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("版本不存在 → 允许发布", async () => {
	const fixture = makeFixture();
	let registry;
	try {
		await verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" });
		// 404：registry 上完全没有这个包。
		registry = await startRegistry(() => null);
		const result = await publishCheck({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, registry: registry.url });
		assert.deepEqual(result.decisions, [{ name: "fixture-pkg", file: "fixture-pkg-1.2.3.tgz", publish: true, state: "absent" }]);
	} finally {
		registry?.close();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("publish 阶段缺少 tarball 时报错，不重新打包", async () => {
	const fixture = makeFixture();
	let registry;
	try {
		await verify({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, sha: "fixture-sha" });
		rmSync(path.join(fixture.artifactDir, "fixture-pkg-1.2.3.tgz"));
		registry = await startRegistry(() => null);
		await assert.rejects(
			() => publishCheck({ tag: "v1.2.3", root: fixture.root, artifactDir: fixture.artifactDir, registry: registry.url }),
			/publish 阶段不允许重新打包/,
		);
	} finally {
		registry?.close();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
