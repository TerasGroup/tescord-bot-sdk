# P4 / P5 本地验收

日期：2026-11-02。分支 `feat/openclaw-channel`。未提交、未推送、未发布。主仓库为相邻 `Tescord` 的 `feat/bot-integrations`。

| 项目                                                             | 命令                   | 结果                                   | 凭据                                                                                              |
| ---------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| SDK、插件及脚本/测试类型检查                                     | `pnpm typecheck`       | PASS                                   | [日志](../test-results/typecheck.log)                                                             |
| SDK / 插件 ESM + 声明构建                                        | `pnpm build`           | 2/2 package PASS                       | [日志](../build.log)                                                                              |
| REST/Gateway、触发、上下文、加密、流式、队列撤销、原生命令/owner | `pnpm test`            | 17 通过，0 失败                        | [日志](../test-results/vitest.log)                                                                |
| 共享协议归档 SHA256                                              | `pnpm verify:protocol` | PASS                                   | [日志](../test-results/protocol.log)、[协议锁](../vendor/protocol-lock.json)                      |
| 真实 OpenClaw CLI 发现/配置校验/加载                             | `pnpm smoke:openclaw`  | PASS，`status=loaded`、`imported=true` | [摘要](../test-results/openclaw-smoke.log)、[CLI 输出](../test-results/openclaw-cli.log)          |
| 真实 OpenClaw Gateway + Tescord 隔离后端                         | `pnpm smoke:backend`   | 6 通过，0 失败                         | [摘要](../test-results/backend-smoke.log)、[结果 JSON](../test-results/backend-smoke/result.json) |

真实 Gateway 冒烟覆盖：

1. 自动注册 OpenClaw 原生命令，五语言元数据完整；明文频道的 `whoami` 私密回复只到调用会话且历史为空。
2. E2EE 参数/私密回复在本地加解密，接收人仅 Bot 与调用者设备，历史为空。
3. 明文频道普通消息不触发，提及 Bot 后服务端 N 条历史进入真实 OpenClaw 上下文；本地模拟模型分段返回，最终正文通过编辑写回。
4. E2EE 频道同一触发/上下文/流式路径，最终消息可由调用者设备解密并具有递增 revision。
5. 独立 OpenClaw CLI 进程读取本地 Bot 设备，主动发起本公会成员加密 DM；调用者设备验证实际正文。
6. 重置 Token 后旧 Token 返回 401，旧 Gateway 退出，旧配置重启被拒绝。

原生命令阶段模型请求为 0；正文链路仅请求本机模拟模型 2 次；未传入真实供应商密钥，未请求付费模型。真实供应商生成、限额、工具执行及供应商重试行为未验收。

主仓库本轮凭据：`pnpm build` 4/4、`pnpm test:bot` 19/19、Bot/五语言 Playwright 17/17、Electron file:// 1/1、双 Prisma schema 和 50 份字典检查通过。见主仓库 `docs/bot-verification.md`。

## 限制和保留记录

- 上一轮主仓库全量 E2E 实际完成为 613 通过、23 失败。加密消息编辑已在本轮专项通过；没有再次执行全部 636 项，其他失败未逐项归因，不报告全仓库或生产验收通过。
- 缺少本机 Docker/psql 入口；PostgreSQL 实际迁移与生产备份/恢复待环境验收。
- 当前 Interaction 响应只支持文本，单条 4000 字符；私密附件明确拒绝。普通附件沿用主仓库现有明文内容及频道鉴权。
- 真实 OpenClaw 2026.10.9 的 CLI 已返回 `deliveryStatus=sent` 后仍保留活动句柄；冒烟校验回执和实际解密正文后终止该测试子进程。其 Gateway 日志保留了状态租约/首次会话接入重试信息；最终端到端断言通过，不据此宣称主机日志完全无错误。
- 首轮真实 Gateway 启动超过 45 秒，初始超时日志见 `test-results/backend-smoke-initial-timeout.log` 与 `test-results/backend-smoke/openclaw-initial-timeout.log`。后续使用 180 秒启动预算；其他冒烟脚本修正了 CLI 退出等待和 DM 分页结构断言，最终完整重跑通过。
- 所有测试数据库、OpenClaw 配置和进程均隔离；脚本关闭自身子进程并删除临时 OpenClaw 状态目录，SQLite 和日志留作证据。未操作业务数据库。
