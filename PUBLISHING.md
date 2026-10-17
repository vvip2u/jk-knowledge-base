# 打包与发布（Git / tarball / npm）

> 目标：把插件从"工作区里的开发目录"变成**独立干净、可被别人装**的产物。

## 0. 现状（已就绪的部分）

| 项 | 状态 |
|---|---|
| `package.json` 的 `dsh` 清单（bundle patch + client inject） | ✅ |
| `files` 白名单 | ✅（已修：`assets/maintenance-rules.json` 之前漏了，会让「整理」在打包版里 `ASSETS_MISSING`） |
| `LICENSE`(MIT) / `README.md` / `CHANGELOG.md` | ✅ |
| `.gitignore` | ✅（`node_modules/`、`*.tgz`、`.DS_Store`） |
| 零运行时依赖 | ✅（`dependencies` 不存在，纯 node 标准库） |
| 个人路径泄漏 | ✅ 无（夹具里的 `/Users/tester`、文档里的 `C:\\Users\\<你>` 是占位，不算） |
| 运行时数据 `.jkkb` 混入仓库 | ✅ 无 |
| 打包自检 | ✅ `node tools/pack-check.mjs`（15 条，含"assets 一个都不能漏"） |

## 1. 发布前必跑（3 条命令）

```bash
node tools/pack-check.mjs          # 白名单 + 资源完整性 + 泄漏 + 体积
npm run test                       # 5 套测试全绿（smoke/doctor/engine/skills/ui）
npm pack --dry-run                 # 看真实入包清单（62 个文件 / 1.3 MB）
```

> 本机 npm 的 cache 目录有 root 属主文件会 EPERM，加临时 cache 即可：
> `CACHE=$(mktemp -d) && npm_config_cache=$CACHE npm pack --dry-run`
> 想彻底修：`sudo chown -R 501:20 ~/npm_config_cache`

## 2. 建成 git 仓库并首次提交

```bash
cd ~/workspace/dsh_space/dsh-diy-plugins/jk-knowledge-base
git init -b main
git add -A
git commit -m "feat: JK知识库 v1.0.0（19 工具 / 19 路由 / 5 视图 / 1872 条测试）"
git tag -a v1.0.0 -m "v1.0.0"
```

建远程（GitHub 私有即可）后：

```bash
git remote add origin git@github.com:vvip2u/jk-knowledge-base.git
git push -u origin main --tags
```

**仓库里应当有的**：`index.js` `client.js` `host/**` `assets/**` `tools/**`（5 套测试 + pack-check）`docs/**` `cordis.patch.yml` `package.json` `README.md` `CHANGELOG.md` `LICENSE` `.github/workflows/test.yml`。
**不该有的**：`.jkkb/`（运行时数据）、`node_modules/`、`*.tgz`、任何测试生成的临时根目录。

## 3. 从 Git 安装（推荐路线）

```bash
dsh plugin --profile desktop add github:vvip2u/jk-knowledge-base#v1.0.0
```

- 带 `#v1.0.0` 锁版本；升级时改 tag 再 add 一次。
- 装完 **host 半要重启 App 才生效**；client 半刷新页面即可。
- 校验安装：读 `~/.dsh/profiles/desktop/package.json` 里是否有该依赖。

## 4. 从 tarball 安装（不跑 registry、团队内分发）

```bash
npm pack                                  # 生成 jk-knowledge-base-1.0.0.tgz
dsh plugin --profile desktop add ./jk-knowledge-base-1.0.0.tgz
```

## 5. 发到 npm registry（可选，需改名）

无 scope 的 `jk-knowledge-base` 很可能被占，且 `private: true` 会挡住发布：

1. `package.json`：删 `private`，`name` 改成 `@vvip2u/jk-knowledge-base`；
2. `npm publish --access public`；
3. 安装：`dsh plugin --profile desktop add @vvip2u/jk-knowledge-base@1.0.0`。

## 6. 版本纪律

- 改了 host 侧（`host/**`、`index.js`）：**升 minor 或 patch + 打 tag**，因为装的人必须重启；
- 只改 `client.js`：同样要发版（别人无法只刷新他们的资产）；
- 每版更新 `CHANGELOG.md`，并在 `package.json` 里同步 `version`（smoke 有一条断言校验 client 的 `PLUGIN_VERSION` 与 package.json 一致）。

## 7. 跨平台验证

`.github/workflows/test.yml` 已在 `ubuntu / macos / windows` × `node 22 / 24` 六个组合上跑 5 套测试 + pack-check。
Windows 真机的人工清单仍是 `docs/windows-verification.md`（CI 覆盖不了 ACL / UNC / 长路径这些系统行为）。