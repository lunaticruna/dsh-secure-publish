# DSH Secure Publish

一个由人操作的 `minisign + age` 源码交付插件，提供独立 CLI，并通过同一个 bundle 接入 DSH / DSHA。编码机发布已提交的源码快照，目标机只接收、检查、应用、编译和调试；GitHub 中继仅保存密文。

**状态：0.1.0 初始实现，适合先用非敏感测试项目验收。** 兼容的是 DSH 人工命令接口与 DSHA 插件包格式；本项目没有获得 Android 真机、Windows 或 macOS 的运行验收。完整验证记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 已实现

| 操作 | 行为 |
| --- | --- |
| Publish | 固定路径白名单 → 已提交 Git blob → 两份 minisign 签名 → age 多接收者加密 → 预览 → 人工确认后 Git push |
| Fetch | 固定仓库与分支 → 下载密文 → age 解密 → 固定 minisign 公钥验签 → SHA-256 → 防重放 → staging |
| Diff / Apply | 展示增删改及文本差异；确认摘要绑定当时的配置、候选目录和当前目录；确认后替换完整快照 |
| Rollback | 预览并恢复本地备份；最高已验证序号不会降低 |
| Recover | 目录切换中断后检查日志，完成切换或恢复原目录 |

不执行收到的代码、不自动编译、不注册模型工具、不启动网络监听、不让命令参数指定仓库、recipient 或任意覆盖路径。没有 npm 运行时依赖和安装脚本。

## 1. 安装依赖和插件

运行环境：Node.js **22+**、Git、官方 `age`（含 `age-keygen`）、`minisign`。只支持 age 原生 X25519 公钥，暂不接受 SSH recipient、硬件插件或 PQ key。

DSHA 自带的 Ubuntu 环境内，以及 Ubuntu / Debian 编码机或接收机：

```sh
apt-get update
apt-get install -y git age minisign
```

普通 Linux 用户需要按系统要求加 `sudo`。**在 DSHA 的 Ubuntu 终端执行，不能把 Termux/bionic 二进制当成 Ubuntu/glibc 版本。** Node 由 DSHA 提供；检查 `node --version`。

