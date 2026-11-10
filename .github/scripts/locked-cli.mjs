// 持钥的作业里不跑包管理器：npm exec、pnpm install 按 registry 当下给的元数据取包，还会跑安装脚本，拿到的不一定是
// 锁文件里那一份。签名 CLI 只取本体和 Linux x64 的原生绑定两个 tarball，按锁文件记的 integrity 核对后直接解开；
// 这个脚本只负责从锁文件里读出这两条 integrity，下载、比对、解包留在各自工作流的步骤里。
// 用法：node locked-cli.mjs <锁文件> <版本>
// 输出两行 `名字<TAB>integrity`，先 cli、后 cli-linux-x64-gnu。认不出就抛错，以非零退出。
// 只用 node 自带的模块，没有 YAML 解析器，所以按锁文件现有的缩进逐行认，认不出宁可失败。
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const USAGE = "用法：locked-cli.mjs <锁文件> <版本>";

/** 锁文件里 @tauri-apps/cli 在 expected 版本下 cli 与 cli-linux-x64-gnu 两条 sha512 integrity，按这个顺序。 */
export function lockedCliIntegrities(lockText, expected) {
  const lines = lockText.split(/\r?\n/);
  const lineAt = (index) => {
    if (index >= lines.length) throw new Error(`锁文件只有 ${lines.length} 行，读不到第 ${index + 1} 行`);
    return lines[index];
  };
  const indexesOf = (text) => lines.flatMap((line, index) => (line === text ? [index] : []));

  // importers 下 devDependencies 里的这一项缩进 6 格，snapshots 里引用它的行形如 'name': version，不会混进来
  const importer = indexesOf("      '@tauri-apps/cli':");
  if (importer.length !== 1) throw new Error(`锁文件里 @tauri-apps/cli 的依赖声明应有恰好一处，实际 ${importer.length} 处`);
  if (!lineAt(importer[0] + 1).startsWith("        specifier: ")) throw new Error("锁文件里 @tauri-apps/cli 的依赖声明后面不是 specifier");
  const locked = /^        version: (\S+)$/.exec(lineAt(importer[0] + 2));
  if (locked === null) throw new Error(`锁文件里 @tauri-apps/cli 的 version 行认不出：${lineAt(importer[0] + 2)}`);
  if (locked[1] !== expected) throw new Error(`锁文件锁定 @tauri-apps/cli ${locked[1]}，要求的是 ${expected}`);

  // packages 与 snapshots 各有一行同名的键，带 resolution 的那一行才是包本身；integrity 只认 sha512，
  // 带 tarball 地址的（不是默认 registry）同样认不出，宁可失败
  return ["cli", "cli-linux-x64-gnu"].map((name) => {
    const found = indexesOf(`  '@tauri-apps/${name}@${expected}':`)
      .map((index) => /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}$/.exec(lineAt(index + 1)))
      .filter((match) => match !== null);
    if (found.length !== 1) throw new Error(`锁文件里 @tauri-apps/${name}@${expected} 的 integrity 应有恰好一条，实际 ${found.length} 条`);
    return { name, integrity: found[0][1] };
  });
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不打印却退出 0，
// 调用方拿到一份空名单，错要等到后面找不到 CLI 才暴露。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((arg) => arg === "")) throw new Error(USAGE);
  const [lockPath, expected] = args;
  // 两条都认出来才输出，免得失败时 stdout 里留下半份结果
  const entries = lockedCliIntegrities(readFileSync(lockPath, "utf8"), expected);
  process.stdout.write(entries.map(({ name, integrity }) => `${name}\t${integrity}\n`).join(""));
}
