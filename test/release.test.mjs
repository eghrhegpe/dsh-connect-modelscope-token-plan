// release.test.mjs —— 发版门禁：截图清单与 npm 包内容的一致性钉子
//
// 纯文件读取：无网络、无 peer 依赖、干净检出即可跑。
//
// 守住两条纪律，都来自 agnes 仓库的实测事故（见姊妹仓 test/docs.test.mjs:549
// 与 test/package.test.mjs:58）：
//
//   SCREENSHOTS screenshots.json 声明的每一张图都真实存在于磁盘、且是图片、
//               条目数在市场允许的 1–8 张内。
//   SHIPPED     screenshots.json 声明的每一张图都被 package.json 的 `files`
//               白名单真正打包进 tarball。
//
// 为什么必须是两条而不是一条：「存在于磁盘」与「存在于 npm 包」是两个独立事实。
// 事故当日assets/ 与 git 都已同步新名、唯独 screenshots.json 还指着已不存在的
// 文件——工作树干净、构建通过、其余检查全绿，没有任何东西在报错，而市场按这份
// 清单取图，推上去就是图裂（那是 SHIPPED 的前一病）；反过来，图在磁盘上好好躺着
// 却没进 files 白名单，磁盘上一切正常，装到用户机器上的包却没图——本条专治后者。
//
// 判据全部是硬事实（文件是否存在、是不是图片、打不打包），不猜语义。

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const files = Array.isArray(pkg.files) ? pkg.files : [];

/**
 * `files` 条目是否覆盖某个仓库内相对路径。
 * 命中条件二选一：条目本身就是该路径（`assets/panel-credit.png`），或它是该路径的
 * 祖先目录（`assets`）。与 npm 的目录递归语义一致。
 * @param {string} rel - 仓库根相对路径
 * @returns {boolean}
 */
const isShipped = (rel) => {
  const parts = rel.replace(/^\.\//, "").split("/");
  return parts.some((_, i) =>
    files.includes(parts.slice(0, i + 1).join("/")));
};

// --- 1) screenshots.json 存在且合法
const manifestPath = join(ROOT, "screenshots.json");
if (!existsSync(manifestPath)) {
  bad("缺少 screenshots.json——市场页靠它取图，没有它市场条目无截图");
} else {
  let list;
  try {
    list = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    bad(`screenshots.json 不是合法 JSON：${e.message}（它是 npm files 白名单成员，坏掉会让市场取不到图）`);
  }

  if (list !== undefined) {
    if (!Array.isArray(list)) {
      bad(`screenshots.json顶层必须是数组，实际是 ${typeof list}`);
    } else if (list.length < 1 || list.length > 8) {
      bad(`screenshots.json 有 ${list.length} 条，超出市场允许的 1–8 张`);
    } else {
      let checked = 0;
      let shipped = 0;
      for (const entry of list) {
        if (typeof entry !== "string") {
          bad(`screenshots.json 含非字符串条目：${JSON.stringify(entry)}（每项都必须是路径字符串）`);
          continue;
        }
        const rel = entry.trim();
        if (rel === "") {
          bad("screenshots.json 含空条目——市场读不到路径");
          continue;
        }
        // 必须是仓库根相对路径：绝对路径与 `..` 逃逸在别人机器上解析不到，市场也读不到。
        if (rel.startsWith("/") || rel.includes("..")) {
          bad(`screenshots.json 的 "${rel}" 不是仓库根相对路径（绝对路径 / .. 逃逸在别人机器上必裂）`);
          continue;
        }
        if (!IMAGE_EXT.has(extname(rel).toLowerCase())) {
          bad(`screenshots.json 的 ${rel} 不是图片扩展名（${[...IMAGE_EXT].join("/")}）`);
          continue;
        }
        if (!existsSync(join(ROOT, rel))) {
          bad(`screenshots.json 声明的 ${rel} 不存在——清单指空，市场按它取图必然裂`);
          continue;
        }
        if (!isShipped(rel)) {
          bad(`截图 ${rel} 在磁盘上存在但没进 package.json 的 files 白名单——装到用户机器上的 npm 包里没有这张图`);
          continue;
        }
        checked++;
        shipped++;
      }
      if (checked === list.length) {
        note(`screenshots.json 的 ${checked} 张图全部存在于磁盘、为图片、且被 files 白名单打包`);
      }
      if (checked === 0) {
        bad("检查 SCREENSHOTS 可能已失效：本次一张图都没受检（清单被清空或路径规则失配）");
      }
      if (shipped > 0) note(`${shipped} 张图确认随包发布`);
    }
  }
}

// --- 2) 逆检查：assets/ 下有图却没进 files，等于白存
// 只在 assets 目录真实存在时才有对象；不存在不报（截图是可选增强）。
const hasAssets = existsSync(join(ROOT, "assets"));
if (hasAssets && !files.includes("assets")) {
  bad("仓库有 assets/ 目录但 package.json 的 files 不含 \"assets\"——截图不会随包发布，市场条目在 npm 安装路径下图裂");
}
if (hasAssets) note("assets/ 已在 files 白名单内");
else note("无 assets/ 目录，跳过 files 覆盖检查");

if (fails.length > 0) {
  console.error(`\nrelease.test.mjs: ${fails.length} 条失败`);
  for (const f of fails) console.error(`  x - ${f}`);
  process.exit(1);
}
console.log("\nrelease.test.mjs 全部通过");
