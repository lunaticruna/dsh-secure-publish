# 验证记录

## 0.2.0：工作区初始化（2026-09-24）

- Linux x86_64，Node.js 24.19.0，真实 Git、age 1.1.1 / minisign 0.11。
- `REQUIRE_CRYPTO=1 npm test`：**37 项通过，0 失败、0 跳过**；包含原有 16 项协议测试与新增 21 项初始化/管理测试。
- `npm run check`、`git diff --check`、`npm pack --ignore-scripts` 通过。
- 使用真实 PTY 完成 Publisher bootstrap、口令保护 minisign 密钥生成、预览与确认；验证口令不回显，外部程序返回后的 readline 终端模式正常恢复。
- 测试公私钥、源码和配置均为临时生成，无生产凭据或实际业务中继。

| 新增验证范围 | 结果 |
| --- | --- |
| 旧 v1 bootstrap 复用密钥、peer、默认值，保留原 profile 与已有 pending/sequence | 通过 |
| 新 Receiver 可先生成身份、延后交换公钥，再用 CLI 添加项目 | 通过 |
| 模拟 DSH handler 从 `agent.session.header.cwd` 初始化，子目录绑定真实 Git root | 通过 |
| 5 个工作区复用信任，独立 profile / state / 发布计数 | 通过 |
| 缺失/相对/非 Git/符号链接 cwd，以及相似名称含尾空格的根目录 | 拒绝无效上下文；有效根目录不会串用 |
| 跨工作区显式 Publisher profile、聊天覆盖 source/target/relay/config | 拒绝 |
| cwd、Git index、配置、密钥变化；过期/篡改确认记录；并发旧预览 | 拒绝旧确认 |
| include/exclude 明确预览，危险路径不作为建议选入；age recipient 校验和 | 通过 / 错误值拒绝 |
| Receiver add/clone/list/show/remove；克隆不复制 highwater、staged、pending | 通过 |
| 新 target/source/key/state 冲突、重复绑定、旧 state namespace / 退役绑定复用 | 拒绝；配置保持完整 |
| peer 默认值只影响未来项目，移除正在使用的 peer | 拒绝隐式信任变更 |
| 配置修改前取消、Git fsmonitor 不执行、含空格参数解析 | 通过 |

GitHub CI 对提交运行 Node 22 下的包检查、同一套真实加密测试和打包；远程结果见 [Actions](https://github.com/lunaticruna/dsh-secure-publish/actions)。

## 0.1.0：初始发布（2026-09-23）

- Linux x86_64，Node.js 24.19.0，Git 2.51.1。
- Ubuntu 官方发行包中的 age 1.1.1（含 age-keygen）、minisign 0.11；调用真实命令，没有使用假加密。
- `npm run check`：入口、bundle manifest、JavaScript 语法及无 npm 生产依赖检查通过。
- `REQUIRE_CRYPTO=1 npm test`：**16 项通过，0 失败、0 跳过**。
- GitHub Actions 首次远程验收通过：[运行 #1](https://github.com/lunaticruna/dsh-secure-publish/actions/runs/35876081376)，对应源码提交 `9c1c6ff7fc3061b30f0644e61616d065c344891c`。环境为 Ubuntu 24.04.5、Node.js 22.23.2、Git 2.55.0、发行包 age 1.1.1 / minisign 0.11；包检查、全部 16 项测试（0 失败、0 跳过）及 `npm pack --ignore-scripts` 均成功。

| 验证范围 | 结果 |
| --- | --- |
| 真实 age/minisign 密钥、完整 Publish → Fetch → Diff → Apply | 通过 |
| 预览不上传、确认后才上传密文 | 通过 |
| 真实本地裸 Git 中继、不可变序号、跨项目共存、旧序号缺口保护 | 通过 |
| 密文损坏、错误接收者、清单/制品篡改、错误发布者公钥 | 拒绝 |
| 有效签名但 project/channel/repository/branch 不匹配 | 拒绝 |
| 相同密文重复 Fetch | 允许重试 |
| 同序号不同密文、旧序号、低于 trust floor | 拒绝 |
| 本地回滚后仍拒绝旧网络制品 | 通过 |
| 路径穿越、Windows 设备名/ADS、大小写及文件/目录冲突 | 拒绝 |
| 未提交文件、软链接、常见敏感文件名、LFS pointer | 拒绝 |
| 白名单外的已提交文件 | 不进入制品 |
| Diff 后目录变化、staging 篡改、接收端源码被修改 | 拒绝旧确认或拒绝应用 |
| 配置变化、POSIX 配置权限过宽 | 拒绝 |
| 活进程锁、无所有权标记的现有目录 | 拒绝 |
| 原目录移走后/候选安装后中断、重复应用同版本前中断 | 可恢复 |
| `/sp` 人工命令注册、帮助结果 | 模拟宿主契约检查通过 |

测试使用随机临时密钥和临时源码仓库，结束后清理。测试包装器将固定 GitHub URL 改向本地 Git 仓库；file 协议开放仅存在于测试代码，生产配置没有这个开关。

## 尚未执行

- DSH 完整宿主与 DSHA Android 真机/模拟器加载验收。
- Windows/macOS 原生加密、ACL、文件锁、目录替换验收。
- 使用真实 GitHub 凭据对业务密文中继 push/fetch；已通过的 CI 集成测试仍使用本地裸 Git 中继。
- OS 断电、存储故障注入；进程中断测试不等于所有文件系统的断电耐久性保证。
- 外部安全审计、超大规模压力测试，以及 Android / Windows 原生配置向导的人机验收；上述 Linux PTY 检查不等同于真机验收。

DSH/DSHA 兼容结论来自上游 API/包格式源码核对和本地契约测试，不能等同于真机实测。初次部署请先用非敏感小项目完成交付及回滚。
