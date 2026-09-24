# DSH Secure Publish

一个由人操作的 `minisign + age` 源码交付插件，提供独立 CLI，并通过同一个 bundle 接入 DSH / DSHA。编码机发布已提交的源码快照，目标机只接收、检查、应用、编译和调试；GitHub 中继仅保存密文。

**状态：0.2.0，新增工作区内项目初始化。** 兼容的是 DSH 人工命令接口与 DSHA 插件包格式；本项目没有获得 Android 真机、Windows 或 macOS 的运行验收。请先用非敏感测试项目验收，完整记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 已实现

| 操作 | 行为 |
| --- | --- |
| Workspace Init | 当前 DSH Session cwd → 真实 Git root → 复用设备身份、peer 和中继默认值 → 预览 → 确认后注册项目 |
| Publish | 固定路径白名单 → 已提交 Git blob → 两份 minisign 签名 → age 多接收者加密 → 预览 → 人工确认后 Git push |
| Fetch | 固定仓库与分支 → 下载密文 → age 解密 → 固定 minisign 公钥验签 → SHA-256 → 防重放 → staging |
| Diff / Apply | 展示增删改及文本差异；确认摘要绑定当时的配置、候选目录和当前目录；确认后替换完整快照 |
| Rollback | 预览并恢复本地备份；最高已验证序号不会降低 |
| Recover | 目录切换中断后检查日志，完成切换或恢复原目录 |

发布与接收使用已固定的配置；工作区初始化只能选择已在终端登记的身份和 peer，不能用聊天参数改 source、中继或配置路径。不执行收到的代码、不自动编译、不注册模型工具、不启动网络监听。没有 npm 运行时依赖和安装脚本。

## 1. 安装依赖、插件与 CLI

运行环境：Node.js **22+**、Git、官方 `age`（含 `age-keygen`）、`minisign`。只支持 age 原生 X25519 公钥，暂不接受 SSH recipient、硬件插件或 PQ key。

DSHA 自带的 Ubuntu 环境内，以及 Ubuntu / Debian 编码机或接收机：

```sh
apt-get update
apt-get install -y git age minisign
```

普通 Linux 用户需要按系统要求加 `sudo`。**在 DSHA 的 Ubuntu 终端执行，不能把 Termux/bionic 二进制当成 Ubuntu/glibc 版本。** Node 由 DSHA 提供；检查 `node --version`。使用下面的 npm / npx 入口还需确认 `npm --version` 和 `npx --version` 可用。

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

需要固定版本时，在包地址后追加 `#完整提交SHA`。源码树就是可运行包，无需构建、无需 pnpm workspace。这里安装的是 DSH 插件；终端 CLI 仍需按下面的 CLI 安装步骤单独安装，或使用第 3.1 节的免全局安装入口。

### DSHA：插件安装 + CLI 安装是两个步骤

**「DSHA 插件已安装」不等于终端里的 `secure-publish` 命令已安装。** 默认流程是先安装插件，再单独安装 CLI；不想全局安装 CLI 时，可改用第 3.1 节的 `npx` 或 `/sp setup` 入口。

| 安装步骤 | 提供的入口 | 验证位置与命令 |
| --- | --- | --- |
| 第 1 步：安装并启用插件 | DSH / DSHA 人工命令 | 对话输入框：`/sp help` |
| 第 2 步：单独安装 CLI | 终端里的 `secure-publish` | DSHA Ubuntu 终端：`secure-publish help` |

#### 第 1 步：安装并启用插件

1. 在插件市场粘贴 `https://github.com/lunaticruna/dsh-secure-publish`，或通过「导入插件包」选择本项目 ZIP/TGZ。
2. 启用插件，重启 Web。
3. 在对话输入框输入 `/sp help`，应出现命令帮助。