macOS 使用官方软件包管理渠道安装 Node、Git、age 和 minisign。Windows 使用原生 Node 和对应官方 age/minisign 可执行文件，并安装 Git；也可以整套放进 WSL。二进制安装参考：[age](https://github.com/FiloSottile/age#installation)、[minisign](https://github.com/jedisct1/minisign#installation)。不要混用 Windows 与 WSL 的路径、密钥和状态目录。

### DSH

从插件源码/发布包目录安装，假设当前使用 `web` profile：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-secure-publish
```

插件声明了 `dsh.bundle.patch`，无需手写 DSH 的 patch。安装后重启对应 DSH profile。

也可以直接从本仓库安装：

```sh
dsh plugin --profile web add github:lunaticruna/dsh-secure-publish
```

需要固定版本时，在包地址后追加 `#完整提交SHA`。源码树就是可运行包，无需构建、无需 pnpm workspace。

### DSHA

1. 在插件市场粘贴 `https://github.com/lunaticruna/dsh-secure-publish`，或通过「导入插件包」选择本项目 ZIP/TGZ。
2. 启用插件，重启 Web。
3. 在对话输入框输入 `/sp help`，应出现命令帮助。

DSHA 文档明确：导入包不会运行 `prepare/build/install`；本包入口都是现成 JavaScript，符合这个要求。若依赖尚未安装，先完成上面的 Ubuntu 终端步骤。[DSHA 安装契约](https://github.com/DSH-APP/DSHA/blob/main/docs/plugins.md)。

### 目标机只需要 CLI

目标机不必安装 DSH，也不必安装任何 coding agent：

```sh
npm install -g /absolute/path/to/dsh-secure-publish
secure-publish help
```

不想全局安装时，用 `node /absolute/path/to/dsh-secure-publish/lib/cli.js ...`。

## 2. 建立独立中继仓库和信任

**插件代码仓库与业务源码的密文中继仓库是两回事。** 建议新建专用中继仓库，例如自己的 `source-relay`。可公开，也可私有。不要把明文源码、配置、密钥或普通工作仓库直接 push 进去。建议关闭这个中继仓库的 Actions，避免把源码交付误当成 CI 自动执行入口。

发布端使用本机已有的 Git HTTPS 凭据。可选地使用 GitHub CLI 的 `gh auth login`、`gh auth setup-git` 配置凭据；插件本身不读取 PAT 配置、不收集密码、不管理 OAuth。公共中继的目标机通常不需要 GitHub 凭据；私有中继需要只读权限。发布端权限只授予专用中继所需的 Contents 读写。

两端需要交换的只有：

| 信息 | 方向 | 用途 |
| --- | --- | --- |
| age **公钥** `age1...` | 每台接收机 → 发布端 | 指定谁能解密 |
| minisign **公钥** `RW...` | 发布端 → 每台接收机 | 固定信任哪个发布者 |
| project / channel / repository / branch | 两端一致 | 防止跨项目或跨通道替换 |

通过可信渠道核对公钥。禁止从待验证制品或同一个不可信中继自动更新信任公钥。每台接收设备保留自己的 age 私钥；签名私钥只放在发布端。移除某个 age recipient 只影响后续发布，不能撤回它已能解密的历史制品。

## 3. 配置向导

在受信任终端运行：

```sh
secure-publish init
```

默认配置是 `~/.config/dsh-secure-publish/config.json`。向导会创建专用 key 目录并引导生成本机密钥。发布端 minisign 默认生成**口令保护**私钥；口令交给 minisign 终端提示，不进 JSON、不进聊天。接收端生成 age 私钥并显示可分享的公钥。

两端都有各自待交换的公钥，可以先完成发布端/接收端的密钥生成，再根据示例填入配置。向导中止后保留已生成密钥，不覆盖它们；使用 [publisher.json](examples/publisher.json) / [receiver.json](examples/receiver.json) 完成配置即可。所有 `REPLACE_...` 必须替换，模板故意不能直接发布。

多个项目在 `projects` 下增加不同简称。每个项目的 source、接收者、目标目录均由文件固定。CLI 可以用 `--config /absolute/config.json` 选择配置；插件只使用默认固定路径，不接受聊天参数改路径。

Linux/macOS/DSHA：配置、私钥 `600`，私有目录 `700`；必须位于源码和接收目录之外。Windows 请用 NTFS ACL 限制为本人；本程序的 POSIX mode 检查不能验证 Windows ACL。DSHA 私钥放 Ubuntu 私有目录，不放共享 `/sdcard`。

运行检查：

```sh
secure-publish doctor
```

也可以输入 `/sp doctor`。Doctor 只检查本地环境和配置，不会代替实际中继读写验收。

### Web 端发布与口令保护的签名私钥

Web 不询问或接收私钥口令。对于口令保护的 minisign 私钥：**在受信任终端执行 publish 预览和确认**。首版为清单和制品分别签名，可能询问两次口令。

无人值守、无口令的 minisign 密钥可以被 `/sp publish` 使用，但同 UID 的 agent Bash 也可能读取它。请先理解 [SECURITY.md](SECURITY.md)；不要为了省步骤把已有口令保护密钥解密存到项目中。若要阻止同 UID agent 接触私钥，需要独立系统用户/外部签名机等 OS 隔离，首版没有实现这种隔离。

## 4. 日常交付

假设编码机配置简称 `desktop`、目标机简称 `laptop`，两者的共享项目标识相同。

编码机先将计划交付的修改提交到 Git，确认 `git status` 干净。`include` 是文件或目录前缀列表，**不是 glob**；例如 `src` 包含 `src/` 下所有已提交文件。被 `.gitignore` 忽略的工作树文件本来就不会打包，未提交或非忽略的未跟踪文件会阻止发布。

```sh
secure-publish publish desktop
# 检查输出的 commit、文件清单、recipient、repository、branch
secure-publish publish desktop <24位确认摘要>
```

第一次只在私有状态目录准备密文；第二次才上传完全相同的包，确认有效期 15 分钟。Git push 不强推。失败或网络结果不明确时，先检查状态，然后在有效期内重试**同一摘要**；相同密文和序号可幂等识别。每次新预览会预留新序号，中间缺号是正常现象。

目标机：

```sh
secure-publish fetch laptop
secure-publish diff laptop
secure-publish apply laptop <diff给出的24位确认摘要>
```

使用插件时，同样输入 `/sp fetch laptop`、`/sp diff laptop`、`/sp apply laptop <摘要>`。

最终源码在配置的 `targetRoot/current`。这是完整目录快照交付，包含新增、修改和删除。**新目录会取代整个 current，不是往现有仓库覆盖/合并。** 编译输出尽量设置到 `targetRoot` 之外。current 中额外的普通文件会列在 `extraPreservedInBackup`，应用后保留在备份里，不会进入新的 current。接收端若直接改动已管理源码，会拒绝应用；先将调试修改复制到别处，人工反馈给编码机。

文本 Diff 展示最多 20 个已修改文件，每个最多 12 KB，总共最多 64 KB；新增/删除文件在清单中列出。应用摘要仍绑定完整目录内容。预览后文件有变化，需重新 Diff。

本地回滚：

```sh
secure-publish rollback laptop
secure-publish rollback laptop <新的确认摘要>
```

回滚不访问网络，不降低防重放状态。备份位于 `targetRoot/backup-UUID`；首版不自动删除备份。备份中源码若被改动也会拒绝恢复。不要删除 `stateDir` 来解决旧包拒绝问题，它包含信任序号。

## 5. 故障恢复和约束

- 目录切换中断：停止编译/文件写入，再运行 `recover <profile>`。有歧义时拒绝自动处理，保留目录和日志供检查。
- 进程崩溃留下锁：确认旧进程已经退出，运行 `unlock <profile>`；活进程或 PID 被复用时不会清锁。
- 首次目标目录必须不存在；已有目录必须含本插件对应项目的所有权标记。不会把现有项目当成可覆盖目录。
- `minSequence` 是首次信任序号下限；新设备应通过可信渠道获得当前序号，不能仅凭「公钥正确」判断拿到的是最新版本。已有设备以本地 high-water mark 拒绝回放。中继仍能隐藏新版本/拒绝服务。
- 包最大明文源码 32 MiB、10000 文件；密文/签名信封最大 80 MiB；接收工作树扫描上限 256 MiB / 50000 条目。适合源码交付，不用于二进制产物仓库。
- 拒绝符号链接、junction、submodule、Git LFS pointer、大小写冲突、跨平台非法路径、常见密钥文件名和私钥头。路径过滤不是通用秘密扫描器，发布预览仍需检查。
- 暂存、current、备份含明文源码，删除不是 SSD 安全擦除；设备和状态目录属于信任边界。
- 当前只有 Git 分支中继；未实现 GitHub Releases、后台定时同步、增量补丁、自动更新、硬件签名或密钥轮换向导。

更多协议和边界：[设计](docs/DESIGN.md)、[安全说明](SECURITY.md)、[验收记录](docs/VALIDATION.md)。

## 开发验证

```sh
npm run check
REQUIRE_CRYPTO=1 npm test
npm pack --ignore-scripts
```

测试使用临时、随机生成的密钥和本地裸 Git 仓库，不触碰真实中继或真实用户源码。`REQUIRE_CRYPTO=1` 确保缺少 age/minisign 时不会把跳过集成测试当作通过。

## 上游契约

- [DSH bundle / plugin CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
- [DSH 人工命令服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/commands/src/index.ts)
- [DSHA 早期基线 dsh-v0.1.2-rc.1 的相同命令契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/interaction/commands/src/index.ts)
- [DSHA 包导入要求](https://github.com/DSH-APP/DSHA/blob/main/docs/plugins.md)

独立第三方插件，与 DeepSeek、DSHA、age 或 minisign 官方无隶属关系。MIT License。