DSHA 文档明确：导入包不会运行 `prepare/build/install`；本包入口都是现成 JavaScript，符合这个要求。**插件包虽包含 `lib/cli.js`，导入插件并不会把 `secure-publish` 加入终端的 `PATH`。** 若依赖尚未安装，先完成上面的 Ubuntu 终端步骤。[DSHA 安装契约](https://github.com/DSH-APP/DSHA/blob/main/docs/plugins.md)。

#### 第 2 步：在 Ubuntu 终端安装 CLI

在 **DSHA 的 Ubuntu 终端**、与 DSHA 服务相同的用户环境中执行（不是聊天输入框，也不是外层 Termux）：

```sh
npm install --global --ignore-scripts "git+https://github.com/lunaticruna/dsh-secure-publish.git#2363da6dfe8a377daf77ca3d6dffdade7e6a993c"
secure-publish help
```

此处固定到 [0.2.0 的实现提交](https://github.com/lunaticruna/dsh-secure-publish/commit/2363da6dfe8a377daf77ca3d6dffdade7e6a993c)，从 GitHub 安装，不依赖 npm 上的同名包。插件与 CLI 应使用相同版本；两者需要分别更新。安装成功只代表命令可用，设备身份和信任仍需在第 3.1 节执行 `bootstrap` 初始化。

若 `/sp help` 正常，但终端报 `secure-publish: command not found`，先检查是否完成第 2 步；已安装则用 `command -v secure-publish` 检查当前 Ubuntu 用户的 `PATH`。不需要为此重复导入插件。遇到全局安装权限问题，可使用第 3.1 节的免全局安装入口；不要为了运行 `bootstrap` 切换到另一个用户，以免写入不同的配置目录。

### 目标机只需要 CLI

目标机不必安装 DSH，也不必安装任何 coding agent，直接在目标机执行上面的 CLI 安装命令即可。DSH 编码机也可以使用相同命令。若已克隆或解压本项目，还可以从本地目录安装：

```sh
npm install --global --ignore-scripts /absolute/path/to/dsh-secure-publish
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

## 3. 一次配置设备，在每个 Workspace 内注册项目

| 层次 | 保存什么 | 在哪里维护 |
| --- | --- | --- |
| Device Identity | Publisher 的 minisign 密钥；Receiver 的 age 密钥 | 受信任终端，`bootstrap`，通常每台设备一次 |
| Peer Trust | Windows 的 age 公钥；DSHA 的 pinned minisign 公钥；中继默认值 | 受信任终端，`bootstrap` / `peer` |
| Workspace Profile | 项目标识、通道、当前 Git root、文件白名单、独立发布状态 | Publisher 当前 DSH Workspace，`/sp init` |
| Receiver Profile | 两端一致的项目绑定、独立 targetRoot 和防重放状态 | Windows 等接收端 CLI，`profile add/clone` |

### 3.1 DSHA / DSH：安装入口后，设备初始化只做一次

推荐顺序：**安装插件 → 安装 CLI → 终端 `bootstrap` → 回到 Workspace `/sp init`**。插件安装和 CLI 安装是两个步骤，`bootstrap` 是安装后的设备初始化，不会自动安装 CLI。

下面三个入口**任选一个**，无需重复初始化；都必须在受信任终端交互操作，不能把私钥或口令发进聊天。

**A. 已全局安装 CLI（推荐日常使用）**

确认 `secure-publish help` 可用后，在终端执行：

```sh
secure-publish bootstrap
```

**B. 不全局安装：用 npx 一次性初始化**

已安装插件但终端还没有 `secure-publish` 时，可在同一 DSHA Ubuntu 用户的终端执行：

```sh
npx --yes --ignore-scripts --package="git+https://github.com/lunaticruna/dsh-secure-publish.git#2363da6dfe8a377daf77ca3d6dffdade7e6a993c" secure-publish bootstrap
```

此命令从本仓库固定的 0.2.0 提交取得 CLI，放入 npm 缓存并运行一次；**不会永久安装 `secure-publish` 命令，也不会安装 DSHA 插件或 age/minisign 等系统依赖**。首次获取需要能访问 GitHub。`--yes` 只同意 npm 获取包，不会跳过初始化向导的确认。不要简写为 `npx secure-publish`，以免使用 npm 上的其他包。

后续终端操作沿用同一整条 `npx … secure-publish` 前缀，把末尾 `bootstrap` 换成 `peer add`、`doctor` 等；或完成第 1 节的全局 CLI 安装。初始化配置与密钥不在 npm 缓存中，默认保存在当前用户的 `~/.config/dsh-secure-publish/`。

**C. 不另行下载 CLI：使用插件已附带的入口**

在已启用插件的对话输入框输入：

```text
/sp setup
```

它**只显示命令，不安装全局 CLI，也不在聊天中执行初始化**。输出包含当前插件实际安装位置对应的完整 `node …/lib/cli.js --config … bootstrap` 命令；把它原样复制到 DSHA 的 Ubuntu 终端执行即可，无需查找安装目录。后续操作沿用同一 `node …/lib/cli.js --config …` 前缀；插件升级或移动后，应重新运行 `/sp setup` 获取路径。

三个入口应使用同一用户、同一配置文件。如果终端与 DSHA 服务的用户目录不同，优先使用 `/sp setup` 给出的完整命令和 `--config` 路径；使用全局 CLI / npx 时，`--config <该绝对路径>` 放在 `bootstrap` 等子命令之前。不要在另一位置重新生成一套身份来解决“插件找不到配置”。

**以下所有 `secure-publish …` 示例默认已全局安装 CLI；选择 B 或 C 时，请替换为对应的完整命令前缀。**

Publisher 选择 `publisher`。向导只询问设备身份、密钥生成或导入、默认中继/分支/通道、Receiver peer；**不会询问项目名或 source 路径**。新建 minisign 密钥使用口令保护，口令由 minisign 在终端直接读取。

Windows Receiver 选择 `receiver`，生成或导入 age identity。两端先通过可信渠道交换公钥。如果对端公钥还没准备好，可以留空完成本机初始化，之后运行 `peer add` 补上；新增第一个对应 peer 会成为新项目的默认值：

```sh
secure-publish identity show
secure-publish peer add
secure-publish peer list
secure-publish peer show windows-main
secure-publish doctor
```

`identity show` 只显示可分享的公钥。`peer add` 输入的是对端公钥，禁止输入私钥。`peer default <name>` 切换**未来新增项目**的默认 peer；现有 profile 继续使用已经确认的信任绑定，不会静默换接收者。

### 3.2 Publisher：回到当前 Workspace 输入 `/sp init`

先在 DSH 创建并打开项目 Workspace，把源码纳入 Git。插件读取 `agent.session.header.cwd`，检测真实 Git root；打开仓库子目录时也会明确预览根目录。不会退回 DSH 服务进程的启动目录。

```text
/sp init
```

检查输出中的 Workspace、Git root、profile、共享项目标识、通道、中继、身份、peer、include/exclude 和选中/遗漏文件。默认简称和项目标识建议为仓库目录名；非 ASCII 名称会生成可用简称。中继与信任复用设备默认值。

确认：

```text
/sp init <预览给出的24位摘要>
/sp status
/sp config
```

需要调整项目标识或白名单时，先重新预览，再确认新摘要：

```text
/sp init --profile project-a --project project-a --channel main --include src,README.md,package.json --exclude src/private
```

路径列表以逗号分隔，带空格的整个参数用引号包住，例如 `--include "src files,README.md"`；`--exclude ""` 表示空排除列表。`include` 是明确的文件/目录前缀，**不是 glob，也不会自动设为 `.`**。建议选择只是起点，必须检查遗漏的必要文件；不安全文件所在的目录不会被整目录建议选入。

还可用 `--identity <已有身份>`、`--peers <已有peer1,已有peer2>` 选择已登记的信任。source 始终来自当前 Workspace 的 Git root；没有 `--source`、`--repository` 或 `--config` 聊天覆盖参数。

确认有效期为 15 分钟，绑定当前 cwd、Git root/索引、配置版本、身份、peer 和白名单。切换 Workspace、更新 Git 索引或修改配置/密钥后，旧摘要会失效。预览只保存私有确认记录；确认后才原子写入配置，不生成新密钥、不上传源码。

**5 个项目的用法**：在 Workspace A 完成 `/sp init` → 确认；切到 B、C、D、E 重复即可。第二个起无需再进终端，不用复制 Workspace 路径或编辑 JSON。各项目的序号、pending 和 state namespace 独立。

已有绑定的 `/sp init` 只显示现有配置，不覆盖它。`/sp status`、`/sp config`、`/sp publish` 自动选择当前 Workspace。显式指定 Publisher profile 时也必须属于当前 Workspace，防止从 A 误发布 B；独立 CLI 的显式 profile 用法保留。

### 3.3 Windows Receiver：通过 CLI 管理多个项目

完成 Receiver bootstrap 和 Publisher 公钥登记后：

```powershell
secure-publish profile add
secure-publish profile clone project-a project-b
secure-publish profile clone project-a project-c
secure-publish profile clone project-a project-d
secure-publish profile clone project-a project-e
secure-publish profile list
secure-publish profile show project-b
```

`add` 使用设备默认信任；`clone` 复用来源 Receiver profile 的信任和中继。向导分别确认共享 project、channel、repository、branch，以及**新的专用接收目录**。Windows 路径可直接输入 `D:\SecureWorkspaces\project-b`，无需 JSON 转义。

两端本机简称可以不同，共享 `project + channel + repository + branch` 必须一致。首次信任序号下限由你通过可信渠道获得并输入；clone 不复制旧项目的 highwater、pending、staged 或源码目录。

`profile remove <name>` 只移除注册，保留密钥、源码、备份和状态。旧名称及项目绑定会保留为退役记录，禁止通过 add/clone 重用并重置防重放状态；重新开始应使用明确的新 project/channel。移除仍被项目引用的 peer 会被拒绝。

### 3.4 从 0.1.0 升级

现有 config v1 可以继续读取，已有项目和发布序号不迁移、不重置。已有 Publisher source 与当前 Git root 唯一匹配时，可直接 `/sp status` / `/sp publish`。新增项目之前运行一次 `bootstrap`，选择复用原有 profile，即可登记设备身份、peer 和默认值，**不会重新生成原有密钥**。

0.2.0 的 CLI `secure-publish init` 是 `bootstrap` 的兼容别名，语义已收敛为设备初始化；项目注册使用 DSH 的 `/sp init` 或 Receiver 的 `profile add`。

磁盘仍使用 version 1 和原有 `projects` 字段，新增可选的 `device` 元数据。**读取兼容方向是 0.2.0 读取旧配置**；写入 device 后，0.1.0 会拒绝未知字段，不能直接用旧二进制回退。升级前请备份配置和状态；降级时不得回滚防重放状态。

默认配置位置仍是 `~/.config/dsh-secure-publish/config.json`。正常多项目使用无需编辑 JSON；[publisher.json](examples/publisher.json) / [receiver.json](examples/receiver.json) 保留为旧格式参考和高级恢复资料。

Linux/macOS/DSHA：配置、私钥 `600`，私有目录 `700`，位于源码和接收目录之外。Windows 用 NTFS ACL 限制为本人，本程序不能验证 Windows ACL。DSHA 私钥放 Ubuntu 私有目录，不放共享 `/sdcard`。

`/sp doctor` 检查本地配置和依赖，不代替真实中继验收。若终端在配置写入期间崩溃，先确认原进程已退出，再运行 `secure-publish config unlock`；活进程锁不能清除。

### Web 端发布与口令保护的签名私钥

Web 不询问或接收私钥口令。对于口令保护的 minisign 私钥：**在受信任终端执行 publish 预览和确认**。首版为清单和制品分别签名，可能询问两次口令。

无人值守、无口令的 minisign 密钥可以被 `/sp publish` 使用，但同 UID 的 agent Bash 也可能读取它。请先理解 [SECURITY.md](SECURITY.md)；不要为了省步骤把已有口令保护密钥解密存到项目中。若要阻止同 UID agent 接触私钥，需要独立系统用户/外部签名机等 OS 隔离，本版没有实现这种隔离。Workspace 初始化本身不签名，因此可复用口令保护密钥而不在 Web 索要口令。

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

Publisher 使用插件时，在当前 Workspace 输入 `/sp publish`，确认用 `/sp publish <摘要>`，无需重复 profile 名。Receiver 插件命令仍为 `/sp fetch laptop`、`/sp diff laptop`、`/sp apply laptop <摘要>`；独立 Windows 接收机通常直接使用上述 CLI。

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
